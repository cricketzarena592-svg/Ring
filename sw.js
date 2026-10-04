const CACHE_NAME = "ring-shell-v9";
const APP_SHELL = ["./", "./index.html", "./styles.css", "./app.js", "./supabase-config.js", "./manifest.webmanifest", "./icon.svg", "./icon-180.png", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener("push", (event) => {
  if (!event.data) {
    console.error("Received a Ring push notification without a payload.");
    return;
  }
  let payload;
  try {
    payload = event.data.json();
  } catch (error) {
    console.error("Unable to read Ring push notification.", error);
    return;
  }
  if (!payload || typeof payload !== "object") {
    console.error("Received an invalid Ring push notification.");
    return;
  }
  const isTest = payload.type === "test";
  if (!isTest && (typeof payload.eventId !== "string" || !payload.eventId)) {
    console.error("Received a Ring push notification without an event ID.");
    return;
  }
  const title = isTest ? "Ring notification test" : payload.ringName ? `Ring · ${payload.ringName}` : "Incoming Ring";
  event.waitUntil(self.registration.showNotification(title, {
    body: isTest ? "Notifications are working on this device." : payload.topic || "Someone is checking in with your Ring.",
    icon: "./icon-192.png",
    badge: "./icon-192.png",
    tag: isTest ? "ring-notification-test" : payload.eventId,
    renotify: true,
    data: {
      eventId: payload.eventId,
      url: isTest ? "./" : `./?ringEvent=${encodeURIComponent(payload.eventId)}`,
    },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || "./", self.registration.scope).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const appWindow = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (appWindow) {
      await appWindow.navigate(targetUrl);
      await appWindow.focus();
      return;
    }
    await self.clients.openWindow(targetUrl);
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).then((response) => {
      const copy = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put("./index.html", copy));
      return response;
    }).catch(() => caches.match("./index.html")));
    return;
  }
  event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((response) => {
    if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
    return response;
  })));
});