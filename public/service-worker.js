/* eslint-env serviceworker */
/**
 * Service Worker do MusicGPT (clone).
 *
 * Estratégia:
 *  - App shell (HTML/CSS/JS/ícones): cache-first, com revalidação em segundo
 *    plano -> o app abre instantaneamente e funciona sem rede.
 *  - Navegação: network-first com fallback para o index em cache.
 *  - API de leitura (biblioteca, playlists, perfil, config): stale-while-revalidate
 *    -> mostra o último estado conhecido e atualiza em segundo plano.
 *  - Áudio MP3: cache opportunista (limitado) para tocar faixas já geradas
 *    sem rede. WAV/download nunca é cacheado (arquivos grandes, baixa vez).
 */

const VERSION = 'v2';
const SHELL_CACHE = `musicgpt-shell-${VERSION}`;
const DATA_CACHE = `musicgpt-data-${VERSION}`;
const AUDIO_CACHE = `musicgpt-audio-${VERSION}`;

const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/manifest.json',
  '/icons/icon-32.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
];

const DATA_ROUTES = ['/api/config', '/api/tracks', '/api/playlists', '/api/profile', '/api/explore'];
const MAX_AUDIO_ENTRIES = 24;

/* ------------------------------------------------------------------ *
 * Ciclo de vida
 * ------------------------------------------------------------------ */

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // addAll falha inteiro se um item falhar: adiciona um a um
    await Promise.all(SHELL_ASSETS.map(async (url) => {
      try {
        await cache.add(new Request(url, { cache: 'reload' }));
      } catch (err) {
        console.warn('[sw] falhou ao pré-cachear', url, err);
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((n) => n.startsWith('musicgpt-') && ![SHELL_CACHE, DATA_CACHE, AUDIO_CACHE].includes(n))
      .map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
  if (event.data === 'CLEAR_AUDIO_CACHE') {
    event.waitUntil(caches.delete(AUDIO_CACHE));
  }
});

/* ------------------------------------------------------------------ *
 * Fetch
 * ------------------------------------------------------------------ */

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) {
    // revalida em segundo plano
    fetch(request).then((res) => {
      if (res && res.ok) cache.put(request, res.clone());
    }).catch(() => {});
    return cached;
  }
  const res = await fetch(request);
  if (res && res.ok) cache.put(request, res.clone());
  return res;
}

async function networkFirst(request, fallbackUrl) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetch(request);
    if (res && res.ok) cache.put(fallbackUrl || request, res.clone());
    return res;
  } catch (err) {
    const cached = await cache.match(fallbackUrl || request);
    if (cached) return cached;
    return new Response('<h1>Offline</h1><p>Sem conexão e sem cópia em cache.</p>', {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(DATA_CACHE);
  const cached = await cache.match(request);
  const network = fetch(request).then((res) => {
    if (res && res.ok) cache.put(request, res.clone());
    return res;
  }).catch(() => null);
  if (cached) {
    network.catch(() => {});
    return cached;
  }
  const res = await network;
  if (res) return res;
  return new Response(JSON.stringify({ error: 'Sem conexão: dados indisponíveis offline.' }), {
    status: 503,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/** Cache oportunista do MP3 (para tocar offline), com limite de entradas. */
async function cacheAudio(request, response) {
  try {
    const cache = await caches.open(AUDIO_CACHE);
    await cache.put(request, response.clone());
    const keys = await cache.keys();
    if (keys.length > MAX_AUDIO_ENTRIES) {
      const stale = keys.slice(0, keys.length - MAX_AUDIO_ENTRIES);
      await Promise.all(stale.map((k) => cache.delete(k)));
    }
  } catch (err) {
    /* sem espaço em cache: ignora */
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // navegação -> rede primeiro, depois o index em cache
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, '/index.html'));
    return;
  }

  // API de leitura -> stale-while-revalidate
  if (url.pathname.startsWith('/api/')) {
    const isDataRoute = DATA_ROUTES.includes(url.pathname);
    if (isDataRoute) {
      event.respondWith(staleWhileRevalidate(request));
      return;
    }
    // audio em MP3: cache oportunista; WAV/download nunca
    if (url.pathname.endsWith('/audio') && url.searchParams.get('format') === 'mp3') {
      event.respondWith((async () => {
        const cached = await caches.open(AUDIO_CACHE).then((c) => c.match(request));
        if (cached) return cached;
        const res = await fetch(request);
        if (!res || !res.ok) return res;
        return cacheAudio(request, res);
      })());
      return;
    }
    return; // demais rotas (/api/generate, /api/download, ...) vão direto à rede
  }

  // demais estáticos -> rede primeiro, cache como reserva (offline).
  // network-first garante que uma atualização do app chegue na hora; o cache
  // cobre o caso sem rede.
  event.respondWith(networkFirst(request, request));
});
