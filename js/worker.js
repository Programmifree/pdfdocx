// Web Worker di conversione: carica Pyodide + PyMuPDF/pdf2docx (via @bentopdf/pymupdf-wasm)
// e converte i PDF in DOCX, così la pagina resta reattiva durante l'elaborazione.

import { PyMuPDF } from '../vendor/pymupdf-wasm/index.js';

// Cartella con il runtime Pyodide/WASM e i wheel Python (servita dallo stesso sito).
const ASSET_URL = new URL('../vendor/pymupdf/', import.meta.url).href;

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// Pulizia post-conversione (Python, stdlib): pdf2docx lascia spesso in coda al
// documento paragrafi "invisibili" — vuoti o con testo bianco (tipicamente i
// piè di pagina con testo bianco su banda colorata del PDF) — che occupano
// righe e possono aggiungere una pagina/quasi-pagina bianca alla fine.
// Rimuove dall'ultimo paragrafo all'indietro solo quelli invisibili:
// si ferma al primo paragrafo con contenuto visibile, immagini o sezione.
const CLEANUP_PY = String.raw`
import io, re, zipfile

path = '/output.docx'
with zipfile.ZipFile(path) as z:
    infos = z.infolist()
    entries = {i.filename: z.read(i.filename) for i in infos}

xml = entries['word/document.xml'].decode('utf-8')
body_m = re.search(r'<w:body>(.*)</w:body>', xml, re.S)
body = body_m.group(1)


def run_visible(rp, t):
    if t.strip():
        c = re.search(r'<w:color w:val="([0-9A-Fa-f]{6})"', rp or '')
        return not (c and c.group(1).upper() == 'FFFFFF')
    return False


removed = 0
while True:
    # Non toccare paragrafi dentro l'ultima tabella.
    if body.rfind('<w:tbl>') > body.rfind('</w:tbl>'):
        break
    # Ultimo paragrafo del body: i paragrafi non si annidano, quindi il suo
    # tag di apertura è l'ultimo '<w:p' prima dell'ultimo '</w:p>'.
    close = body.rfind('</w:p>')
    if close < 0:
        break
    start = max(
        body.rfind('<w:p>', 0, close),
        body.rfind('<w:p ', 0, close),
        body.rfind('<w:p\t', 0, close),
        body.rfind('<w:p\n', 0, close),
    )
    if start < 0:
        break
    p = body[start:close + 6]
    if '<w:sectPr' in p:
        break
    if '<w:drawing' in p or '<w:pict' in p or '<w:object' in p:
        break
    runs = re.findall(r'(<w:rPr\b.*?</w:rPr>)?\s*<w:t\b[^>]*>(.*?)</w:t>', p, re.S)
    if any(run_visible(rp, t) for rp, t in runs):
        break
    body = body[:start] + body[close + 6:]
    removed += 1

# 2) Paragrafi portatori di sezione (vuoti, contengono solo sectPr): occupano
#    una riga e se la pagina precedente è piena traboccano da soli su una
#    pagina, creando una pagina bianca a metà documento. Li si riduce a altezza
#    quasi zero (font 1pt, interlinea esatta minima) così restano in fondo alla
#    pagina precedente senza alterare la paginazione voluta da pdf2docx.
shrunk = 0
SPACING = '<w:spacing w:before="0" w:after="0" w:line="14" w:lineRule="exact"/>'
RPR = '<w:rPr><w:sz w:val="2"/><w:szCs w:val="2"/></w:rPr>'


def shrink_carrier(m):
    global shrunk
    p = m.group(0)
    if '<w:sectPr' not in p:
        return p
    if '<w:t>' in p or '<w:t ' in p:
        return p
    if '<w:drawing' in p or '<w:pict' in p or '<w:object' in p:
        return p
    ppm = re.search(r'<w:pPr\b[^>]*>(.*?)</w:pPr>', p, re.S)
    if not ppm:
        return p
    inner = ppm.group(1)
    inner = re.sub(r'<w:spacing\b[^>]*/>', '', inner)
    inner = re.sub(r'<w:rPr\b.*?</w:rPr>', '', inner, flags=re.S)
    if '<w:sectPr' not in inner:
        return p
    # spacing prima di ind/jc/sectPr (ordine dello schema OOXML), rPr subito prima di sectPr
    first = len(inner)
    for token in ('<w:ind', '<w:jc', '<w:sectPr'):
        pos = inner.find(token)
        if pos != -1:
            first = min(first, pos)
    inner = inner[:first] + SPACING + inner[first:]
    inner = inner.replace('<w:sectPr', RPR + '<w:sectPr', 1)
    shrunk += 1
    return p[:ppm.start(1)] + inner + p[ppm.end(1):]


body = re.sub(r'<w:p\b[^>]*>.*?</w:p>', shrink_carrier, body, flags=re.S)

# 3) Adattamento "1 pagina PDF = 1 pagina DOCX": ogni pagina del PDF diventa
#    una sezione DOCX; se il contenuto ricalcolato sfora anche di poco, la
#    riga in eccesso finisce da sola sulla pagina successiva, che il salto di
#    sezione lascia vuota per il resto. Si recupera spazio verticale in modo
#    poco invasivo, per ogni sezione:
#    - azzera lo spazio "prima" del primo paragrafo e "dopo" l'ultimo (gap ai
#      confini di pagina, visivamente trascurabile);
#    - porta i margini superiore/inferiore a ~1 mm.
#    Così uno sforo di poche righe rientra nella propria pagina.
MARGIN_FLOOR = '60'
adjusted = 0


def _set_spacing(p, attr, val):
    """Imposta w:attr=val nel tag <w:spacing> del pPr di p (lo crea se assente)."""
    ppm = re.search(r'<w:pPr\b[^>]*>(.*?)</w:pPr>', p, re.S)
    if not ppm:
        open_end = p.find('>') + 1
        return p[:open_end] + '<w:pPr><w:spacing w:' + attr + '="' + val + '"/></w:pPr>' + p[open_end:]
    inner = ppm.group(1)
    sm = re.search(r'<w:spacing\b[^>]*/>', inner)
    if sm:
        tag = sm.group(0)
        if ('w:' + attr + '="') in tag:
            tag2 = re.sub('w:' + attr + '="[^"]*"', 'w:' + attr + '="' + val + '"', tag)
        else:
            tag2 = tag[:-2] + ' w:' + attr + '="' + val + '"/>'
        inner2 = inner[:sm.start()] + tag2 + inner[sm.end():]
    else:
        first = len(inner)
        for token in ('<w:ind', '<w:jc', '<w:rPr', '<w:sectPr'):
            pos = inner.find(token)
            if pos != -1:
                first = min(first, pos)
        inner2 = inner[:first] + '<w:spacing w:' + attr + '="' + val + '"/>' + inner[first:]
    return p[:ppm.start(1)] + inner2 + p[ppm.end(1):]


def section_bounds(b):
    """Span [inizio, fine) del contenuto di ogni sezione (il carrier con
    sectPr è fuori). Va ricalcolato dopo ogni modifica che cambia la
    lunghezza del body, altrimenti le posizioni slittano."""
    carriers = [m.span() for m in re.finditer(
        r'<w:p\b[^>]*>(?:(?!</w:p>).)*?<w:sectPr(?:(?!</w:p>).)*?</w:p>', b, re.S)]
    fs = b.rfind('<w:sectPr')
    bs = []
    prevb = 0
    for s, e in carriers:
        bs.append((prevb, s))
        prevb = e
    bs.append((prevb, fs if fs != -1 else len(b)))
    return bs


for sec_i in range(len(section_bounds(body))):
    bnds = section_bounds(body)
    if sec_i >= len(bnds):
        break
    sec_start, sec_end = bnds[sec_i]
    if sec_end - sec_start < 20:
        continue
    # Primo paragrafo della sezione: spazio "prima" a zero.
    seg = body[sec_start:sec_end]
    ls = seg.lstrip()
    if ls.startswith('<w:p>') or ls.startswith('<w:p ') or ls.startswith('<w:p/'):
        pend = seg.find('</w:p>')
        if pend != -1:
            fp = seg[:pend + 6]
            fp2 = _set_spacing(fp, 'before', '0')
            if fp2 != fp:
                delta = len(fp2) - len(fp)
                body = body[:sec_start] + fp2 + body[sec_start + len(fp):]
                sec_end += delta
                adjusted += 1
    # Ultimo paragrafo della sezione (solo se top-level, fuori da tabelle):
    # spazio "dopo" a zero.
    close = body.rfind('</w:p>', sec_start, sec_end)
    if close != -1:
        start = max(body.rfind('<w:p>', sec_start, close),
                    body.rfind('<w:p ', sec_start, close))
        if start != -1 and start >= sec_start and body.find('<w:tbl>', sec_start, start) == -1:
            lp = body[start:close + 6]
            if ('<w:sectPr' not in lp and '<w:drawing' not in lp
                    and '<w:pict' not in lp):
                lp2 = _set_spacing(lp, 'after', '0')
                if lp2 != lp:
                    body = body[:start] + lp2 + body[start + len(lp):]
                    adjusted += 1


def shrink_mar(m):
    tag = m.group(0)
    for attr in ('top', 'bottom'):
        am = re.search('w:' + attr + '="(\\d+)"', tag)
        if am and int(am.group(1)) > int(MARGIN_FLOOR):
            tag = tag.replace(am.group(0), 'w:' + attr + '="' + MARGIN_FLOOR + '"', 1)
    return tag


body, margins = re.subn(r'<w:pgMar\b[^>]*/>', shrink_mar, body)

# 4) Tappo sui gap verticali grandi: pdf2docx posiziona footer e note a fondo
#    pagina con spaziature enormi (anche 2 cm e più) prima/dopo il blocco.
#    Con i margini ridotti questi gap spingono il footer oltre il fondo pagina
#    e lo fanno sforare. I gap oltre GAP_CAP (~1 cm) vengono ridotti al tappo:
#    il footer/nota si solleva di poco e rientra nella propria pagina. I gap
#    normali tra i blocchi (quasi sempre < 600 twips) restano invariati.
GAP_CAP = '600'


def cap_gaps(m):
    tag = m.group(0)
    for attr in ('before', 'after'):
        am = re.search('w:' + attr + '="(\\d+)"', tag)
        if am and int(am.group(1)) > int(GAP_CAP):
            tag = tag.replace(am.group(0), 'w:' + attr + '="' + GAP_CAP + '"', 1)
    return tag


body, capped = re.subn(r'<w:spacing\b[^>]*/>', cap_gaps, body)

# 5) Righe di footer a fine sezione: pdf2docx emette la riga di fondo pagina
#    (testo + eventuale numero di pagina dopo un tab) come ULTIMO paragrafo
#    della sezione — posizione corretta, perché nel PDF originale sta in
#    fondo alla pagina. Il problema e' solo che arriva con uno spacing
#    "prima" enorme (posizionamento artificiale, gia' ridotto dal tappo del
#    passo 4 ma ancora troppo) e con un tab stop oltre il margine che manda
#    la riga a capo: in una pagina piena sfora da sola creando una pagina
#    quasi bianca. La si lascia dov'e' (in fondo, fedele al PDF) e la si
#    normalizza: spaziature a zero e tab stop limitato alla larghezza utile,
#    cosi' resta una riga singola e ci sta nello spazio residuo.
moved = 0


def clamp_tab_positions(p, limit):
    def cl(m):
        tag = m.group(0)
        pos = m.group(1)
        if int(pos) > limit:
            tag = tag.replace('w:pos="' + pos + '"', 'w:pos="' + str(limit) + '"', 1)
        return tag
    return re.sub(r'<w:tab\b[^>]*w:pos="(\d+)"[^>]*/>', cl, p)


for sec_i5 in range(len(section_bounds(body))):
    bnds5 = section_bounds(body)
    if sec_i5 >= len(bnds5):
        break
    sec_start, sec_end = bnds5[sec_i5]
    if sec_end - sec_start < 40:
        continue
    close = body.rfind('</w:p>', sec_start, sec_end)
    if close == -1:
        continue
    start = max(
        body.rfind('<w:p>', sec_start, close),
        body.rfind('<w:p ', sec_start, close),
        body.rfind('<w:p\t', sec_start, close),
        body.rfind('<w:p\n', sec_start, close),
    )
    if start <= sec_start or start == -1:
        continue
    # Solo paragrafi top-level: blocca solo se una tabella è ancora aperta.
    if body.rfind('<w:tbl>', sec_start, start) > body.rfind('</w:tbl>', sec_start, start):
        continue
    lp = body[start:close + 6]
    if ('<w:sectPr' in lp or '<w:drawing' in lp or '<w:pict' in lp
            or '<w:object' in lp):
        continue
    text = ''.join(re.findall(r'<w:t\b[^>]*>(.*?)</w:t>', lp, re.S)).strip()
    tab_pos = [int(v) for v in re.findall(r'<w:tab\b[^>]*w:pos="(\d+)"', lp)]
    # Deve essere una riga breve "di servizio" con un tab stop verso destra.
    if not text or len(text) > 120 or not tab_pos:
        continue
    sect_i = body.find('<w:sectPr', sec_end)
    if sect_i == -1:
        continue
    geo = body[sect_i:sect_i + 1500]
    szm = re.search(r'<w:pgSz\b[^>]*w:w="(\d+)"', geo)
    marm = re.search(r'<w:pgMar\b[^>]*/>', geo)
    if not szm or not marm:
        continue
    lm = re.search(r'w:left="(\d+)"', marm.group(0))
    rm = re.search(r'w:right="(\d+)"', marm.group(0))
    text_w = (int(szm.group(1)) - (int(lm.group(1)) if lm else 0)
              - (int(rm.group(1)) if rm else 0))
    if text_w < 2000 or max(tab_pos) < int(text_w * 0.6):
        continue
    indm = re.search(r'<w:ind\b[^>]*w:(?:left|start)="(\d+)"', lp)
    limit = max(300, text_w - (int(indm.group(1)) if indm else 0) - 240)
    lp2 = _set_spacing(lp, 'before', '0')
    lp2 = _set_spacing(lp2, 'after', '0')
    lp2 = clamp_tab_positions(lp2, limit)
    body = body[:start] + lp2 + body[start + len(lp):]
    moved += 1

xml = xml[: body_m.start(1)] + body + xml[body_m.end(1):]
entries['word/document.xml'] = xml.encode('utf-8')

out = io.BytesIO()
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for info in infos:
        z.writestr(info, entries[info.filename])
open(path, 'wb').write(out.getvalue())
import json
json.dumps({'removed': removed, 'shrunk': shrunk, 'adjusted': adjusted, 'margins': margins, 'capped': capped, 'moved': moved})
`;

// Messaggi di errore in italiano.
const ERRORS = {
  password: 'PDF protetto da password: i documenti cifrati non sono supportati.',
  scanned: 'PDF scansionato senza testo: serve l\'OCR, non incluso.',
  invalid: 'file non valido: non è un PDF leggibile.',
  failed: 'la conversione non è riuscita. Il PDF potrebbe avere una struttura non supportata.',
};

class ConversionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConversionError';
  }
}

// Il motore viene caricato una sola volta, alla prima conversione.
let enginePromise = null;

function getEngine() {
  if (!enginePromise) {
    enginePromise = (async () => {
      self.postMessage({ type: 'engine-status', phase: 'downloading' });
      const pymupdf = new PyMuPDF({ assetPath: ASSET_URL });
      await pymupdf.load();
      self.postMessage({ type: 'engine-status', phase: 'ready' });
      return pymupdf;
    })();
  }
  return enginePromise;
}

// Controlli preliminari sul documento: password e presenza di testo.
async function checkDocument(pymupdf, file) {
  let doc;
  try {
    doc = await pymupdf.open(file);
  } catch {
    throw new ConversionError(ERRORS.invalid);
  }

  try {
    if (doc.needsPass) {
      throw new ConversionError(ERRORS.password);
    }

    // Se nessuna pagina contiene testo, è quasi certamente un PDF scansionato.
    let textLength = 0;
    for (const page of doc.pages()) {
      textLength += page.getText().trim().length;
      if (textLength > 0) break;
    }
    if (textLength === 0) {
      throw new ConversionError(ERRORS.scanned);
    }
  } finally {
    doc.close();
  }
}

// Post-processing del DOCX generato: esegue la pulizia Python su /output.docx
// e restituisce il blob aggiornato. In caso di errore usa il blob originale
// (la conversione non deve fallire per un problema di pulizia).
async function postProcess(engine, blob) {
  let pyodide;
  try {
    pyodide = await engine.getPyodide();
    pyodide.FS.writeFile('/output.docx', new Uint8Array(await blob.arrayBuffer()));
    const stats = JSON.parse(pyodide.runPython(CLEANUP_PY));
    if (!stats.removed && !stats.shrunk && !stats.adjusted && !stats.capped
        && !stats.moved) return blob;
    const data = pyodide.FS.readFile('/output.docx');
    const cleaned = new Blob([data], { type: DOCX_MIME });
    return cleaned.size > 0 ? cleaned : blob;
  } catch {
    return blob;
  } finally {
    if (pyodide) {
      try { pyodide.FS.unlink('/output.docx'); } catch { /* già assente */ }
    }
  }
}

// Converte un singolo file e risponde al thread principale.
async function convert(id, file) {
  try {
    const pymupdf = await getEngine();
    await checkDocument(pymupdf, file);

    const docxBlob = await pymupdf.pdfToDocx(file);
    if (!docxBlob || docxBlob.size === 0) {
      throw new ConversionError(ERRORS.failed);
    }

    const blob = await postProcess(pymupdf, docxBlob);
    self.postMessage({ type: 'result', id, ok: true, blob });
  } catch (err) {
    const message = err instanceof ConversionError ? err.message : ERRORS.failed;
    self.postMessage({ type: 'result', id, ok: false, message });
  }
}

self.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg && msg.type === 'convert') {
    convert(msg.id, msg.file);
  }
});
