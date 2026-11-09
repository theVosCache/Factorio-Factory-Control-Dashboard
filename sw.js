// Factory Control service worker: lets the installed app start without the network and
// pick a server. Live data (API, events, icons) always goes to the network.
const SHELL = 'fc-shell-v12';
const FONTS = 'fc-fonts-v1';
const FILES = ['./', 'index.html', 'app.css', 'app.js', 'manifest.webmanifest', 'shared/protocol.js', 'vendor/jsQR.js',
  'transports/index.js', 'transports/rtc.js', 'transports/ipc.js',
  'pwa/icon-192.png', 'pwa/icon-512.png', 'pwa/favicon-32.png'];

self.addEventListener('install', (ev) => {
  ev.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== FONTS).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    // Fonts: cache first, they never change for a given URL.
    ev.respondWith(caches.open(FONTS).then(async (c) => (await c.match(req)) || fetch(req).then((res) => {
      if (res.ok || res.type === 'opaque') c.put(req, res.clone());
      return res;
    })));
    return;
  }
  if (url.origin !== location.origin || url.pathname.includes('/api/') || url.pathname.includes('/icons/')) return;
  // App shell: network first so updates show up right away, cache when offline.
  ev.respondWith(fetch(req).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))));
});
