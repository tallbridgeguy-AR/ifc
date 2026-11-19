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
const vp = $('viewport');
vp.addEventListener('dragover', (e) => { e.preventDefault(); vp.classList.add('dragging'); });
vp.addEventListener('dragleave', () => vp.classList.remove('dragging'));
vp.addEventListener('drop', (e) => { e.preventDefault(); vp.classList.remove('dragging'); openFile(e.dataTransfer.files[0]); });

function onLoaded(m) {
  model = m;
  hideProgress();
  viewer.setMapping(m.mapping);
  viewer.fitAll();
  renderTree(m.tree);
  renderLayers(m.classes);
  setupAlignments(m.alignments);
  $('fit-btn').disabled = false;
  $('run-checks').disabled = false;
  const schemaNote = m.schema && !/IFC4X3/i.test(m.schema) ? ` — note: schema is ${m.schema}, not IFC4.3` : '';
  setStatus(`${fileName}: ${fmtInt(m.stats.elements)} elements, ${fmtInt(m.stats.triangles)} triangles, ` +
    `${m.schema || 'unknown schema'}, units ${m.units.lengthName}, loaded in ${m.stats.seconds.toFixed(1)} s${schemaNote}`);
  if (m.mappingNote) setStatus(`${$('status-left').textContent}. ${m.mappingNote}`, true);
}

function resetPanels() {
  $('tab-tree').innerHTML = '<div class="empty">Loading…</div>';
  $('tab-layers').innerHTML = '';
  $('check-results').innerHTML = '';
  $('props').innerHTML = '<div class="empty">Click an element.</div>';
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
viewer.canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
viewer.canvas.addEventListener('pointerup', (e) => {
  if (!down) return;
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4;
  down = null;
  if (!moved && model) onClick(e);
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

function onClick(e) {
  const hit = viewer.pick(e.clientX, e.clientY);
  if (!hit) { select([]); viewer.clearMarker(); return; }
  const r = readout(hit.point);
  if (r) {
    viewer.showOffsetMarker(viewer.rawToScene(r.pr.x, r.pr.y, r.pr.z), hit.point);
    $('status-right').textContent = r.text;
  }
  select([hit.id], { clickReadout: r?.text });
}

// ------------------------------------------------------------ selection + properties
async function select(ids, opts = {}) {
  const info = viewer.highlight(ids);
  if (opts.zoom && info.box) viewer.fitBox(info.box, 1.6);
  const props = $('props');
  if (!ids.length) { props.innerHTML = '<div class="empty">Click an element.</div>'; return; }
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

function nodeLabel(n) {
  const isPart = n.type === 'IfcBridgePart' || n.type === 'IfcFacilityPart';
  const kind = isPart && PART_LABEL[n.pdt] ? PART_LABEL[n.pdt] : n.type.replace(/^Ifc/, '');
  return `<span class="ty ${isPart ? 'part' : ''}">${esc(kind)}</span> ${esc(n.name)}` +
    (n.pdt && n.pdt !== 'NOTDEFINED' && !isPart ? ` <span class="badge">${esc(n.pdt)}</span>` : '');
}

function buildNode(n, depth) {
  const det = document.createElement('details');
  det.open = depth < 4;
  const sum = document.createElement('summary');
  sum.innerHTML = nodeLabel(n);
  sum.appendChild(selectButton(() => select(collectIds(n), { zoom: true, label: `${n.type.replace(/^Ifc/, '')} ${n.name}` })));
  det.appendChild(sum);

  for (const c of n.children) det.appendChild(buildNode(c, depth + 1));
  for (const [type, ids] of Object.entries(n.elements).sort((a, b) => a[0].localeCompare(b[0]))) {
    const g = document.createElement('details');
    g.className = 'group';
    const gs = document.createElement('summary');
    gs.innerHTML = `<span class="ty">${esc(type.replace(/^Ifc/, ''))}</span> <span class="count">${fmtInt(ids.length)}</span>`;
    gs.appendChild(selectButton(() => select(ids, { zoom: true, label: `${type} in ${n.name || n.type}` })));
    g.appendChild(gs);
    let loaded = false;
    g.addEventListener('toggle', async () => {
      if (!g.open || loaded) return;
      loaded = true;
      const shown = ids.slice(0, 2000);
      const names = await request('names', { ids: shown });
      const frag = document.createDocumentFragment();
      for (const [id, name] of names) {
        const leaf = document.createElement('div');
        leaf.className = 'leaf';
        leaf.textContent = name || `#${id}`;
        leaf.addEventListener('click', () => select([id], { zoom: true }));
        frag.appendChild(leaf);
      }
      if (ids.length > shown.length) {
        const more = document.createElement('div');
        more.className = 'muted';
        more.textContent = `…and ${fmtInt(ids.length - shown.length)} more`;
        frag.appendChild(more);
      }
      g.appendChild(frag);
    });
    det.appendChild(g);
  }
  return det;
}

function renderTree(tree) {
  const root = $('tab-tree');
  root.innerHTML = '';
  if (!tree) { root.innerHTML = '<div class="empty">No IfcProject found.</div>'; return; }
  root.appendChild(buildNode(tree, 0));
}

// ------------------------------------------------------------ layers (by IFC class)
function renderLayers(classes) {
  const el = $('tab-layers');
  const order = classes.map((c, i) => ({ ...c, i })).sort((a, b) => b.count - a.count);
  el.innerHTML = `<div class="row"><button class="btn small" id="show-all">Show all</button>
    <button class="btn small" id="toggle-align">Toggle alignment</button></div>` +
    order.map((c) => `<label class="layer"><input type="checkbox" data-cls="${c.i}" checked> ${esc(c.name.replace(/^Ifc/, ''))} <span class="count">${fmtInt(c.count)}</span></label>`).join('');
  const apply = () => {
    const hidden = [...el.querySelectorAll('input[data-cls]')].filter((c) => !c.checked).map((c) => Number(c.dataset.cls));
    viewer.setHiddenClasses(hidden);
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

// ------------------------------------------------------------ misc UI
$('fit-btn').addEventListener('click', () => viewer.fitAll());
document.querySelectorAll('.tabs button').forEach((btn) => btn.addEventListener('click', () => {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b === btn));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${btn.dataset.tab}`));
}));
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { select([]); viewer.clearMarker(); }
  if (e.key === 'f' && document.activeElement?.tagName !== 'INPUT') viewer.fitAll();
});
