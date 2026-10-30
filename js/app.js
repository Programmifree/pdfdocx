// App principale: gestisce l'interfaccia, la coda di conversione e la registrazione
// del Service Worker. La conversione vera e propria avviene in js/worker.js.

const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('file-input');
const fileList = document.getElementById('file-list');
const engineMessage = document.getElementById('engine-message');

// Etichette di stato mostrate all'utente.
const STATUS_LABELS = {
  pending: 'In attesa',
  converting: 'Conversione…',
  done: 'Fatto',
  error: 'Errore',
};

const jobs = [];   // tutti i job inseriti, in ordine
const queue = [];  // id dei job in attesa di conversione
let converting = false;
let nextId = 1;

// --- Aggiunta file -----------------------------------------------------------

function addFiles(files) {
  for (const file of files) {
    const job = {
      id: nextId++,
      file,
      name: file.name,
      size: file.size,
      status: 'pending',
      url: null,
      message: '',
    };
    // Controllo minimo: estensione .pdf o tipo MIME corretto.
    const isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
    if (!isPdf) {
      job.status = 'error';
      job.message = 'il file selezionato non è un PDF valido.';
    } else {
      queue.push(job.id);
    }
    jobs.push(job);
  }
  render();
  pump();
}

// --- Coda di conversione (un file alla volta) --------------------------------

function pump() {
  if (converting) return;
  const id = queue.shift();
  if (id === undefined) return;

  converting = true;
  const job = jobs.find((j) => j.id === id);
  job.status = 'converting';
  render();
  worker.postMessage({ type: 'convert', id, file: job.file });
}

// --- Messaggi dal worker ------------------------------------------------------

worker.addEventListener('message', (event) => {
  const msg = event.data;

  // Il worker sta scaricando il motore di conversione (solo al primo utilizzo).
  if (msg.type === 'engine-status') {
    engineMessage.hidden = msg.phase !== 'downloading';
    return;
  }

  if (msg.type === 'result') {
    const job = jobs.find((j) => j.id === msg.id);
    converting = false;
    if (msg.ok) {
      job.status = 'done';
      job.url = URL.createObjectURL(msg.blob);
    } else {
      job.status = 'error';
      job.message = msg.message;
    }
    render();
    pump();
  }
});

// --- Rendering della lista ----------------------------------------------------

const numberFormat = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 1 });

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${numberFormat.format(bytes / 1024)} kB`;
  return `${numberFormat.format(bytes / (1024 * 1024))} MB`;
}

function render() {
  fileList.replaceChildren(...jobs.map(renderItem));
}

function renderItem(job) {
  const li = document.createElement('li');
  li.className = 'file-item';
  if (job.status === 'error') li.classList.add('is-error');
  if (job.status === 'done') li.classList.add('is-done');

  const info = document.createElement('div');
  info.className = 'file-info';

  const name = document.createElement('span');
  name.className = 'file-name';
  name.textContent = job.name;

  const meta = document.createElement('span');
  meta.className = 'file-meta';
  meta.textContent = formatSize(job.size);

  info.append(name, meta);

  const status = document.createElement('span');
  status.className = `file-status st-${job.status}`;
  status.textContent = job.status === 'error' && job.message
    ? `${STATUS_LABELS.error} — ${job.message}`
    : STATUS_LABELS[job.status];

  li.append(info, status);

  // Pulsante di download, disponibile solo quando il job è completato.
  if (job.status === 'done' && job.url) {
    const link = document.createElement('a');
    link.className = 'btn-download';
    link.href = job.url;
    link.download = job.name.replace(/\.pdf$/i, '') + '.docx';
    link.textContent = 'Scarica DOCX';
    li.append(link);
  }

  return li;
}

// --- Drag & drop e selezione file ---------------------------------------------

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fileInput.click();
  }
});

fileInput.addEventListener('change', () => {
  addFiles(fileInput.files);
  fileInput.value = '';
});

dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('is-dragover');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('is-dragover'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('is-dragover');
  addFiles(e.dataTransfer.files);
});

// Evita che un rilascio fuori dall'area apra il file nel browser.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// --- Finestra modale "Come funziona" -------------------------------------------

const infoDialog = document.getElementById('info-dialog');
const btnInfo = document.getElementById('btn-info');

if (btnInfo && infoDialog) {
  btnInfo.addEventListener('click', () => infoDialog.showModal());
  document.getElementById('info-close')
    ?.addEventListener('click', () => infoDialog.close());
  // Chiude anche cliccando sul velo scuro fuori dalla finestra.
  infoDialog.addEventListener('click', (e) => {
    if (e.target === infoDialog) infoDialog.close();
  });
}

// --- Service Worker -----------------------------------------------------------
// Il Service Worker funziona solo in contesti sicuri: HTTPS o localhost.

if ('serviceWorker' in navigator &&
    (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
  navigator.serviceWorker.register('./sw.js');
}
