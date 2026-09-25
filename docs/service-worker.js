const CACHE_NAME = "football-watch-shell-v1";
const SHELL_FILES = [
  "./index.html", "./style.css", "./app.js",
  "./manifest.json", "./icon.svg", "./city_timezones.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // schedule.json 每天都会更新，用"网络优先，失败才用缓存"，保证尽量拿到最新数据
  if (url.pathname.endsWith("schedule.json")) {
    event.respondWith(
      fetch(event.request)
        .then((resp) => {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return resp;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // 其他静态资源：缓存优先，加快打开速度
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
