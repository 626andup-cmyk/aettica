/**
 * Aettica's service worker.
 *
 * A service worker is a small script the browser runs in the background for
 * a website. Browsers require one (along with manifest.webmanifest) before
 * they offer to install a site as an app on your home screen.
 *
 * Stage 1 keeps it deliberately minimal: it passes every request straight
 * through to the server and caches nothing. The server runs on the same phone,
 * so there's no slow network to hide, and caching would only risk showing you
 * an out-of-date app or chat. If the server isn't running, the browser shows
 * its normal "can't connect" page, which is the honest answer: start the
 * server in Termux.
 */

// Take over as soon as a new version is installed, instead of waiting for
// every open Aettica tab to close. That way updates apply on the next reload.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// Having a fetch handler is part of what makes the app installable. It does
// nothing special: fetch from the network, as if there were no worker.
self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request));
});
