import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

const HIGHLIGHT = 0xff9f1c;
const ALIGN = 0xd62828;

export class Viewer {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);
    this.canvas = this.renderer.domElement;

    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = 'label-layer';
    container.appendChild(this.labels.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xe9edf2);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1e6);
    this.camera.position.set(50, 40, 50);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a94a3, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(0.6, 1, 0.4);
    this.scene.add(sun);

    this.modelGroup = new THREE.Group();
    this.alignGroup = new THREE.Group();
    this.highlightGroup = new THREE.Group();
    this.markerGroup = new THREE.Group();
    this.scene.add(this.modelGroup, this.alignGroup, this.highlightGroup, this.markerGroup);

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.screenSpacePanning = true;
    this.controls.addEventListener('change', () => this.requestRender());
    // Show the rotation pivot while orbiting; any user input cancels a camera glide.
    this.controls.addEventListener('start', () => {
      if (this._anim) { cancelAnimationFrame(this._anim); this._anim = 0; }
      this.showPivot(this.controls.target, 0);
    });
    this.controls.addEventListener('end', () => this.hidePivot(400));

    this.raycaster = new THREE.Raycaster();
    this.meshes = [];
    this.materials = new Map();
    this.box = new THREE.Box3();
    this.vis = { hiddenClasses: new Set(), hiddenIds: new Set(), isolate: null, ghost: false };
    this.selected = [];
    this.M = null;
    this.Minv = null;

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  // ------------------------------------------------------------ rendering
  resize() {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }
  requestRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this.renderer.render(this.scene, this.camera);
      this.labels.render(this.scene, this.camera);
    });
  }

  clear() {
    for (const mesh of this.meshes) { mesh.geometry.dispose(); mesh.userData.ghost.geometry.dispose(); }
    for (const m of this.materials.values()) m.dispose();
    this.modelGroup.clear();
    this.meshes = [];
    this.materials.clear();
    this.box.makeEmpty();
    this.vis = { hiddenClasses: new Set(), hiddenIds: new Set(), isolate: null, ghost: false };
    this.clearAlignment();
    this.highlight([]);
    this.clearMarker();
    this.requestRender();
  }

  // ------------------------------------------------------------ model geometry
  materialFor(color) {
    const [r, g, b, a] = color;
    const key = color.map((v) => v.toFixed(3)).join(',');
    if (!this.materials.has(key)) {
      const mat = new THREE.MeshLambertMaterial({
        color: new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace),
        side: THREE.DoubleSide,
        transparent: a < 0.999,
        opacity: a,
        depthWrite: a >= 0.999,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      });
      this.materials.set(key, mat);
    }
    return this.materials.get(key);
  }

  addChunk(c) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(c.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(c.normals, 3));
    g.setIndex(new THREE.BufferAttribute(c.indices, 1));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, this.materialFor(c.color));
    mesh.matrixAutoUpdate = false;

    // Ghost twin: shares vertex and index buffers, draws a different slice of the index.
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', g.attributes.position);
    gg.setAttribute('normal', g.attributes.normal);
    gg.setIndex(g.index);
    gg.boundingBox = g.boundingBox;
    gg.boundingSphere = g.boundingSphere;
    const ghost = new THREE.Mesh(gg, this.ghostMaterial);
    ghost.matrixAutoUpdate = false;
    ghost.renderOrder = 2;
    ghost.visible = false;

    mesh.userData = { ranges: c.ranges, visCount: c.indices.length, ghostCount: 0, ghost };
    this.modelGroup.add(mesh, ghost);
    this.meshes.push(mesh);
    this.box.union(g.boundingBox);
    this.requestRender();
  }

  get ghostMaterial() {
    if (!this._ghostMat) {
      this._ghostMat = new THREE.MeshLambertMaterial({
        color: 0x9aa7b6, transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide,
      });
    }
    return this._ghostMat;
  }

  /** Map a triangle back to its IFC element via the chunk's range table. */
  idAt(mesh, faceIndex) {
    const r = mesh.userData.ranges;
    const target = faceIndex * 3;
    let lo = 0, hi = r.length / 4 - 1;
    if (hi < 0) return null;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (r[mid * 4 + 1] <= target) lo = mid; else hi = mid - 1;
    }
    return { id: r[lo * 4], cls: r[lo * 4 + 3] };
  }

  pick(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.meshes.filter((m) => m.visible), false);
    for (const h of hits) {
      if (h.object.material.opacity < 0.25) continue;
      const hit = this.idAt(h.object, h.faceIndex);
      if (hit) return { ...hit, point: h.point.clone() };
    }
    return null;
  }

  /**
   * Visibility state:
   *   hiddenClasses  IFC class indices switched off in Layers (always fully hidden)
   *   hiddenIds      elements the user hid
   *   isolate        Set of ids to show exclusively, or null
   *   ghost          draw isolated-out / user-hidden elements as faint context
   * Each chunk's index buffer is reordered in place into [visible | ghost | hidden]
   * so a single buffer serves the solid mesh, its ghost twin, and picking.
   */
  setVisibility(patch) {
    Object.assign(this.vis, patch);
    const { hiddenClasses, hiddenIds, isolate, ghost } = this.vis;
    const stateOf = (id, cls) => {
      if (hiddenClasses.has(cls)) return 2;
      if (hiddenIds.has(id) || (isolate && !isolate.has(id))) return ghost ? 1 : 2;
      return 0;
    };
    for (const mesh of this.meshes) {
      const r = mesh.userData.ranges;
      const indexAttr = mesh.geometry.index;
      const arr = indexAttr.array;
      const lists = [[], [], []];
      const counts = [0, 0, 0];
      for (let i = 0; i < r.length; i += 4) {
        const st = stateOf(r[i], r[i + 3]);
        lists[st].push(i);
        counts[st] += r[i + 2];
      }
      const tmp = new Uint32Array(arr.length);
      const out = new Uint32Array(r.length);
      let pos = 0, o = 0;
      for (const list of lists) {
        for (const i of list) {
          const start = r[i + 1], count = r[i + 2];
          tmp.set(arr.subarray(start, start + count), pos);
          out[o] = r[i]; out[o + 1] = pos; out[o + 2] = count; out[o + 3] = r[i + 3];
          pos += count; o += 4;
        }
      }
      arr.set(tmp);
      indexAttr.needsUpdate = true;
      mesh.userData.ranges = out;
      mesh.userData.visCount = counts[0];
      mesh.userData.ghostCount = counts[1];
      mesh.geometry.setDrawRange(0, counts[0]);
      mesh.visible = counts[0] > 0;
      const gm = mesh.userData.ghost;
      gm.geometry.setDrawRange(counts[0], counts[1]);
      gm.visible = counts[1] > 0;
    }
    this.highlight(this.selected);
  }

  /** Bounding box of what is currently drawn solid. */
  visibleBox() {
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    for (const mesh of this.meshes) {
      const n = mesh.userData.visCount;
      if (!n) continue;
      if (n === mesh.geometry.index.count) { box.union(mesh.geometry.boundingBox); continue; }
      const idx = mesh.geometry.index.array, P = mesh.geometry.attributes.position.array;
      const stride = n > 300000 ? 9 : 1;
      for (let k = 0; k < n; k += stride) { const j = idx[k] * 3; box.expandByPoint(v.set(P[j], P[j + 1], P[j + 2])); }
    }
    return box.isEmpty() ? null : box;
  }

  /**
   * Highlight elements. Returns their bounding box and a vertex sample
   * (scene coordinates) used for station-range readouts.
   */
  highlight(ids) {
    for (const m of this.highlightGroup.children) { m.geometry.dispose(); m.material.dispose(); }
    this.highlightGroup.clear();
    this.selected = ids;
    const set = new Set(ids);
    const box = new THREE.Box3();
    const samples = [];
    let triangles = 0;
    if (set.size) {
      for (const mesh of this.meshes) {
        const { ranges } = mesh.userData;
        const limit = mesh.userData.visCount + mesh.userData.ghostCount; // skip fully hidden
        const index = mesh.geometry.index.array;
        const P = mesh.geometry.attributes.position.array;
        const Nn = mesh.geometry.attributes.normal.array;
        let count = 0;
        for (let i = 0; i < ranges.length; i += 4) if (ranges[i + 1] < limit && set.has(ranges[i])) count += ranges[i + 2];
        if (!count) continue;
        const pos = new Float32Array(count * 3), nrm = new Float32Array(count * 3);
        let o = 0;
        for (let i = 0; i < ranges.length; i += 4) {
          if (ranges[i + 1] >= limit || !set.has(ranges[i])) continue;
          const start = ranges[i + 1], end = start + ranges[i + 2];
          for (let k = start; k < end; k++) {
            const v = index[k] * 3;
            pos[o] = P[v]; pos[o + 1] = P[v + 1]; pos[o + 2] = P[v + 2];
            nrm[o] = Nn[v]; nrm[o + 1] = Nn[v + 1]; nrm[o + 2] = Nn[v + 2];
            o += 3;
          }
        }
        triangles += count / 3;
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
        g.computeBoundingBox();
        box.union(g.boundingBox);
        const stride = Math.max(1, Math.floor(count / 1500)) * 3;
        for (let k = 0; k < pos.length; k += stride) samples.push(pos[k], pos[k + 1], pos[k + 2]);
        const mat = new THREE.MeshLambertMaterial({
          color: HIGHLIGHT, emissive: 0x6b3a00, side: THREE.DoubleSide,
          polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
        });
        this.highlightGroup.add(new THREE.Mesh(g, mat));
      }
    }
    this.selectionBox = box.isEmpty() ? null : box;
    this.requestRender();
    return { box: this.selectionBox, samples: Float32Array.from(samples), triangles };
  }

  // ------------------------------------------------------------ camera
  fitBox(box, factor = 1.15) {
    if (!box || box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length() || 10;
    const dist = (size / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2))) * factor;
    const dir = this.camera.position.clone().sub(this.controls.target);
    if (dir.lengthSq() < 1e-9) dir.set(1, 0.7, 1);
    dir.normalize();
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.controls.target.copy(center);
    this.camera.near = Math.max(dist / 5000, 0.01);
    this.camera.far = dist * 500;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.requestRender();
  }
  fitAll() {
    if (this.box.isEmpty()) return;
    this.camera.position.set(1, 0.8, 1);
    this.controls.target.set(0, 0, 0);
    this.fitBox(this.box);
  }
  /** Fly to a point, keeping the current viewing direction. */
  lookAt(point, distance) {
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.controls.target.copy(point);
    this.camera.position.copy(point).addScaledVector(dir, distance);
    this.controls.update();
    this.requestRender();
  }
  /**
   * Make a point the new centre of rotation: glide the camera to look at it and
   * move in a bit (never further out). `size` is the element's size, so large
   * elements like a whole deck aren't zoomed into too far.
   */
  focusOn(point, size = 0) {
    const cam = this.camera.position;
    const curDist = cam.distanceTo(point);
    const want = Math.max(size * 1.8, this.modelSize() / 200, 1);
    const dist = Math.min(curDist, Math.max(curDist * 0.55, want));
    const dir = cam.clone().sub(point).normalize();
    this.animateView(point.clone(), point.clone().addScaledVector(dir, dist));
    this.showPivot(point, 1600);
  }

  animateView(toTarget, toPos, ms = 450) {
    if (this._anim) cancelAnimationFrame(this._anim);
    const t0 = performance.now();
    const fromT = this.controls.target.clone(), fromP = this.camera.position.clone();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / ms);
      const e = 1 - (1 - k) ** 3; // ease-out
      this.controls.target.lerpVectors(fromT, toTarget, e);
      this.camera.position.lerpVectors(fromP, toPos, e);
      this.controls.update();
      this._anim = k < 1 ? requestAnimationFrame(step) : 0;
    };
    this._anim = requestAnimationFrame(step);
  }

  /** Small round marker at the orbit pivot. hideAfter=0 keeps it until hidePivot(). */
  showPivot(point, hideAfter = 0) {
    if (!this._pivot) {
      const dot = document.createElement('div');
      dot.className = 'pivot-dot';
      this._pivot = new CSS2DObject(dot);
      this._pivot.renderOrder = 30;
      this.scene.add(this._pivot);
    }
    clearTimeout(this._pivotTimer);
    this._pivot.position.copy(point);
    this._pivot.visible = true;
    if (hideAfter) this.hidePivot(hideAfter);
    this.requestRender();
  }
  hidePivot(delay = 0) {
    clearTimeout(this._pivotTimer);
    this._pivotTimer = setTimeout(() => {
      if (this._pivot) { this._pivot.visible = false; this.requestRender(); }
    }, delay);
  }

  modelSize() {
    return this.box.isEmpty() ? 100 : this.box.getSize(new THREE.Vector3()).length();
  }

  // ------------------------------------------------------------ alignment
  setMapping(mapping) {
    this.M = mapping ? new THREE.Matrix4().fromArray(mapping) : null;
    this.Minv = this.M ? this.M.clone().invert() : null;
  }
  rawToScene(x, y, z) { return new THREE.Vector3(x, y, z).applyMatrix4(this.M); }
  sceneToRaw(v) { return v.clone().applyMatrix4(this.Minv); }
  sceneXYZToRaw(x, y, z) { return new THREE.Vector3(x, y, z).applyMatrix4(this.Minv); }

  clearAlignment() {
    for (const o of this.alignGroup.children) { o.geometry?.dispose(); o.material?.dispose(); }
    this.alignGroup.clear();
    this.requestRender();
  }

  /**
   * Draw an alignment with station ticks.
   * @param al        alignment from the worker (raw-unit samples)
   * @param ticks     [{s, label}] in raw distance-along units
   */
  drawAlignment(al, ticks) {
    this.clearAlignment();
    if (!this.M || !al?.s) return;
    const n = al.s.length;
    const pts = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const v = this.rawToScene(al.x[i], al.y[i], al.z[i]);
      pts[i * 3] = v.x; pts[i * 3 + 1] = v.y; pts[i * 3 + 2] = v.z;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
    const solid = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: ALIGN }));
    const ghost = new THREE.Line(geo.clone(), new THREE.LineBasicMaterial({ color: ALIGN, transparent: true, opacity: 0.35, depthTest: false }));
    ghost.renderOrder = 10;
    this.alignGroup.add(solid, ghost);

    const tickLen = Math.max(1, this.modelSize() / 120);
    const tickPts = [];
    for (const t of ticks) {
      const p = t.point;
      const a = this.rawToScene(p.x, p.y, p.z);
      const b = this.rawToScene(p.x - Math.sin(p.heading), p.y + Math.cos(p.heading), p.z); // 1 unit to the left
      const left = b.sub(a).normalize().multiplyScalar(tickLen);
      tickPts.push(a.x - left.x, a.y - left.y, a.z - left.z, a.x + left.x, a.y + left.y, a.z + left.z);
      const div = document.createElement('div');
      div.className = 'sta-label';
      div.textContent = t.label;
      const lbl = new CSS2DObject(div);
      lbl.position.set(a.x + left.x * 1.6, a.y + left.y * 1.6, a.z + left.z * 1.6);
      this.alignGroup.add(lbl);
    }
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.Float32BufferAttribute(tickPts, 3));
    const tl = new THREE.LineSegments(tg, new THREE.LineBasicMaterial({ color: ALIGN, transparent: true, opacity: 0.8, depthTest: false }));
    tl.renderOrder = 11;
    this.alignGroup.add(tl);
    this.requestRender();
  }

  setAlignmentVisible(v) { this.alignGroup.visible = v; this.requestRender(); }

  clearMarker() {
    for (const o of this.markerGroup.children) { o.geometry?.dispose(); o.material?.dispose(); }
    this.markerGroup.clear();
    this.requestRender();
  }
  /** Dashed line from the alignment (station point) out to a picked point. */
  showOffsetMarker(onAlign, picked) {
    this.clearMarker();
    const g = new THREE.BufferGeometry().setFromPoints([onAlign, picked]);
    const line = new THREE.Line(g, new THREE.LineDashedMaterial({
      color: 0x1d3557, dashSize: this.modelSize() / 300, gapSize: this.modelSize() / 500, depthTest: false,
    }));
    line.computeLineDistances();
    line.renderOrder = 12;
    const dotGeo = new THREE.BufferGeometry().setFromPoints([onAlign, picked]);
    const dots = new THREE.Points(dotGeo, new THREE.PointsMaterial({ color: 0x1d3557, size: 7, sizeAttenuation: false, depthTest: false }));
    dots.renderOrder = 13;
    this.markerGroup.add(line, dots);
    this.requestRender();
  }
}
