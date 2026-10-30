// Service Worker:
// - precache della shell dell'app (interfaccia e codice dell'app);
// - CacheFirst per il runtime Pyodide/WASM/wheel (scaricato alla prima conversione),
//   così le visite successive e l'uso offline partono subito.
// - Aggiunge gli header COOP/COEP necessari per SharedArrayBuffer e Pyodide.

const VERSION = 'v14';
const SHELL_CACHE = `pdf2docx-shell-${VERSION}`;
const RUNTIME_CACHE = `pdf2docx-runtime-${VERSION}`;

// File essenziali dell'interfaccia, messi in cache all'installazione.
// I percorsi sono relativi allo scope del SW (radice del sito).
const SHELL_FILES = [
  './',
  './index.htm',
  './css/style.css',
  './css/fonts/fraunces-latin.woff2',
  './css/fonts/instrument-sans-latin.woff2',
  './js/app.js',
  './js/worker.js',
  './vendor/pymupdf-wasm/index.js',
];

// Il runtime pesante (Pyodide, WASM, wheel Python) vive sotto questo prefisso.
// Nota: il pathname inizia sempre con '/' quindi usiamo startsWith sul pathname.
const RUNTIME_SEGMENT = 'vendor/pymupdf/';

// Header richiesti da Pyodide/SharedArrayBuffer (cross-origin isolation).
// Vengono iniettati su tutte le risposte navigate e sulle risorse della shell.
function addIsolationHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key !== SHELL_CACHE && key !== RUNTIME_CACHE)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

// CacheFirst: usa la cache se presente, altrimenti scarica e memorizza.
async function cacheFirst(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);
  if (cached) return addIsolationHeaders(cached);

  const response = await fetch(request);
  if (response && response.ok) {
    cache.put(request, response.clone());
  }
  return response ? addIsolationHeaders(response) : response;
}

// Rete prima, cache come riserva: mantiene la shell aggiornata e funziona offline.
async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    // Aggiorna la copia offline della pagina principale.
    if (request.mode === 'navigate' && response.ok) {
      cache.put(new Request('./index.htm'), response.clone());
    }
    return addIsolationHeaders(response);
  } catch {
    const fallback =
      (await cache.match(request)) ||
      (await cache.match('./index.htm')) ||
      (await cache.match('./'));
    return fallback ? addIsolationHeaders(fallback) : new Response('Offline', { status: 503 });
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Rimozione dello slash iniziale per ottenere il path relativo
  const relPath = url.pathname.replace(/^\//, '');

  if (relPath.startsWith(RUNTIME_SEGMENT)) {
    event.respondWith(cacheFirst(request));
    return;
  }
  event.respondWith(networkFirst(request));
});
