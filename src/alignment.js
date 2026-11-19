// Pure alignment math — no three.js, no web-ifc — so it runs in the worker,
// on the main thread, and under `node --test`.
//
// All lengths here are in the IFC file's own project length unit ("raw" units,
// e.g. US survey feet or metres). Angles are radians.

/**
 * Sample an IFC4.3 horizontal alignment (IfcAlignmentHorizontalSegment list).
 *
 * Curvature is treated as varying linearly from 1/StartRadius to 1/EndRadius
 * over the segment. That is exact for LINE, CIRCULARARC and CLOTHOID, and a
 * close approximation for the less common transition types (cubic, Bloss,
 * sine, cosine, Viennese bend, Helmert).
 *
 * Each segment restarts from its own StartPoint, so small integration error
 * never accumulates along a long alignment.
 *
 * @param {Array<{type:string,x:number,y:number,dir:number,r0:number,r1:number,length:number}>} segments
 * @param {number} step  target spacing between samples (raw units)
 * @returns {{s:Float64Array,x:Float64Array,y:Float64Array,h:Float64Array,length:number}}
 */
export function sampleHorizontal(segments, step) {
  const S = [], X = [], Y = [], H = [];
  let dist = 0;

  const push = (s, x, y, h) => {
    const n = S.length;
    if (n && Math.abs(S[n - 1] - s) < 1e-9) { X[n - 1] = x; Y[n - 1] = y; H[n - 1] = h; return; }
    S.push(s); X.push(x); Y.push(y); H.push(h);
  };

  for (const seg of segments) {
    const L = seg.length;
    if (!(L > 0)) continue;
    const k0 = seg.r0 ? 1 / seg.r0 : 0;
    const k1 = seg.r1 ? 1 / seg.r1 : 0;
    const heading = (u) => seg.dir + k0 * u + ((k1 - k0) * u * u) / (2 * L);
    const isLine = k0 === 0 && k1 === 0;
    const n = isLine ? Math.max(1, Math.ceil(L / (step * 8))) : Math.max(2, Math.ceil(L / step));
    const ds = L / n;

    let px = seg.x, py = seg.y;
    push(dist, px, py, heading(0));
    for (let i = 1; i <= n; i++) {
      const u0 = (i - 1) * ds, u1 = i * ds, um = (u0 + u1) / 2;
      const a0 = heading(u0), am = heading(um), a1 = heading(u1);
      // Simpson's rule on the unit tangent.
      px += (ds / 6) * (Math.cos(a0) + 4 * Math.cos(am) + Math.cos(a1));
      py += (ds / 6) * (Math.sin(a0) + 4 * Math.sin(am) + Math.sin(a1));
      push(dist + u1, px, py, a1);
    }
    dist += L;
  }
  return {
    s: Float64Array.from(S), x: Float64Array.from(X), y: Float64Array.from(Y), h: Float64Array.from(H),
    length: dist,
  };
}

/**
 * Build an elevation function from IfcAlignmentVerticalSegment data.
 * Parabolic arcs are exact; circular vertical arcs are approximated by the
 * equivalent parabola (differences are negligible at highway grades).
 *
 * @param {Array<{d0:number,L:number,h0:number,g0:number,g1:number,type?:string}>} vsegs
 * @returns {(d:number)=>number}
 */
export function makeProfile(vsegs) {
  const segs = vsegs.filter((v) => Number.isFinite(v.d0) && Number.isFinite(v.h0)).sort((a, b) => a.d0 - b.d0);
  if (!segs.length) return () => 0;
  const at = (seg, u) => {
    const L = seg.L || 0;
    const g0 = seg.g0 || 0;
    const g1 = Number.isFinite(seg.g1) ? seg.g1 : g0;
    return L > 0 ? seg.h0 + g0 * u + ((g1 - g0) * u * u) / (2 * L) : seg.h0 + g0 * u;
  };
  return (d) => {
    if (d <= segs[0].d0) return segs[0].h0 + (segs[0].g0 || 0) * (d - segs[0].d0);
    let lo = 0, hi = segs.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (segs[mid].d0 <= d) lo = mid; else hi = mid - 1; }
    const seg = segs[lo];
    const L = seg.L || 0;
    const u = d - seg.d0;
    if (u <= L) return at(seg, u);
    // Past the end of this segment (gap, or end of profile): extend at the end grade.
    const g1 = Number.isFinite(seg.g1) ? seg.g1 : seg.g0 || 0;
    return at(seg, L) + g1 * (u - L);
  };
}

/**
 * Project a plan point onto a sampled alignment.
 * Coarse search over every Nth sample, then exact projection on nearby chords.
 *
 * @returns {{s:number,offset:number,x:number,y:number,z:number,heading:number,beforeStart:boolean,afterEnd:boolean,dist:number}|null}
 *   offset > 0 is LEFT of the alignment looking up-station.
 */
export function project(al, px, py) {
  const n = al.s.length;
  if (n < 2) return null;
  const stride = n > 400 ? 16 : 1;
  let best = 0, bestD = Infinity;
  for (let i = 0; i < n; i += stride) {
    const dx = al.x[i] - px, dy = al.y[i] - py, d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = i; }
  }
  {
    const dx = al.x[n - 1] - px, dy = al.y[n - 1] - py, d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = n - 1; }
  }
  const lo = Math.max(0, best - 2 * stride);
  const hi = Math.min(n - 1, best + 2 * stride);

  let res = null;
  bestD = Infinity;
  for (let i = lo; i < hi; i++) {
    const x0 = al.x[i], y0 = al.y[i], dx = al.x[i + 1] - x0, dy = al.y[i + 1] - y0;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) continue;
    const tRaw = ((px - x0) * dx + (py - y0) * dy) / len2;
    const t = Math.min(1, Math.max(0, tRaw));
    const fx = x0 + t * dx, fy = y0 + t * dy;
    const d = (px - fx) ** 2 + (py - fy) ** 2;
    if (d < bestD) {
      bestD = d;
      const len = Math.sqrt(len2);
      const z = al.z ? al.z[i] + t * (al.z[i + 1] - al.z[i]) : 0;
      // Extrapolate station along the end chords for points beyond the ends.
      const tS = (i === 0 && tRaw < 0) || (i === n - 2 && tRaw > 1) ? tRaw : t;
      const sAt = al.s[i] + tS * (al.s[i + 1] - al.s[i]);
      res = {
        s: sAt,
        offset: (dx * (py - y0) - dy * (px - x0)) / len,
        x: fx, y: fy, z,
        heading: Math.atan2(dy, dx),
        beforeStart: i === 0 && tRaw < 0,
        afterEnd: i === n - 2 && tRaw > 1,
        dist: Math.sqrt(d),
      };
    }
  }
  return res;
}

/** Point on the alignment at distance s (clamped to the ends). */
export function pointAt(al, s) {
  const n = al.s.length;
  if (s <= al.s[0]) return { x: al.x[0], y: al.y[0], z: al.z ? al.z[0] : 0, heading: al.h[0] };
  if (s >= al.s[n - 1]) return { x: al.x[n - 1], y: al.y[n - 1], z: al.z ? al.z[n - 1] : 0, heading: al.h[n - 1] };
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (al.s[mid] <= s) lo = mid; else hi = mid; }
  const t = (s - al.s[lo]) / (al.s[hi] - al.s[lo] || 1);
  const lerp = (a) => a[lo] + t * (a[hi] - a[lo]);
  return { x: lerp(al.x), y: lerp(al.y), z: al.z ? lerp(al.z) : 0, heading: lerp(al.h) };
}

/** 12540.25 ft → "125+40.25"; 1254.032 m → "1+254.032". */
export function formatStation(value, unit) {
  if (!Number.isFinite(value)) return '—';
  const imperial = unit === 'ft';
  const block = imperial ? 100 : 1000;
  const dec = imperial ? 2 : 3;
  const sign = value < 0 ? '-' : '';
  const abs = Math.round(Math.abs(value) * 10 ** dec) / 10 ** dec;
  const major = Math.floor(abs / block + 1e-9);
  const rem = abs - major * block;
  const width = (imperial ? 2 : 3) + 1 + dec;
  return `${sign}${major}+${Math.max(0, rem).toFixed(dec).padStart(width, '0')}`;
}

/** "105+00" → 10500 (ft) ; "1+254.5" → 1254.5 (m) ; "10500" → 10500. */
export function parseStation(text, unit) {
  const t = String(text).trim().replace(/\s+/g, '');
  if (!t) return NaN;
  if (!t.includes('+')) return Number(t);
  const neg = t.startsWith('-');
  const [a, b] = t.replace(/^-/, '').split('+');
  const v = Number(a) * (unit === 'ft' ? 100 : 1000) + Number(b || 0);
  return neg ? -v : v;
}

/** 6.2 → "6.20 ft LT"; -6.2 → "6.20 ft RT". */
export function formatOffset(off, unit) {
  if (!Number.isFinite(off)) return '—';
  if (Math.abs(off) < 0.005) return `0.00 ${unit} CL`;
  return `${Math.abs(off).toFixed(2)} ${unit} ${off > 0 ? 'LT' : 'RT'}`;
}

/** Pick a station-tick spacing that gives at most ~60 ticks. */
export function tickInterval(length, unit) {
  const steps = unit === 'ft' ? [100, 500, 1000, 5000, 10000] : [20, 100, 500, 1000, 5000];
  return steps.find((st) => length / st <= 60) ?? steps[steps.length - 1];
}
