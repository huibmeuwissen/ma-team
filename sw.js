// Service worker van het MA Teamdashboard:
// - maakt de site installeerbaar en laat de laatst geladen versie offline werken;
// - toont pushmeldingen ("Heb je ... nagebeld?") ook als de app dicht is.
const CACHE = "ma-team-v14";
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(["./", "manifest.webmanifest", "icon-192.png"]))); self.skipWaiting(); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET" || !e.request.url.startsWith(self.location.origin)) return;
  // eerst netwerk (altijd de nieuwste versie), bij geen verbinding de opgeslagen versie.
  // "no-cache": altijd bij GitHub navragen of er een nieuwe versie is (anders kan de browser 10 minuten een oude versie tonen)
  const vers = e.request.mode === "navigate" ? new Request(e.request.url, { cache: "no-cache", credentials: "same-origin" }) : new Request(e.request, { cache: "no-cache" });
  e.respondWith(fetch(vers).then(r => { const k = r.clone(); caches.open(CACHE).then(c => c.put(e.request, k)); return r; }).catch(() => caches.match(e.request)));
});

// Pushbericht van Firebase Cloud Messaging (verstuurd door het GitHub-script).
self.addEventListener("push", e => {
  let p = {};
  try { p = e.data ? e.data.json() : {}; } catch (err) { p = { data: { body: e.data && e.data.text() } }; }
  const d = Object.assign({}, p.notification || {}, p.data || {});
  e.waitUntil(self.registration.showNotification(d.title || "MA Taken", {
    body: d.body || "Er staat een taak voor je klaar.",
    icon: "icon-192.png", badge: "icon-192.png",
    tag: d.tag || "ma-taak", renotify: true,
    data: { url: d.url || "./#taken" }
  }));
});

// Tik op de melding: de app naar voren halen, of openen als hij dicht is.
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "./#taken", self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const c of list) { if (c.url.startsWith(self.registration.scope)) return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
