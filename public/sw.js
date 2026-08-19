const SHELL = [
  "/",
  "/styles.css",
  "/app.js",
  "/manifest.webmanifest",
  "/icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open("shell-v1").then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== "shell-v1").map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  event.respondWith(
    (async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      try {
        const res = await fetch(req);
        if (res.ok && SHELL.includes(url.pathname)) {
          const clone = res.clone();
          const cache = await caches.open("shell-v1");
          cache.put(req, clone);
        }
        return res;
      } catch {
        return cached || new Response("Offline", { status: 503 });
      }
    })()
  );
});