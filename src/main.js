import { Viewer } from './viewer.js';
import { project, pointAt, formatStation, formatOffset, parseStation, tickInterval } from './alignment.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const viewer = new Viewer($('viewport'));
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });

let model = null;   // the 'loaded' message from the worker
let align = null;   // active alignment
let fileName = '';

// ------------------------------------------------------------ worker plumbing
let reqSeq = 0;
const pending = new Map();
function request(cmd, payload = {}) {
  return new Promise((resolve, reject) => {
    const reqId = ++reqSeq;
    pending.set(reqId, { resolve, reject });
    worker.postMessage({ cmd, reqId, ...payload });
  });
}

worker.onmessage = (e) => {
  const m = e.data;
  switch (m.type) {
    case 'progress': showProgress(m.msg); break;
    case 'chunk': viewer.addChunk(m); break;
    case 'loaded': onLoaded(m); break;
    case 'reply': pending.get(m.reqId)?.resolve(m.data); pending.delete(m.reqId); break;
    case 'error':
      if (m.reqId && pending.has(m.reqId)) { pending.get(m.reqId).reject(new Error(m.message)); pending.delete(m.reqId); }
      else { hideProgress(); setStatus(`Could not open file: ${m.message}`, true); }
      break;
  }
};
worker.onerror = (e) => {
  hideProgress();
  setStatus(`The IFC engine failed to start (${e.message || 'see browser console'}). If you are running locally, did you run scripts/vendor.sh?`, true);
};

// ------------------------------------------------------------ status / progress
function setStatus(text, isError = false) {
  const el = $('status-left');
  el.textContent = text;
  el.classList.toggle('error', isError);
}
function showProgress(text) { $('progress').hidden = false; $('progress-text').textContent = text; }
function hideProgress() { $('progress').hidden = true; }
const fmtInt = (n) => Math.round(n).toLocaleString();

// ------------------------------------------------------------ opening files
async function openFile(file) {
  if (!file) return;
  fileName = file.name;
  model = null;
  align = null;
  viewer.clear();
  resetPanels();
  $('drop-hint').hidden = true;
  const mb = file.size / 1048576;
  setStatus(`Opening ${file.name}…`);
  showProgress(`Reading ${file.name} (${mb.toFixed(1)} MB)…`);
  if (mb > 400) setStatus(`${file.name} is ${mb.toFixed(0)} MB — this may exceed browser memory on some machines.`);
  const buffer = await file.arrayBuffer();
  worker.postMessage({ cmd: 'open', buffer }, [buffer]); // transfer, not copy
}

$('file').addEventListener('change', (e) => { openFile(e.target.files[0]); e.target.value = ''; });
// Accept a dropped file anywhere on the page, not just over the 3D view.
const vp = $('viewport');
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; vp.classList.add('dragging'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; vp.classList.remove('dragging'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  vp.classList.remove('dragging');
  if (e.dataTransfer?.files?.length) openFile(e.dataTransfer.files[0]);
});

function onLoaded(m) {
  model = m;
  hideProgress();
  viewer.setMapping(m.mapping);
  viewer.fitAll();
  renderTree(m.tree);
  renderLayers(m.classes);
  setupAlignments(m.alignments);
  $('fit-btn').disabled = false;
  updateVisUI();
  $('run-checks').disabled = false;
  const schemaNote = m.schema && !/IFC4X3/i.test(m.schema) ? ` — note: schema is ${m.schema}, not IFC4.3` : '';
  setStatus(`${fileName}: ${fmtInt(m.stats.elements)} elements, ${fmtInt(m.stats.triangles)} triangles, ` +
    `${m.schema || 'unknown schema'}, units ${m.units.lengthName}, loaded in ${m.stats.seconds.toFixed(1)} s${schemaNote}`);
  if (m.mappingNote) setStatus(`${$('status-left').textContent}. ${m.mappingNote}`, true);
}

function resetPanels() {
  $('tree-root').innerHTML = '<div class="empty">Loading…</div>';
  $('tree-root').hidden = false;
  $('search-results').hidden = true;
  $('tree-search').value = '';
  $('tree-search').disabled = true;
  updateVisUI();
  $('tab-layers').innerHTML = '';
  $('check-results').innerHTML = '';
  $('props').innerHTML = EMPTY_PROPS;
  $('align-group').hidden = true;
  $('status-right').textContent = '';
}

// ------------------------------------------------------------ station math helpers
const unit = () => model.units.stationUnit;
const f = () => model.units.displayFactor;
const staText = (s) => formatStation((align.startStation + s) * f(), unit());

/** Station / offset / elevation for a scene point against the active alignment. */
function readout(scenePoint) {
  if (!align || !viewer.Minv) return null;
  const raw = viewer.sceneToRaw(scenePoint);
  const pr = project(align, raw.x, raw.y);
  if (!pr) return null;
  const elev = raw.z * f();
  const parts = [`Sta ${staText(pr.s)}`, formatOffset(pr.offset * f(), unit()), `El ${elev.toFixed(2)} ${unit()}`];
  if (align.hasProfile) {
    const dz = (raw.z - pr.z) * f();
    parts.push(`${dz >= 0 ? '+' : '−'}${Math.abs(dz).toFixed(2)} ${unit()} vs profile`);
  }
  if (pr.beforeStart) parts.push('(before alignment start)');
  if (pr.afterEnd) parts.push('(past alignment end)');
  return { text: parts.join(' · '), pr, raw };
}

function stationRange(samples) {
  if (!align || !viewer.Minv || !samples.length) return null;
  let sMin = Infinity, sMax = -Infinity, oMin = Infinity, oMax = -Infinity;
  for (let i = 0; i < samples.length; i += 3) {
    const raw = viewer.sceneXYZToRaw(samples[i], samples[i + 1], samples[i + 2]);
    const pr = project(align, raw.x, raw.y);
    if (!pr) continue;
    sMin = Math.min(sMin, pr.s); sMax = Math.max(sMax, pr.s);
    oMin = Math.min(oMin, pr.offset); oMax = Math.max(oMax, pr.offset);
  }
  if (!Number.isFinite(sMin)) return null;
  return `Sta ${staText(sMin)} → ${staText(sMax)}<br>Offset ${formatOffset(oMax * f(), unit())} → ${formatOffset(oMin * f(), unit())}`;
}

// ------------------------------------------------------------ alignments
function setupAlignments(list) {
  const sel = $('align-select');
  sel.innerHTML = '';
  const usable = list.filter((a) => !a.unsupported);
  if (!usable.length || !model.mapping) {
    $('align-group').hidden = true;
    if (list.length) setStatus(`${$('status-left').textContent}. Alignment found but it has no IFC4.3 horizontal segments this prototype can read.`);
    return;
  }
  usable.forEach((a, i) => {
    const o = document.createElement('option');
    o.value = i;
    o.textContent = a.name;
    sel.appendChild(o);
  });
  const none = document.createElement('option');
  none.value = '-1';
  none.textContent = '(hide alignment)';
  sel.appendChild(none);
  sel.onchange = () => activateAlignment(usable[Number(sel.value)] || null);
  $('align-group').hidden = false;
  activateAlignment(usable[0]);
}

function activateAlignment(al) {
  align = al;
  viewer.clearMarker();
  if (!al) { viewer.clearAlignment(); return; }
  const interval = tickInterval(al.length * f(), unit()) / f(); // raw units
  const first = Math.ceil(al.startStation / interval) * interval - al.startStation;
  const ticks = [];
  for (let s = first; s <= al.length + 1e-6; s += interval) ticks.push({ point: pointAt(al, s), label: staText(s) });
  viewer.drawAlignment(al, ticks);
  $('goto-input').placeholder = `Go to station, e.g. ${staText(al.length / 2).replace(/\.\d+$/, '')}`;
  $('align-info').textContent = `${staText(0)} to ${staText(al.length)}${al.hasProfile ? '' : ' · no vertical profile'}`;
}

$('goto-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!align) return;
  const v = parseStation($('goto-input').value, unit());
  if (!Number.isFinite(v)) { setStatus('Could not read that station. Try 105+00 or 10500.', true); return; }
  const s = v / f() - align.startStation;
  if (s < 0 || s > align.length) setStatus(`Station is outside the alignment (${staText(0)} to ${staText(align.length)}); showing the nearest end.`, true);
  const p = pointAt(align, Math.min(Math.max(s, 0), align.length));
  const scene = viewer.rawToScene(p.x, p.y, p.z);
  viewer.lookAt(scene, viewer.modelSize() * 0.12);
  viewer.showOffsetMarker(scene, scene.clone());
});

// ------------------------------------------------------------ picking
let down = null;
let hoverTimer = 0;
viewer.canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, button: e.button }; hideMenu(); });
viewer.canvas.addEventListener('pointerup', (e) => {
  if (!down) return;
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4;
  const button = down.button;
  if (button !== 2) down = null; // keep right-button info for the contextmenu event
  if (!moved && model && button === 0) onClick(e);
});
viewer.canvas.addEventListener('pointermove', (e) => {
  clearTimeout(hoverTimer);
  if (e.buttons || !model || !$('hover-chk').checked) return;
  hoverTimer = setTimeout(() => {
    const hit = viewer.pick(e.clientX, e.clientY);
    if (!hit) { $('status-right').textContent = ''; return; }
    const r = readout(hit.point);
    $('status-right').textContent = `${model.classes[hit.cls]?.name ?? ''}${r ? ' · ' + r.text : ''}`;
  }, 120);
});

// Double-click: make the element under the cursor the centre of rotation.
viewer.canvas.addEventListener('dblclick', (e) => {
  if (!model) return;
  const hit = viewer.pick(e.clientX, e.clientY);
  if (!hit) return;
  if (!viewer.selected.includes(hit.id)) select([hit.id]);
  const box = viewer.highlight(viewer.selected).box;
  const size = box ? box.getSize(hit.point.clone()).length() : 0;
  viewer.focusOn(hit.point, size);
});

function onClick(e) {
  const hit = viewer.pick(e.clientX, e.clientY);
  const additive = e.ctrlKey || e.metaKey || e.shiftKey;
  if (additive) {
    if (!hit) return;
    const cur = viewer.selected.slice();
    const i = cur.indexOf(hit.id);
    if (i >= 0) cur.splice(i, 1); else cur.push(hit.id);
    select(cur, { label: `${cur.length} selected` });
    return;
  }
  if (!hit) { select([]); viewer.clearMarker(); return; }
  const r = readout(hit.point);
  if (r) {
    viewer.showOffsetMarker(viewer.rawToScene(r.pr.x, r.pr.y, r.pr.z), hit.point);
    $('status-right').textContent = r.text;
  }
  select([hit.id], { clickReadout: r?.text });
}

// ------------------------------------------------------------ selection + properties
const EMPTY_PROPS = '<div class="empty">Click an element.<br><span class="muted">Ctrl+click adds to the selection. Double-click to orbit around a spot. Right-click for Isolate / Hide.</span></div>';
async function select(ids, opts = {}) {
  const info = viewer.highlight(ids);
  updateVisUI();
  if (opts.zoom && info.box) viewer.fitBox(info.box, 1.6);
  const props = $('props');
  if (!ids.length) { props.innerHTML = EMPTY_PROPS; return; }
  const range = stationRange(info.samples);
  const rangeHtml = range ? `<div class="station-card">${range}${opts.clickReadout ? `<div class="click">Clicked: ${esc(opts.clickReadout)}</div>` : ''}</div>` : '';

  if (ids.length > 1) {
    props.innerHTML = `<h3>${esc(opts.label || 'Selection')}</h3><div class="muted">${fmtInt(ids.length)} elements · ${fmtInt(info.triangles)} triangles</div>${rangeHtml}`;
    return;
  }
  props.innerHTML = `${rangeHtml}<div class="muted">Loading properties…</div>`;
  let d;
  try { d = await request('props', { id: ids[0] }); } catch (err) { props.innerHTML = `<div class="error">${esc(err.message)}</div>`; return; }
  if (viewer.selected[0] !== ids[0]) return; // selection changed meanwhile
  const rows = (items) => items.map((p) => `<tr><th>${esc(p.name)}</th><td>${esc(p.value)}</td></tr>`).join('');
  props.innerHTML = `
    <h3>${esc(d.name || '(no name)')}</h3>
    <div class="muted">${esc(d.type)} · #${d.id}</div>
    ${rangeHtml}
    <details open><summary>Attributes</summary><table>${rows(d.attrs)}</table></details>
    ${d.psets.map((ps) => `<details open><summary>${esc(ps.name)}${ps.kind === 'quantities' ? ' <span class="badge">Qto</span>' : ''}</summary><table>${rows(ps.props)}</table></details>`).join('')}
    ${d.psets.length ? '' : '<div class="muted">No property sets.</div>'}`;
}

// ------------------------------------------------------------ bridge tree
const PART_LABEL = {
  SUPERSTRUCTURE: 'Superstructure', SUBSTRUCTURE: 'Substructure', PIER: 'Pier', PIER_SEGMENT: 'Pier segment',
  ABUTMENT: 'Abutment', DECK: 'Deck', DECK_SEGMENT: 'Deck segment', FOUNDATION: 'Foundation', PYLON: 'Pylon',
  SURFACESTRUCTURE: 'Surface structure',
};

function collectIds(n) {
  if (n._ids) return n._ids;
  const ids = [n.id];
  for (const list of Object.values(n.elements)) ids.push(...list);
  for (const c of n.children) ids.push(...collectIds(c));
  return (n._ids = ids);
}

function selectButton(onClick) {
  const b = document.createElement('button');
  b.className = 'sel';
  b.title = 'Select and zoom';
  b.textContent = '⌖';
  b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onClick(); });
  return b;
}

const naturalSort = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
const shortType = (t) => t.replace(/^Ifc/, '');
const GROUP_THRESHOLD = 6; // this many same-type children collapse into one row

/** One-line row: name first, type small and grey, full text in the tooltip. */
function nodeSummary(n) {
  const isPart = n.type === 'IfcBridgePart' || n.type === 'IfcFacilityPart';
  const kind = isPart && PART_LABEL[n.pdt] ? PART_LABEL[n.pdt] : shortType(n.type);
  const detail = n.pdt === 'USERDEFINED' ? n.objectType : n.pdt && n.pdt !== 'NOTDEFINED' && !isPart ? n.pdt : '';
  const sum = document.createElement('summary');
  sum.title = [n.name, kind, detail].filter(Boolean).join(' · ');
  sum.innerHTML = isPart
    ? `<span class="ty part">${esc(kind)}</span><span class="nm">${esc(n.name && n.name !== kind ? n.name : '')}</span>`
    : `<span class="nm">${esc(n.name || `#${n.id}`)}</span><span class="ty small">${esc(kind)}</span>` +
      (detail ? `<span class="badge">${esc(detail)}</span>` : '');
  return sum;
}

function groupRow(label, count, ids, selectLabel, fill) {
  const g = document.createElement('details');
  g.className = 'group';
  const gs = document.createElement('summary');
  gs.title = `${label} (${count})`;
  gs.innerHTML = `<span class="nm">${esc(label)}</span><span class="count">${fmtInt(count)}</span>`;
  gs.appendChild(selectButton(() => select(ids(), { zoom: true, label: selectLabel })));
  g.appendChild(gs);
  let loaded = false;
  g.addEventListener('toggle', async () => {
    if (!g.open || loaded) return;
    loaded = true;
    await fill(g);
  });
  return g;
}

function leafRow(id, name, type) {
  const leaf = document.createElement('div');
  leaf.className = 'leaf';
  leaf.title = `${name || `#${id}`}${type ? ' · ' + type : ''}`;
  leaf.innerHTML = `<span class="nm">${esc(name || `#${id}`)}</span>${type ? `<span class="ty small">${esc(shortType(type))}</span>` : ''}`;
  leaf.addEventListener('click', () => select([id], { zoom: true }));
  return leaf;
}

function buildNode(n, depth) {
  const det = document.createElement('details');
  det.open = depth < 4;
  const sum = nodeSummary(n);
  sum.appendChild(selectButton(() => select(collectIds(n), { zoom: true, label: `${shortType(n.type)} ${n.name}` })));
  det.appendChild(sum);

  // Child nodes: spatial parts stay individual; big runs of one type collapse into a group row.
  const byType = new Map();
  for (const c of n.children) {
    if (!byType.has(c.type)) byType.set(c.type, []);
    byType.get(c.type).push(c);
  }
  for (const [type, kids] of byType) {
    kids.sort((a, b) => naturalSort(a.name || '', b.name || ''));
    const spatial = /BridgePart|FacilityPart|Bridge$|Site$|Building$|Storey$/.test(type);
    if (kids.length < GROUP_THRESHOLD || spatial) {
      for (const c of kids) det.appendChild(buildNode(c, depth + 1));
    } else {
      det.appendChild(groupRow(shortType(type), kids.length, () => kids.flatMap(collectIds),
        `${shortType(type)} in ${n.name || shortType(n.type)}`,
        (g) => { for (const c of kids) g.appendChild(buildNode(c, 99)); }));
    }
  }

  // Contained elements, grouped by class; names fetched when a group is opened.
  for (const [type, ids] of Object.entries(n.elements).sort((a, b) => naturalSort(a[0], b[0]))) {
    det.appendChild(groupRow(shortType(type), ids.length, () => ids, `${shortType(type)} in ${n.name || shortType(n.type)}`,
      async (g) => {
        const shown = ids.slice(0, 2000);
        const names = await request('names', { ids: shown });
        names.sort((a, b) => naturalSort(a[1] || '', b[1] || ''));
        const frag = document.createDocumentFragment();
        for (const [id, name] of names) frag.appendChild(leafRow(id, name));
        if (ids.length > shown.length) {
          const more = document.createElement('div');
          more.className = 'muted';
          more.textContent = `…and ${fmtInt(ids.length - shown.length)} more (use search or ⌖ to select all)`;
          frag.appendChild(more);
        }
        g.appendChild(frag);
      }));
  }
  return det;
}

function renderTree(tree) {
  const root = $('tree-root');
  root.innerHTML = '';
  $('tree-search').disabled = !tree;
  if (!tree) { root.innerHTML = '<div class="empty">No IfcProject found.</div>'; return; }
  root.appendChild(buildNode(tree, 0));
}

// ------------------------------------------------------------ search
let searchTimer = 0, searchSeq = 0;
$('tree-search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 250);
});
$('tree-search').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.target.value = ''; runSearch(); }
});

async function runSearch() {
  const q = $('tree-search').value.trim();
  const box = $('search-results');
  if (!q || !model) { box.hidden = true; $('tree-root').hidden = false; return; }
  const seq = ++searchSeq;
  box.hidden = false;
  $('tree-root').hidden = true;
  box.innerHTML = '<div class="muted">Searching…</div>';
  const res = await request('search', { q });
  if (seq !== searchSeq) return; // a newer search started
  box.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'result-head';
  head.innerHTML = `<span class="muted">${fmtInt(res.total)} match${res.total === 1 ? '' : 'es'}</span>`;
  if (res.total) {
    const b = document.createElement('button');
    b.className = 'btn small';
    b.textContent = 'Select all';
    b.onclick = () => select(res.ids, { zoom: true, label: `Search: “${q}”` });
    head.appendChild(b);
  }
  box.appendChild(head);
  for (const [id, name, type] of res.shown) box.appendChild(leafRow(id, name, type));
  if (res.total > res.shown.length) {
    const more = document.createElement('div');
    more.className = 'muted';
    more.textContent = `Showing first ${fmtInt(res.shown.length)}. Refine the search, or use Select all.`;
    box.appendChild(more);
  }
}

// ------------------------------------------------------------ resizable panels
function setupSplitter(splitId, panelId, side) {
  const split = $(splitId), panel = $(panelId), layout = document.querySelector('.layout');
  const key = `bridge-viewer-${side}-width`;
  const collapsedKey = `bridge-viewer-${side}-collapsed`;
  const cls = `${side}-collapsed`;
  const label = side === 'left' ? 'bridge tree' : 'properties';
  const shortcut = side === 'left' ? '[' : ']';
  const apply = (w) => layout.style.setProperty(`--${side}-w`, `${w}px`);
  try { const saved = Number(localStorage.getItem(key)); if (saved > 0) apply(saved); } catch { /* storage unavailable */ }

  // Collapse / expand tab on the splitter.
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'panel-toggle';
  split.appendChild(toggle);
  const isCollapsed = () => layout.classList.contains(cls);
  const setCollapsed = (c, animate = true) => {
    if (animate) {
      layout.classList.add('animating');
      clearTimeout(setCollapsed.t);
      setCollapsed.t = setTimeout(() => layout.classList.remove('animating'), 250);
    }
    layout.classList.toggle(cls, c);
    const arrowOpen = side === 'left' ? '‹' : '›', arrowClosed = side === 'left' ? '›' : '‹';
    toggle.textContent = c ? arrowClosed : arrowOpen;
    toggle.title = `${c ? 'Show' : 'Hide'} the ${label} panel (${shortcut})`;
    toggle.setAttribute('aria-expanded', String(!c));
    split.title = c ? '' : 'Drag to resize · double-click to reset width';
    try { localStorage.setItem(collapsedKey, c ? '1' : '0'); } catch { /* ignore */ }
  };
  toggle.addEventListener('pointerdown', (e) => e.stopPropagation());
  toggle.addEventListener('dblclick', (e) => e.stopPropagation());
  toggle.addEventListener('click', () => setCollapsed(!isCollapsed()));
  let initial = false;
  try { initial = localStorage.getItem(collapsedKey) === '1'; } catch { /* ignore */ }
  setCollapsed(initial, false);

  split.addEventListener('pointerdown', (e) => {
    if (isCollapsed()) return;
    e.preventDefault();
    split.setPointerCapture(e.pointerId);
    split.classList.add('active');
    const startX = e.clientX, startW = panel.getBoundingClientRect().width;
    let w = startW;
    const move = (ev) => {
      const dx = ev.clientX - startX;
      w = Math.round(Math.max(180, Math.min(window.innerWidth * 0.6, side === 'left' ? startW + dx : startW - dx)));
      apply(w);
    };
    const up = () => {
      split.classList.remove('active');
      split.removeEventListener('pointermove', move);
      split.removeEventListener('pointerup', up);
      try { localStorage.setItem(key, String(w)); } catch { /* ignore */ }
    };
    split.addEventListener('pointermove', move);
    split.addEventListener('pointerup', up);
  });
  split.addEventListener('dblclick', () => { // double-click resets width
    if (isCollapsed()) return;
    layout.style.removeProperty(`--${side}-w`);
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  });
  return { toggle: () => setCollapsed(!isCollapsed()), set: setCollapsed, isCollapsed };
}
const panels = {
  left: setupSplitter('split-left', 'left-panel', 'left'),
  right: setupSplitter('split-right', 'right-panel', 'right'),
};

// ------------------------------------------------------------ layers (by IFC class)
function renderLayers(classes) {
  const el = $('tab-layers');
  const order = classes.map((c, i) => ({ ...c, i })).sort((a, b) => b.count - a.count);
  el.innerHTML = `<div class="row"><button class="btn small" id="show-all">Show all</button>
    <button class="btn small" id="toggle-align">Toggle alignment</button></div>` +
    order.map((c) => `<label class="layer"><input type="checkbox" data-cls="${c.i}" checked> ${esc(c.name.replace(/^Ifc/, ''))} <span class="count">${fmtInt(c.count)}</span></label>`).join('');
  const apply = () => {
    const hidden = [...el.querySelectorAll('input[data-cls]')].filter((c) => !c.checked).map((c) => Number(c.dataset.cls));
    viewer.setVisibility({ hiddenClasses: new Set(hidden) });
    updateVisUI();
  };
  el.querySelectorAll('input[data-cls]').forEach((c) => c.addEventListener('change', apply));
  $('show-all').onclick = () => { el.querySelectorAll('input[data-cls]').forEach((c) => (c.checked = true)); apply(); };
  let alignOn = true;
  $('toggle-align').onclick = () => { alignOn = !alignOn; viewer.setAlignmentVisible(alignOn); };
}

// ------------------------------------------------------------ requirement checks
$('run-checks').addEventListener('click', async () => {
  const out = $('check-results');
  out.innerHTML = '<div class="muted">Checking…</div>';
  let cfg;
  try {
    cfg = await (await fetch('config/requirements.json', { cache: 'no-store' })).json();
  } catch (err) {
    out.innerHTML = `<div class="error">Could not load config/requirements.json: ${esc(err.message)}</div>`;
    return;
  }
  const results = await request('check', { rules: cfg.rules || [] });
  out.innerHTML = `<h3>${esc(cfg.title || 'Checks')}</h3>`;
  for (const r of results) {
    const status = !r.known ? 'unknown' : r.total === 0 ? 'na' : r.failing.length ? 'fail' : 'pass';
    const label = { pass: 'Pass', fail: `${fmtInt(r.failing.length)} of ${fmtInt(r.total)} missing`, na: 'No elements', unknown: 'Unknown entity' }[status];
    const card = document.createElement('div');
    card.className = `check ${status}`;
    card.innerHTML = `<div class="check-head"><b>${esc(r.id || '')}</b> ${esc(r.description || '')}</div>
      <div class="muted">${esc(r.entity)} → ${esc(r.attribute || `${r.pset}.${r.property}`)}</div>
      <div class="check-status">${label}</div>`;
    if (r.failing.length) {
      const b = document.createElement('button');
      b.className = 'btn small';
      b.textContent = 'Select failing';
      b.onclick = () => select(r.failing, { zoom: true, label: `${r.id}: failing elements` });
      card.appendChild(b);
    }
    out.appendChild(card);
  }
});

// ------------------------------------------------------------ isolate / hide / ghost
function isolateSelection() {
  const ids = viewer.selected;
  if (!ids.length) return;
  viewer.setVisibility({ isolate: new Set(ids), hiddenIds: new Set() });
  const box = viewer.visibleBox();
  if (box) viewer.fitBox(box, 1.4);
  updateVisUI();
}
function hideSelection() {
  const ids = viewer.selected;
  if (!ids.length) return;
  const hidden = new Set(viewer.vis.hiddenIds);
  for (const id of ids) hidden.add(id);
  viewer.setVisibility({ hiddenIds: hidden });
  select([]);
}
function toggleGhost() {
  viewer.setVisibility({ ghost: !viewer.vis.ghost });
  updateVisUI();
}
function showAll() {
  viewer.setVisibility({ isolate: null, hiddenIds: new Set(), hiddenClasses: new Set() });
  document.querySelectorAll('#tab-layers input[data-cls]').forEach((c) => (c.checked = true));
  updateVisUI();
}
function zoomSelection() {
  const info = viewer.highlight(viewer.selected);
  if (info.box) viewer.fitBox(info.box, 1.6);
}

function updateVisUI() {
  const v = viewer.vis;
  const hasSel = viewer.selected.length > 0;
  $('iso-btn').disabled = !model || !hasSel;
  $('hide-btn').disabled = !model || !hasSel;
  $('ghost-btn').disabled = !model;
  $('ghost-btn').classList.toggle('on', v.ghost);
  $('ghost-btn').setAttribute('aria-pressed', String(v.ghost));
  const parts = [];
  if (v.isolate) parts.push(`Isolated: ${fmtInt(v.isolate.size)}`);
  if (v.hiddenIds.size) parts.push(`${fmtInt(v.hiddenIds.size)} hidden`);
  if (v.hiddenClasses.size) parts.push(`${v.hiddenClasses.size} layer${v.hiddenClasses.size > 1 ? 's' : ''} off`);
  $('showall-btn').disabled = !model || !parts.length;
  $('vis-chip').hidden = !parts.length;
  $('vis-chip').textContent = parts.join(' · ');
}

$('iso-btn').addEventListener('click', isolateSelection);
$('hide-btn').addEventListener('click', hideSelection);
$('ghost-btn').addEventListener('click', toggleGhost);
$('showall-btn').addEventListener('click', showAll);

// Right-click menu on the model (a right-drag still pans).
const menu = $('ctx-menu');
function hideMenu() { menu.hidden = true; }
viewer.canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const d = down;
  down = null;
  if (!model || (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4)) return;
  const hit = viewer.pick(e.clientX, e.clientY);
  if (hit && !viewer.selected.includes(hit.id)) select([hit.id]);
  const n = viewer.selected.length;
  const v = viewer.vis;
  const anyHidden = v.isolate || v.hiddenIds.size || v.hiddenClasses.size;
  const items = [
    ['Isolate', 'I', isolateSelection, n > 0],
    ['Hide', 'H', hideSelection, n > 0],
    [v.ghost ? 'Ghost off' : 'Ghost hidden items', 'G', toggleGhost, true],
    ['Show all', 'U', showAll, !!anyHidden],
    null,
    ['Zoom to selection', 'Z', zoomSelection, n > 0],
    ['Fit view', 'F', fitView, true],
    ['Clear selection', 'Esc', () => select([]), n > 0],
  ];
  menu.innerHTML = '';
  if (n) {
    const head = document.createElement('div');
    head.className = 'ctx-head';
    head.textContent = `${fmtInt(n)} selected`;
    menu.appendChild(head);
  }
  for (const it of items) {
    if (!it) { menu.appendChild(Object.assign(document.createElement('div'), { className: 'ctx-sep' })); continue; }
    const [label, key, fn, enabled] = it;
    const b = document.createElement('button');
    b.disabled = !enabled;
    b.innerHTML = `<span>${esc(label)}</span><kbd>${esc(key)}</kbd>`;
    b.addEventListener('click', () => { hideMenu(); fn(); });
    menu.appendChild(b);
  }
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(e.clientX, window.innerWidth - r.width - 6)}px`;
  menu.style.top = `${Math.min(e.clientY, window.innerHeight - r.height - 6)}px`;
});
window.addEventListener('pointerdown', (e) => { if (!menu.contains(e.target)) hideMenu(); });
window.addEventListener('blur', hideMenu);

// ------------------------------------------------------------ misc UI
$('fit-btn').addEventListener('click', fitView);
function fitView() {
  const v = viewer.vis;
  const partial = v.isolate || v.hiddenIds.size || v.hiddenClasses.size;
  const box = partial ? viewer.visibleBox() : null;
  if (box) viewer.fitBox(box); else viewer.fitAll();
}
document.querySelectorAll('.tabs button').forEach((btn) => btn.addEventListener('click', () => {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b === btn));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${btn.dataset.tab}`));
}));
window.__viewerReady = true; // tells src/boot.js the viewer started
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { hideMenu(); select([]); viewer.clearMarker(); return; }
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === '[') { panels.left.toggle(); return; }
  if (e.key === ']') { panels.right.toggle(); return; }
  if (e.key === '\\') {
    const anyOpen = !panels.left.isCollapsed() || !panels.right.isCollapsed();
    panels.left.set(anyOpen); panels.right.set(anyOpen);
    return;
  }
  if (!model) return;
  const action = { f: fitView, i: isolateSelection, h: hideSelection, g: toggleGhost, u: showAll, z: zoomSelection }[e.key.toLowerCase()];
  if (action) { e.preventDefault(); hideMenu(); action(); }
});
