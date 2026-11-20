// Plain (non-module) script that loads before the viewer.
// 1. Stops the browser from navigating to a dropped file anywhere on the page.
// 2. If the viewer code fails to start (missing vendor files, old browser,
//    blocked script), shows a visible message instead of a silent dead page.
(function () {
  ['dragover', 'drop'].forEach(function (type) {
    window.addEventListener(type, function (e) { e.preventDefault(); });
  });

  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.getElementById('about-btn');
    var dlg = document.getElementById('about-dialog');
    if (btn && dlg && dlg.showModal) btn.addEventListener('click', function () { dlg.showModal(); });
    if (dlg) dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); }); // click backdrop to close
    var close = document.getElementById('about-close');
    if (close && dlg) close.addEventListener('click', function () { dlg.close(); });
  });

  var errors = [];
  window.addEventListener('error', function (e) {
    var where = e.filename ? ' (' + e.filename.split('/').slice(-2).join('/') + ')' : '';
    errors.push((e.message || 'Script error') + where);
  }, true);

  // Resource load failures (e.g. vendor/three/three.module.js 404) arrive as
  // error events on the element; capture-phase listener above catches scripts,
  // but module graph failures don't always report, so also time out.
  setTimeout(function () {
    if (window.__viewerReady) return;
    var el = document.getElementById('status-left');
    var hint = document.getElementById('drop-hint');
    var msg = 'The viewer did not start. ' +
      (errors.length ? 'Error: ' + errors[0] + '. ' : '') +
      'Press F12 → Console for details. If you opened index.html from your disk (file:///…), use the website address instead.';
    if (el) { el.textContent = msg; el.className = 'error'; }
    if (hint) {
      hint.innerHTML = '<div class="drop-title" style="color:#b42318">Viewer failed to start</div><div></div>';
      hint.lastChild.textContent = msg;
    }
  }, 6000);
})();
