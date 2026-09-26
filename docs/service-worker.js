const CACHE_NAME = "football-watch-shell-v4";
const SHELL_FILES = [
  "./index.html", "./style.css", "./app.js",
  "./manifest.json", "./icon.svg", "./city_timezones.json",
];
// 这些文件的更新频率高，用"网络优先"，保证每次打开都尽量是最新代码；
// 只有离线/网络失败时才退回缓存版本
const NETWORK_FIRST_FILES = ["index.html", "app.js", "style.css", "city_timezones.json"];

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
  const isNetworkFirst = url.pathname.endsWith("schedule.json") ||
    NETWORK_FIRST_FILES.some((f) => url.pathname.endsWith(f));

  if (isNetworkFirst) {
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

  // 其他静态资源（图标等不常变的）：缓存优先，加快打开速度
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
