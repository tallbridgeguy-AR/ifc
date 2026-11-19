import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  sampleHorizontal, makeProfile, project, pointAt, formatStation, parseStation, formatOffset, tickInterval,
} from '../src/alignment.js';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b}, got ${a}`);

test('straight line: projection gives station and signed offset', () => {
  const al = sampleHorizontal([{ type: 'LINE', x: 0, y: 0, dir: 0, r0: 0, r1: 0, length: 100 }], 1);
  al.z = new Float64Array(al.s.length);
  const left = project(al, 40, 5);
  close(left.s, 40, 1e-9);
  close(left.offset, 5, 1e-9, 'left is positive');
  const right = project(al, 60, -3);
  close(right.offset, -3, 1e-9, 'right is negative');
  const before = project(al, -10, 0);
  assert.equal(before.beforeStart, true);
  close(before.s, -10, 1e-9, 'extrapolates before start');
});

test('circular arc: quarter circle lands where geometry says', () => {
  const R = 500;
  const al = sampleHorizontal([{ type: 'CIRCULARARC', x: 0, y: 0, dir: 0, r0: R, r1: R, length: (Math.PI / 2) * R }], 1);
  const n = al.s.length - 1;
  close(al.x[n], R, 1e-6, 'x');
  close(al.y[n], R, 1e-6, 'y');
  close(al.h[n], Math.PI / 2, 1e-12, 'heading');
  // A point at the arc centre is R to the left of every station.
  al.z = new Float64Array(al.s.length);
  const p = project(al, 0, R);
  close(p.offset, R, 0.05);
});

test('clothoid: heading change is L/(2R) and end point matches Fresnel series', () => {
  const L = 150, R = 1500;
  const al = sampleHorizontal([{ type: 'CLOTHOID', x: 0, y: 0, dir: 0, r0: 0, r1: R, length: L }], 1);
  const n = al.s.length - 1;
  close(al.h[n], L / (2 * R), 1e-12);
  // Series for a clothoid starting tangent: x = L - L^5/(40 A^4), y = L^3/(6 A^2) with A^2 = R L.
  const A2 = R * L;
  close(al.x[n], L - L ** 5 / (40 * A2 ** 2) + L ** 9 / (3456 * A2 ** 4), 1e-6, 'x');
  close(al.y[n], L ** 3 / (6 * A2) - L ** 7 / (336 * A2 ** 3), 1e-6, 'y');
});

test('vertical profile: grades and parabolic crest', () => {
  const prof = makeProfile([
    { d0: 0, L: 600, h0: 800, g0: 0.02, g1: 0.02 },
    { d0: 600, L: 600, h0: 812, g0: 0.02, g1: -0.015 },
    { d0: 1200, L: 400, h0: 813.5, g0: -0.015, g1: -0.015 },
  ]);
  close(prof(0), 800, 1e-9);
  close(prof(300), 806, 1e-9);
  close(prof(1200), 813.5, 1e-9, 'end of crest matches next segment');
  close(prof(1600), 807.5, 1e-9);
  close(prof(1700), 806, 1e-9, 'extends at end grade');
  // Crest high point where grade = 0: u = g0 L / (g0 - g1)
  const u = (0.02 * 600) / 0.035;
  assert.ok(prof(600 + u) > prof(600 + u - 5) && prof(600 + u) > prof(600 + u + 5));
});

test('station formatting and parsing', () => {
  assert.equal(formatStation(12540.25, 'ft'), '125+40.25');
  assert.equal(formatStation(10000, 'ft'), '100+00.00');
  assert.equal(formatStation(99.999, 'ft'), '1+00.00');
  assert.equal(formatStation(1254.032, 'm'), '1+254.032');
  assert.equal(formatStation(-50, 'ft'), '-0+50.00');
  assert.equal(parseStation('125+40.25', 'ft'), 12540.25);
  assert.equal(parseStation('1+254.5', 'm'), 1254.5);
  assert.equal(parseStation(' 10500 ', 'ft'), 10500);
  assert.equal(formatOffset(6.2, 'ft'), '6.20 ft LT');
  assert.equal(formatOffset(-6.2, 'ft'), '6.20 ft RT');
  assert.equal(tickInterval(1600, 'ft'), 100);
  assert.equal(tickInterval(20000, 'ft'), 500);
});

test('demo IFC: segments chain together and match the generator', () => {
  const ifc = readFileSync(new URL('../samples/demo-bridge.ifc', import.meta.url), 'utf8');
  const pts = new Map();
  for (const m of ifc.matchAll(/#(\d+)=IFCCARTESIANPOINT\(\(([-\d.E+]+),([-\d.E+]+)\)\);/g)) pts.set(`#${m[1]}`, [Number(m[2]), Number(m[3])]);
  const segs = [...ifc.matchAll(/IFCALIGNMENTHORIZONTALSEGMENT\(\$,\$,(#\d+),([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+),\$,\.(\w+)\.\)/g)]
    .map((m) => ({ x: pts.get(m[1])[0], y: pts.get(m[1])[1], dir: +m[2], r0: +m[3], r1: +m[4], length: +m[5], type: m[6] }));
  assert.equal(segs.length, 5);
  // Integrate each segment alone and check it ends where the next one starts.
  for (let i = 0; i < segs.length - 1; i++) {
    const one = sampleHorizontal([segs[i]], 1);
    const n = one.s.length - 1;
    close(one.x[n], segs[i + 1].x, 0.01, `seg ${i} end x`);
    close(one.y[n], segs[i + 1].y, 0.01, `seg ${i} end y`);
  }
  const al = sampleHorizontal(segs, 6.56);
  close(al.length, 1600, 1e-9);
  const end = pointAt({ ...al, z: null }, 1600);
  close(end.x, 2101161.31, 0.05, 'end x (generator says 2101161.31)');
  close(end.y, 651060.94, 0.05, 'end y (generator says 651060.94)');

  // Every deck slab was placed on the centreline by the generator: offset ≈ 0,
  // and stations should run 325, 375, … along the alignment.
  const pts3 = new Map();
  for (const m of ifc.matchAll(/#(\d+)=IFCCARTESIANPOINT\(\(([-\d.E+]+),([-\d.E+]+),([-\d.E+]+)\)\);/g)) pts3.set(`#${m[1]}`, m.slice(2).map(Number));
  const ax = new Map([...ifc.matchAll(/#(\d+)=IFCAXIS2PLACEMENT3D\((#\d+),/g)].map((m) => [`#${m[1]}`, m[2]]));
  const lp = new Map([...ifc.matchAll(/#(\d+)=IFCLOCALPLACEMENT\([^,]+,(#\d+)\)/g)].map((m) => [`#${m[1]}`, m[2]]));
  const slabs = [...ifc.matchAll(/IFCSLAB\('[^']+',\$,'Deck pour (\d+)',\$,\$,(#\d+),/g)];
  assert.equal(slabs.length, 16);
  al.z = new Float64Array(al.s.length);
  for (const [, k, pl] of slabs) {
    const [x, y] = pts3.get(ax.get(lp.get(pl)));
    const pr = project(al, x, y);
    close(pr.offset, 0, 0.05, `slab ${k} offset`);
    close(pr.s, 300 + 50 * (Number(k) - 1) + 25, 0.05, `slab ${k} station`);
  }
});
