/* Service worker do Opus Scala.
   Arquivos do app: abre na hora a partir do cache e atualiza em segundo plano
   (a versão nova aparece na abertura seguinte). Supabase e fontes vão direto à rede.
   Para forçar atualização imediata nos celulares, troque o nome do cache (v10 -> v11). */
const CACHE = 'plantao-uti-v10';
const SHELL = ['./', 'index.html', 'app.js', 'config.js', 'vendor/supabase.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-64.png', 'icons/symbol.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== 'plantao-nav').map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith(caches.open(CACHE).then(async (c) => {
    const hit = await c.match(req, { ignoreSearch: true }) || (req.mode === 'navigate' ? await c.match('index.html') : undefined);
    const net = fetch(req).then((res) => { if (res && res.ok && res.type === 'basic') c.put(req, res.clone()); return res; }).catch(() => undefined);
    if (hit) { e.waitUntil(net); return hit; }
    return (await net) || new Response('Sem conexão', { status: 503 });
  }));
});

// Notificações push
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { title: 'Opus Scala', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Opus Scala', {
    body: d.body || '', icon: 'icons/icon-192.png', badge: 'icons/icon-192.png',
    tag: d.tag || undefined, renotify: !!d.tag, data: { url: d.url || './' }
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil((async () => {
    // guarda o destino: se o app abrir do zero, ele lê daqui (o iPhone às vezes ignora a URL)
    try { const c = await caches.open('plantao-nav'); await c.put('nav', new Response(JSON.stringify({ url, at: Date.now() }))); } catch (x) { /* */ }
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const cl of list) { cl.postMessage({ type: 'notif-open', url }); if ('focus' in cl) return cl.focus(); }
    return self.clients.openWindow(url);
  })());
});
