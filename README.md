# Programmifree PDF → DOCX

Converti i tuoi PDF in documenti Word (DOCX) direttamente nel browser, gratuitamente e senza caricare i file su un server.

**Apri l'app:** https://www.programmifree.com/web/app/pdfdocx/

La conversione avviene interamente sul dispositivo dell'utente, grazie a motori open source compilati in WebAssembly.

## Caratteristiche

- **Privacy**: i PDF non vengono caricati sui server di Programmifree.
- **Nessuna registrazione**: gratuita, senza account.
- **Più file**: puoi selezionare più PDF; vengono convertiti uno alla volta.
- **Uso offline**: dopo il primo caricamento dei componenti (alcune decine di MB), l'app può funzionare anche senza connessione, se il browser conserva la cache.

## Come si usa

1. Apri l'app.
2. Trascina uno o più PDF nell'area indicata oppure clicca per selezionarli.
3. Attendi la conversione (la prima volta serve scaricare il motore).
4. Scarica il file DOCX.

## Limiti e precauzioni

- I PDF protetti da password non sono supportati.
- I PDF scansionati (solo immagini) non vengono riconosciuti: l'OCR non è incluso.
- La conversione può alterare l'impaginazione, soprattutto con layout complessi (colonne multiple, grafica editoriale). Conserva sempre l'originale e controlla il risultato.
- Le prestazioni dipendono dal browser, dalla memoria disponibile e dalla dimensione del PDF.
- Il software è fornito «così com'è», senza garanzie di alcun tipo.

## Come funziona

- Interfaccia in HTML, CSS e JavaScript.
- La conversione gira in un Web Worker, per non bloccare la pagina.
- Il motore è [pdf2docx](https://github.com/ArtifexSoftware/pdf2docx) con PyMuPDF, eseguito su [Pyodide](https://pyodide.org) tramite il pacchetto `@bentopdf/pymupdf-wasm` (versione [X.Y.Z]).
- Un Service Worker conserva in cache i componenti per le visite successive e l'uso offline.

## Provarla in locale

Il Service Worker richiede `localhost` o HTTPS. Dalla cartella del progetto:
