/* Service Worker for NoticeBoard Web Push */

self.addEventListener("push", (event) => {
  let data = { title: "New Notice", body: "A new notice has been posted." };

  try {
    if (event.data) {
      data = event.data.json();
    }
  } catch (e) {
    console.error("Push data parse error", e);
  }

  const options = {
    body: data.body || "",
    icon: "/ico.png",
    badge: "/ico.png",
    data: data.data || {},
    vibrate: [100, 50, 100],
    requireInteraction: false,
  };

  event.waitUntil(
    self.registration.showNotification(data.title || "New Notice", options)
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const urlToOpen = event.notification.data?.url || "/";

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && "focus" in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(urlToOpen);
      }
    })
  );
});

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(clients.claim());
});
