/* Кэш оболочки и расписаний: приложение открывается без сети. */

const VERSION = "pary-v6";
const SHELL = [
  "./",
  "index.html",
  "legal.html",
  "privacy.html",
  "style.css?v=6",
  "app.js?v=6",
  "icon.svg",
  "icon-180.png",
  "icon-192.png",
  "manifest.webmanifest",
  "data/index.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // Навигация — сначала сеть, при обрыве отдаём оболочку из кэша.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req, { cache: "no-cache" })
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put("index.html", copy));
          return res;
        })
        .catch(() => caches.match("index.html"))
    );
    return;
  }

  // Данные расписания — stale-while-revalidate.
  if (url.pathname.includes("/data/")) {
    event.respondWith(
      caches.open(VERSION).then((cache) =>
        cache.match(req).then((hit) => {
          const net = fetch(req, { cache: "no-cache" })
            .then((res) => {
              if (res.ok) cache.put(req, res.clone());
              return res;
            })
            .catch(() => hit);
          return hit || net;
        })
      )
    );
    return;
  }

  // Всё остальное — из кэша, иначе сеть.
  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req))
  );
});
