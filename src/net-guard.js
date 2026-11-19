// Defense in depth for the worker that holds the IFC file in memory.
//
// The page's Content-Security-Policy (index.html) blocks outbound requests from
// the main thread, but a meta-tag CSP does not reach a module worker. Static hosts
// like GitHub Pages can't set CSP headers, so this module — imported FIRST in
// worker.js — restricts the worker's network APIs to same-origin requests
// (which it needs to load the vendored .wasm file) before any library code runs.
//
// This is not a sandbox against deliberately malicious code; the main protection
// is that every library is vendored at a pinned, integrity-checked version.
// When you host this on your own server, also send a real CSP header
// (see README → "Hosting internally").

const ORIGIN = self.location.origin;

function assertLocal(url) {
  const u = new URL(String(url), self.location.href);
  if (u.origin !== ORIGIN) throw new TypeError(`Blocked non-local request from IFC worker: ${u.href}`);
}

const realFetch = self.fetch.bind(self);
self.fetch = (input, init) => {
  try {
    assertLocal(input instanceof Request ? input.url : input);
  } catch (e) {
    return Promise.reject(e);
  }
  return realFetch(input, init);
};

if (self.XMLHttpRequest) {
  const open = self.XMLHttpRequest.prototype.open;
  self.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    assertLocal(url);
    return open.call(this, method, url, ...rest);
  };
}

for (const name of ['WebSocket', 'EventSource', 'WebTransport']) {
  if (name in self) {
    try {
      Object.defineProperty(self, name, {
        value: function blocked() { throw new TypeError(`${name} is disabled in the IFC worker`); },
        writable: false,
        configurable: false,
      });
    } catch { /* ignore */ }
  }
}
