// IFC worker: parses the file with web-ifc (WebAssembly), streams merged geometry
// to the main thread, and answers property / tree / alignment / check queries.
// The file never leaves this browser tab.
//
// web-ifc API surface used (check these first if you change WEBIFC_VERSION):
//   IfcAPI: SetWasmPath, Init, OpenModel, CloseModel, GetModelSchema, StreamAllMeshes,
//           GetGeometry, GetVertexArray, GetIndexArray, GetLine, GetLineType,
//           GetLineIDsWithType, GetNameFromTypeCode, GetCoordinationMatrix
//   properties.getPropertySets
//   type-code constants: IFCPROJECT, IFCRELAGGREGATES, IFCRELNESTS,
//           IFCRELCONTAINEDINSPATIALSTRUCTURE, IFCALIGNMENT, IFCALIGNMENTHORIZONTAL,
//           IFCALIGNMENTVERTICAL, IFCREFERENT (+ any entity named in requirements.json)

import './net-guard.js'; // must stay first
import * as WebIFC from '../vendor/web-ifc/web-ifc-api.js';
import { sampleHorizontal, makeProfile } from './alignment.js';

const api = new WebIFC.IfcAPI();
let ready = null;
let modelID = null;
const typeNameByCode = new Map();
let rel = null; // relationship maps, built once per model

// ---------------------------------------------------------------- helpers
const post = (msg, transfer = []) => self.postMessage(msg, transfer);
const progress = (msg) => post({ type: 'progress', msg });

const num = (v) => {
  if (v == null) return undefined;
  if (typeof v === 'number') return v;
  if (typeof v.value === 'number') return v.value;
  const n = Number(v.value);
  return Number.isFinite(n) ? n : undefined;
};
const str = (v) => (v == null ? '' : typeof v === 'string' ? v : v.value == null ? '' : String(v.value));
const ref = (v) => (v == null ? null : typeof v === 'number' ? v : v.value ?? null);

function toArray(vec) {
  if (!vec) return [];
  if (Array.isArray(vec)) return vec;
  const out = [];
  const n = vec.size();
  for (let i = 0; i < n; i++) out.push(vec.get(i));
  return out;
}
const codeFor = (entityName) => WebIFC[String(entityName).toUpperCase()];
const idsOf = (code) => (code == null ? [] : toArray(api.GetLineIDsWithType(modelID, code)));
function line(id, recursive = false) {
  try { return api.GetLine(modelID, id, recursive); } catch { return null; }
}

// "IFCBRIDGEPART" -> "IfcBridgePart", from the schema namespaces web-ifc exports.
const PRETTY = new Map();
for (const ns of ['IFC4X3', 'IFC4', 'IFC2X3']) {
  for (const k of Object.keys(WebIFC[ns] || {})) if (k.startsWith('Ifc')) PRETTY.set(k.toUpperCase(), k);
}
const typeCodeOf = (id) => { try { return api.GetLineType(modelID, id); } catch { return -1; } };
const isType = (id, code) => code != null && typeCodeOf(id) === code;

/** Pretty IFC class name ("IfcBridgePart") for an entity id, cached per type code. */
function typeNameOf(id) {
  const code = typeCodeOf(id);
  if (code === -1) return 'Unknown';
  if (typeNameByCode.has(code)) return typeNameByCode.get(code);
  let upper = '';
  try { upper = String(api.GetNameFromTypeCode(code) || '').toUpperCase(); } catch { /* older web-ifc */ }
  let name = PRETTY.get(upper);
  if (!name) {
    const ctor = line(id)?.constructor?.name;
    name = ctor && ctor.startsWith('Ifc') ? ctor : upper || `#type${code}`;
  }
  typeNameByCode.set(code, name);
  return name;
}

// ---------------------------------------------------------------- 4x4 matrices (column-major, float64)
const I4 = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function mul(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
}
const T = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const S = (s) => [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1];
// IFC is Z-up; three.js is Y-up. web-ifc emits geometry as (x, y, z) -> (x, z, -y).
const N = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1];
const apply = (m, x, y, z) => [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
];

// ---------------------------------------------------------------- init / open
async function init() {
  if (!ready) {
    ready = (async () => {
      api.SetWasmPath(new URL('../vendor/web-ifc/', import.meta.url).href, true);
      await api.Init(undefined, true); // single-threaded: GitHub Pages can't enable SharedArrayBuffer
    })();
  }
  return ready;
}

async function open(buffer) {
  const t0 = performance.now();
  await init();
  if (modelID !== null) { try { api.CloseModel(modelID); } catch { /* ignore */ } modelID = null; }
  typeNameByCode.clear();
  rel = null;

  progress('Parsing IFC…');
  modelID = api.OpenModel(new Uint8Array(buffer), {
    COORDINATE_TO_ORIGIN: true, // shift state-plane coordinates near 0 in double precision
    CIRCLE_SEGMENTS: 12,
    CIRCLE_SEGMENTS_LOW: 5,
    CIRCLE_SEGMENTS_MEDIUM: 8,
    CIRCLE_SEGMENTS_HIGH: 12,
  });
  buffer = null;
  let schema = '';
  try { schema = api.GetModelSchema(modelID); } catch { /* older web-ifc */ }

  const units = readUnits();
  progress('Building geometry…');
  const geom = streamGeometry();
  progress('Reading bridge structure…');
  rel = buildRelations();
  const tree = buildTree();
  progress('Reading alignments…');
  const align = await readAlignments(units, geom);

  post({
    type: 'loaded',
    schema,
    units,
    classes: geom.classes,
    bbox: geom.bbox,
    tree,
    alignments: align.list,
    mapping: align.mapping,
    mappingNote: align.note,
    stats: { elements: geom.elements, triangles: geom.triangles, seconds: (performance.now() - t0) / 1000 },
  });
}

// ---------------------------------------------------------------- units
function siPrefixFactor(p) {
  return { EXA: 1e18, PETA: 1e15, TERA: 1e12, GIGA: 1e9, MEGA: 1e6, KILO: 1e3, HECTO: 100, DECA: 10,
    DECI: 0.1, CENTI: 0.01, MILLI: 1e-3, MICRO: 1e-6, NANO: 1e-9 }[p] ?? 1;
}
function conversionFactor(unit) {
  const mwu = line(ref(unit.ConversionFactor));
  if (!mwu) return undefined;
  const v = num(mwu.ValueComponent);
  const base = line(ref(mwu.UnitComponent));
  const baseF = base && 'Prefix' in base ? siPrefixFactor(str(base.Prefix)) : 1;
  return v != null ? v * baseF : undefined;
}

function readUnits() {
  const u = { lengthName: 'METRE', stationUnit: 'm', lengthToMeters: 1, displayFactor: 1, angleToRadians: 1 };
  const proj = line(idsOf(WebIFC.IFCPROJECT)[0]);
  const assignment = proj && line(ref(proj.UnitsInContext));
  for (const r of assignment?.Units ?? []) {
    const unit = line(ref(r));
    if (!unit) continue;
    const kind = str(unit.UnitType);
    const isConv = 'ConversionFactor' in unit;
    const name = str(unit.Name).toUpperCase();
    if (kind === 'LENGTHUNIT') {
      if (isConv) {
        const f = conversionFactor(unit) ?? (name.includes('US') ? 1200 / 3937 : 0.3048);
        u.lengthName = name;
        u.lengthToMeters = f;
        if (name.includes('FOOT') || name.includes('FEET')) { u.stationUnit = 'ft'; u.displayFactor = 1; }
        else if (name.includes('INCH')) { u.stationUnit = 'ft'; u.displayFactor = 1 / 12; }
        else { u.stationUnit = 'm'; u.displayFactor = f; }
      } else {
        const pf = siPrefixFactor(str(unit.Prefix));
        u.lengthName = `${str(unit.Prefix)}${name}`;
        u.lengthToMeters = pf;
        u.stationUnit = 'm';
        u.displayFactor = pf; // display metric stations in metres
      }
    } else if (kind === 'PLANEANGLEUNIT') {
      u.angleToRadians = isConv ? conversionFactor(unit) ?? Math.PI / 180 : 1;
    }
  }
  return u;
}

// ---------------------------------------------------------------- geometry
const MAX_CHUNK_VERTS = 1_000_000;
const grow = (a, n) => { const b = new a.constructor(n); b.set(a); return b; };

class Chunk {
  constructor(color) {
    this.color = color;
    this.pos = new Float32Array(3 * 32768);
    this.nrm = new Float32Array(3 * 32768);
    this.idx = new Uint32Array(3 * 65536);
    this.nv = 0;
    this.ni = 0;
    this.ranges = []; // flat [expressID, indexStart, indexCount, classIndex] ...
  }
  reserve(nv, ni) {
    const needV = (this.nv + nv) * 3;
    if (needV > this.pos.length) {
      const cap = Math.max(this.pos.length * 2, needV);
      this.pos = grow(this.pos, cap);
      this.nrm = grow(this.nrm, cap);
    }
    if (this.ni + ni > this.idx.length) this.idx = grow(this.idx, Math.max(this.idx.length * 2, this.ni + ni));
  }
}

function streamGeometry() {
  const chunks = new Map();
  const classIndexByCode = new Map();
  const classes = []; // [{name, count}]
  const seen = new Set();
  const bbox = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  let origin = null;
  let elements = 0, triangles = 0, lastReport = performance.now();

  const flush = (key, chunk) => {
    const positions = chunk.pos.slice(0, chunk.nv * 3);
    const normals = chunk.nrm.slice(0, chunk.nv * 3);
    const indices = chunk.idx.slice(0, chunk.ni);
    const ranges = Uint32Array.from(chunk.ranges);
    post({ type: 'chunk', color: chunk.color, positions, normals, indices, ranges },
      [positions.buffer, normals.buffer, indices.buffer, ranges.buffer]);
    chunks.delete(key);
  };

  const classOf = (id) => {
    let code;
    try { code = api.GetLineType(modelID, id); } catch { code = -1; }
    let ci = classIndexByCode.get(code);
    if (ci === undefined) {
      ci = classes.length;
      classes.push({ name: typeNameOf(id), count: 0 });
      classIndexByCode.set(code, ci);
    }
    return ci;
  };

  api.StreamAllMeshes(modelID, (mesh) => {
    const id = mesh.expressID;
    const ci = classOf(id);
    if (!seen.has(id)) { seen.add(id); classes[ci].count++; elements++; }

    const placed = mesh.geometries;
    const n = placed.size();
    for (let gi = 0; gi < n; gi++) {
      const pg = placed.get(gi);
      const g = api.GetGeometry(modelID, pg.geometryExpressID);
      const verts = api.GetVertexArray(g.GetVertexData(), g.GetVertexDataSize());
      const inds = api.GetIndexArray(g.GetIndexData(), g.GetIndexDataSize());
      const m = pg.flatTransformation;
      if (!origin) origin = [Math.round(m[12]), Math.round(m[13]), Math.round(m[14])];

      const c = pg.color;
      const key = `${Math.round(c.x * 255)},${Math.round(c.y * 255)},${Math.round(c.z * 255)},${Math.round(c.w * 100)}`;
      let chunk = chunks.get(key);
      if (!chunk) { chunk = new Chunk([c.x, c.y, c.z, c.w]); chunks.set(key, chunk); }

      const nv = verts.length / 6, ni = inds.length;
      chunk.reserve(nv, ni);
      const P = chunk.pos, Nn = chunk.nrm, base = chunk.nv;
      for (let i = 0; i < nv; i++) {
        const k = i * 6;
        const x = verts[k], y = verts[k + 1], z = verts[k + 2];
        const wx = m[0] * x + m[4] * y + m[8] * z + m[12] - origin[0];
        const wy = m[1] * x + m[5] * y + m[9] * z + m[13] - origin[1];
        const wz = m[2] * x + m[6] * y + m[10] * z + m[14] - origin[2];
        const o = (base + i) * 3;
        P[o] = wx; P[o + 1] = wy; P[o + 2] = wz;
        if (wx < bbox.min[0]) bbox.min[0] = wx; if (wx > bbox.max[0]) bbox.max[0] = wx;
        if (wy < bbox.min[1]) bbox.min[1] = wy; if (wy > bbox.max[1]) bbox.max[1] = wy;
        if (wz < bbox.min[2]) bbox.min[2] = wz; if (wz > bbox.max[2]) bbox.max[2] = wz;
        const nx = verts[k + 3], ny = verts[k + 4], nz = verts[k + 5];
        let tx = m[0] * nx + m[4] * ny + m[8] * nz;
        let ty = m[1] * nx + m[5] * ny + m[9] * nz;
        let tz = m[2] * nx + m[6] * ny + m[10] * nz;
        const len = Math.hypot(tx, ty, tz) || 1;
        Nn[o] = tx / len; Nn[o + 1] = ty / len; Nn[o + 2] = tz / len;
      }
      const I = chunk.idx, start = chunk.ni;
      for (let k = 0; k < ni; k++) I[start + k] = inds[k] + base;
      chunk.nv += nv;
      chunk.ni += ni;
      triangles += ni / 3;

      const r = chunk.ranges, L = r.length;
      if (L && r[L - 4] === id && r[L - 3] + r[L - 2] === start) r[L - 2] += ni;
      else r.push(id, start, ni, ci);

      if (typeof g.delete === 'function') g.delete();
      if (chunk.nv > MAX_CHUNK_VERTS) flush(key, chunk);
    }

    const now = performance.now();
    if (now - lastReport > 400) { lastReport = now; progress(`Building geometry… ${elements.toLocaleString()} elements`); }
  });

  for (const [key, chunk] of [...chunks]) if (chunk.nv) flush(key, chunk);
  return { classes, bbox, origin: origin || [0, 0, 0], elements, triangles };
}

// ---------------------------------------------------------------- spatial tree
function relMap(code, parentKey, childKey) {
  const map = new Map();
  for (const rid of idsOf(code)) {
    const r = line(rid);
    if (!r) continue;
    const p = ref(r[parentKey]);
    if (p == null) continue;
    const kids = (r[childKey] || []).map(ref).filter((x) => x != null);
    if (map.has(p)) map.get(p).push(...kids); else map.set(p, kids);
  }
  return map;
}

function buildRelations() {
  return {
    aggregates: relMap(WebIFC.IFCRELAGGREGATES, 'RelatingObject', 'RelatedObjects'),
    nests: relMap(WebIFC.IFCRELNESTS, 'RelatingObject', 'RelatedObjects'),
    contains: relMap(WebIFC.IFCRELCONTAINEDINSPATIALSTRUCTURE, 'RelatingStructure', 'RelatedElements'),
  };
}

function buildTree() {
  const projectId = idsOf(WebIFC.IFCPROJECT)[0];
  if (projectId == null) return null;
  const visited = new Set();
  const node = (id) => {
    visited.add(id);
    const l = line(id);
    const n = {
      id,
      type: typeNameOf(id),
      name: str(l?.Name) || str(l?.LongName),
      pdt: str(l?.PredefinedType),
      objectType: str(l?.ObjectType),
      children: [],
      elements: {},
    };
    for (const c of rel.aggregates.get(id) || []) if (!visited.has(c)) n.children.push(node(c));
    for (const e of rel.contains.get(id) || []) {
      // Contained elements that are themselves assemblies get a full node.
      if (rel.aggregates.has(e) && !visited.has(e)) { n.children.push(node(e)); continue; }
      const t = typeNameOf(e);
      (n.elements[t] ||= []).push(e);
    }
    return n;
  };
  return node(projectId);
}

// ---------------------------------------------------------------- alignments
function coords(pointId) {
  const p = line(pointId);
  const c = (p?.Coordinates || []).map(num);
  return [c[0] || 0, c[1] || 0, c[2] || 0];
}
function direction(dirId, fallback) {
  const d = line(dirId);
  const r = (d?.DirectionRatios || []).map(num);
  if (!r.length) return fallback;
  return [r[0] || 0, r[1] || 0, r[2] || 0];
}
function axis2(id) {
  const a = line(id);
  if (!a) return I4();
  const locLine = line(ref(a.Location));
  const loc = locLine && 'Coordinates' in locLine ? coords(ref(a.Location)) : [0, 0, 0];
  const z = a.Axis ? direction(ref(a.Axis), [0, 0, 1]) : [0, 0, 1];
  let x = a.RefDirection ? direction(ref(a.RefDirection), [1, 0, 0]) : [1, 0, 0];
  const zl = Math.hypot(...z) || 1;
  const zn = z.map((v) => v / zl);
  const dot = x[0] * zn[0] + x[1] * zn[1] + x[2] * zn[2];
  x = [x[0] - dot * zn[0], x[1] - dot * zn[1], x[2] - dot * zn[2]];
  const xl = Math.hypot(...x) || 1;
  const xn = x.map((v) => v / xl);
  const yn = [zn[1] * xn[2] - zn[2] * xn[1], zn[2] * xn[0] - zn[0] * xn[2], zn[0] * xn[1] - zn[1] * xn[0]];
  return [...xn, 0, ...yn, 0, ...zn, 0, loc[0], loc[1], loc[2], 1];
}
function placementMatrix(plId, depth = 0) {
  if (plId == null || depth > 64) return I4();
  const pl = line(plId);
  if (!pl || !('RelativePlacement' in pl)) return I4();
  const parent = pl.PlacementRelTo ? placementMatrix(ref(pl.PlacementRelTo), depth + 1) : I4();
  return mul(parent, axis2(ref(pl.RelativePlacement)));
}

const childrenOf = (id) => [...(rel.nests.get(id) || []), ...(rel.aggregates.get(id) || [])];

async function startStationOf(alignmentId) {
  for (const k of childrenOf(alignmentId)) {
    if (!isType(k, WebIFC.IFCREFERENT)) continue;
    try {
      const psets = await api.properties.getPropertySets(modelID, k, true);
      for (const ps of psets) {
        if (str(ps.Name) !== 'Pset_Stationing') continue;
        for (const p of ps.HasProperties || []) {
          const prop = p && p.type === 5 ? line(p.value) : p;
          if (str(prop?.Name) === 'Station') {
            const v = num(prop.NominalValue);
            if (Number.isFinite(v)) return v;
          }
        }
      }
    } catch { /* ignore */ }
  }
  return 0;
}

async function readAlignments(units, geom) {
  const list = [];
  const raw = []; // world raw-unit sample arrays, used for picking the mapping
  for (const aid of idsOf(WebIFC.IFCALIGNMENT)) {
    const a = line(aid);
    const kids = childrenOf(aid);
    const hor = kids.find((k) => isType(k, WebIFC.IFCALIGNMENTHORIZONTAL));
    const ver = kids.find((k) => isType(k, WebIFC.IFCALIGNMENTVERTICAL));
    const params = (parent) =>
      parent == null ? [] : childrenOf(parent).map((sid) => line(ref(line(sid)?.DesignParameters))).filter(Boolean);

    const hsegs = params(hor).map((d) => {
      const p = coords(ref(d.StartPoint));
      return {
        type: str(d.PredefinedType),
        x: p[0], y: p[1],
        dir: (num(d.StartDirection) || 0) * units.angleToRadians,
        r0: num(d.StartRadiusOfCurvature) || 0,
        r1: num(d.EndRadiusOfCurvature) || 0,
        length: num(d.SegmentLength) || 0,
      };
    });
    if (!hsegs.length) {
      list.push({ id: aid, name: str(a?.Name) || `Alignment #${aid}`, unsupported: true });
      continue;
    }
    const vsegs = params(ver).map((d) => ({
      type: str(d.PredefinedType),
      d0: num(d.StartDistAlong), L: num(d.HorizontalLength), h0: num(d.StartHeight),
      g0: num(d.StartGradient), g1: num(d.EndGradient),
    }));

    const step = 2 / (units.lengthToMeters || 1); // ~2 m sample spacing
    const h = sampleHorizontal(hsegs, step);
    const profile = vsegs.length ? makeProfile(vsegs) : null;
    const M = placementMatrix(ref(a?.ObjectPlacement));
    const n = h.s.length;
    const x = new Float64Array(n), y = new Float64Array(n), z = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const w = apply(M, h.x[i], h.y[i], profile ? profile(h.s[i]) : 0);
      x[i] = w[0]; y[i] = w[1]; z[i] = w[2];
    }
    const heading = new Float64Array(n);
    const rot = Math.atan2(M[1], M[0]);
    for (let i = 0; i < n; i++) heading[i] = h.h[i] + rot;

    const entry = {
      id: aid,
      name: str(a?.Name) || `Alignment #${aid}`,
      startStation: await startStationOf(aid),
      length: h.length,
      hasProfile: !!profile,
      segmentTypes: [...new Set(hsegs.map((s) => s.type))],
      s: h.s, x, y, z, h: heading,
    };
    list.push(entry);
    raw.push(entry);
  }

  const { mapping, note } = chooseMapping(raw, units, geom);
  // Alignments without a vertical profile: drape at the model's mid-height so they're visible.
  if (mapping) {
    const inv = invertAffine(mapping);
    const midScene = [(geom.bbox.min[0] + geom.bbox.max[0]) / 2, geom.bbox.min[1], (geom.bbox.min[2] + geom.bbox.max[2]) / 2];
    const rawMid = apply(inv, ...midScene);
    for (const al of raw) if (!al.hasProfile) al.z.fill(rawMid[2]);
  }
  return { list, mapping, note };
}

/**
 * Work out how raw IFC coordinates map into the scene. web-ifc applies a Y-up
 * swap, unit scaling and (with COORDINATE_TO_ORIGIN) a translation whose exact
 * convention has varied between versions — so try the plausible combinations
 * and keep the one that puts the alignment on top of the model geometry.
 */
function chooseMapping(alignments, units, geom) {
  if (!alignments.length || !Number.isFinite(geom.bbox.min[0])) return { mapping: null, note: '' };
  let t = [0, 0, 0];
  try {
    const C = api.GetCoordinationMatrix(modelID);
    if (C && C.length >= 16) t = [C[12], C[13], C[14]];
  } catch { /* older web-ifc */ }
  const o = geom.origin;
  const scales = [...new Set([units.lengthToMeters, 1])];
  const candidates = [];
  for (const s of scales) {
    const base = mul(N, S(s));
    candidates.push(base);
    for (const sign of [1, -1]) {
      candidates.push(mul(T(sign * t[0], sign * t[1], sign * t[2]), base)); // translate in Y-up space
      candidates.push(mul(N, mul(T(sign * t[0], sign * t[1], sign * t[2]), S(s)))); // translate in IFC space
    }
  }
  const c = [0, 1, 2].map((i) => (geom.bbox.min[i] + geom.bbox.max[i]) / 2);
  const diag = Math.hypot(...[0, 1, 2].map((i) => geom.bbox.max[i] - geom.bbox.min[i])) || 1;
  let best = null, bestD = Infinity;
  for (const cand of candidates) {
    const M = mul(T(-o[0], -o[1], -o[2]), cand);
    let d = Infinity;
    for (const al of alignments) {
      const stride = Math.max(1, Math.floor(al.s.length / 400));
      for (let i = 0; i < al.s.length; i += stride) {
        const p = apply(M, al.x[i], al.y[i], al.z[i]);
        d = Math.min(d, Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]));
      }
    }
    if (d < bestD) { bestD = d; best = M; }
  }
  const note = bestD > diag * 3
    ? 'The alignment does not appear to pass near the model geometry; station readouts may be wrong.'
    : '';
  return { mapping: best, note };
}

function invertAffine(m) {
  // Inverse of an affine matrix whose 3x3 part is a rotation times uniform scale.
  const s2 = m[0] * m[0] + m[1] * m[1] + m[2] * m[2];
  const r = [m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0, 0, 0, 0, 1].map((v, i) => (i % 4 === 3 ? v : v / s2));
  r[15] = 1;
  const tx = -(r[0] * m[12] + r[4] * m[13] + r[8] * m[14]);
  const ty = -(r[1] * m[12] + r[5] * m[13] + r[9] * m[14]);
  const tz = -(r[2] * m[12] + r[6] * m[13] + r[10] * m[14]);
  r[12] = tx; r[13] = ty; r[14] = tz;
  return r;
}

// ---------------------------------------------------------------- properties
function display(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(display).join(', ');
  if (typeof v !== 'object') return String(v);
  if (v.type === 5 && typeof v.value === 'number') return `#${v.value}`;
  if ('value' in v) return v.value == null ? '' : String(v.value);
  if (v.expressID != null) return `#${v.expressID}`;
  return '';
}
const VALUE_KEYS = ['NominalValue', 'LengthValue', 'AreaValue', 'VolumeValue', 'CountValue', 'WeightValue', 'TimeValue'];
function propValue(p) {
  for (const k of VALUE_KEYS) if (p[k] != null) return display(p[k]);
  if (p.EnumerationValues) return display(p.EnumerationValues);
  if (p.ListValues) return display(p.ListValues);
  if (p.LowerBoundValue != null || p.UpperBoundValue != null) return `${display(p.LowerBoundValue)} – ${display(p.UpperBoundValue)}`;
  return '';
}
function simplifyPset(ps) {
  const items = ps.HasProperties || ps.Quantities || [];
  return {
    name: str(ps.Name) || '(unnamed)',
    kind: ps.Quantities ? 'quantities' : 'properties',
    props: items
      .map((p) => (p && p.type === 5 && typeof p.value === 'number' ? line(p.value) : p))
      .filter(Boolean)
      .map((p) => ({ name: str(p.Name), value: propValue(p) })),
  };
}

async function props(id) {
  const l = line(id) || {};
  const attrs = [];
  for (const [k, v] of Object.entries(l)) {
    if (k === 'expressID' || k === 'type' || v == null) continue;
    const d = display(v);
    if (d !== '') attrs.push({ name: k, value: d });
  }
  let psets = [];
  try { psets = await api.properties.getPropertySets(modelID, id, true, true); } catch { /* ignore */ }
  return { id, type: typeNameOf(id), name: str(l.Name), attrs, psets: psets.map(simplifyPset) };
}

// ---------------------------------------------------------------- requirement checks
async function check(rules) {
  const psetCache = new Map();
  const psetsOf = async (id) => {
    if (!psetCache.has(id)) {
      let ps = [];
      try { ps = (await api.properties.getPropertySets(modelID, id, true, true)).map(simplifyPset); } catch { /* ignore */ }
      psetCache.set(id, ps);
    }
    return psetCache.get(id);
  };
  const results = [];
  for (const rule of rules) {
    const code = codeFor(rule.entity);
    const ids = idsOf(code);
    const failing = [];
    for (const id of ids) {
      let ok = false;
      if (rule.attribute) {
        const v = str(line(id)?.[rule.attribute]);
        ok = v !== '' && v !== 'NOTDEFINED' && (!rule.values || rule.values.includes(v));
      } else if (rule.pset && rule.property) {
        const ps = (await psetsOf(id)).find((p) => p.name === rule.pset);
        const prop = ps?.props.find((p) => p.name === rule.property);
        ok = !!prop && prop.value !== '' && (!rule.values || rule.values.includes(prop.value));
      }
      if (!ok) failing.push(id);
    }
    results.push({ ...rule, known: code != null, total: ids.length, failing });
  }
  return results;
}

// ---------------------------------------------------------------- message loop
self.onmessage = async (e) => {
  const m = e.data;
  try {
    switch (m.cmd) {
      case 'open':
        await open(m.buffer);
        break;
      case 'props':
        post({ type: 'reply', reqId: m.reqId, data: await props(m.id) });
        break;
      case 'names':
        post({ type: 'reply', reqId: m.reqId, data: m.ids.map((id) => { const l = line(id); return [id, str(l?.Name) || str(l?.Tag)]; }) });
        break;
      case 'check':
        post({ type: 'reply', reqId: m.reqId, data: await check(m.rules) });
        break;
    }
  } catch (err) {
    console.error(err);
    post({ type: 'error', reqId: m.reqId, message: err?.message || String(err) });
  }
};
