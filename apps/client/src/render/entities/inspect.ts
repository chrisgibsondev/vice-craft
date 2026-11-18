/** Dev-only GLB inspector (used by demo.ts ?inspect=1): raw models side by side with axes, plus a JSON dump. */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const IDS = ['car_compact', 'car_sedan', 'car_sports', 'car_pickup', 'motorcycle', 'police_car', 'delivery_van', 'motorboat'];

export async function runInspect(canvas: HTMLCanvasElement, hud: HTMLElement, params: URLSearchParams) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x8899aa);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x666666, 2.2), new THREE.DirectionalLight(0xffffff, 2));
  const loader = new GLTFLoader();
  const report: Record<string, unknown> = {};
  const only = params.get('only');
  const ids = only ? [only] : IDS;
  let x = 0;
  for (const id of ids) {
    const g = await loader.loadAsync(`/models/${id}.glb`);
    const root = g.scene;
    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    const meshes: unknown[] = [];
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const b = new THREE.Box3().setFromObject(m);
      const mat = m.material as THREE.MeshStandardMaterial;
      meshes.push({
        n: m.name, mat: mat.name, col: '#' + mat.color.getHexString(), map: !!mat.map, vc: !!m.geometry.attributes.color,
        verts: m.geometry.attributes.position.count, min: b.min.toArray().map((v) => +v.toFixed(2)), max: b.max.toArray().map((v) => +v.toFixed(2)),
      });
    });
    // dominant colours (vertex colours, or texture sampled at vertex uvs)
    const hist = new Map<string, number>();
    const cv = document.createElement('canvas'); const cx2 = cv.getContext('2d', { willReadFrequently: true })!;
    root.traverse((o) => {
      const m = o as THREE.Mesh; if (!m.isMesh) return;
      const mat = m.material as THREE.MeshStandardMaterial; const g = m.geometry;
      const col = g.attributes.color, uv = g.attributes.uv; const n = g.attributes.position.count;
      let img: ImageBitmap | HTMLImageElement | null = null;
      if (mat.map?.image) { img = mat.map.image as HTMLImageElement; cv.width = img.width; cv.height = img.height; cx2.drawImage(img as CanvasImageSource, 0, 0); }
      for (let i = 0; i < n; i++) {
        let c = new THREE.Color(mat.color);
        if (col) { const vc = new THREE.Color(col.getX(i), col.getY(i), col.getZ(i)); c = vc; }
        else if (img && uv) { const px = cx2.getImageData(Math.min(img.width - 1, Math.floor(uv.getX(i) * img.width)), Math.min(img.height - 1, Math.floor((1 - uv.getY(i)) * img.height)), 1, 1).data; c = new THREE.Color().setRGB(px[0] / 255, px[1] / 255, px[2] / 255, THREE.SRGBColorSpace); }
        const hex = '#' + c.getHexString(THREE.SRGBColorSpace);
        hist.set(hex, (hist.get(hex) ?? 0) + 1);
      }
    });
    const top = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => k + ':' + v).join(' ');
    report[id] = { top, size: size.toArray().map((v) => +v.toFixed(2)), min: box.min.toArray().map((v) => +v.toFixed(2)), meshes };
    const wrap = new THREE.Group();
    wrap.add(root);
    const s = 6 / Math.max(size.x, size.y, size.z);
    wrap.scale.setScalar(s);
    root.position.sub(box.getCenter(new THREE.Vector3()));
    wrap.position.set(x, 0, 0);
    x += 8;
    scene.add(wrap);
    const axes = new THREE.AxesHelper(3.5); axes.position.set(wrap.position.x, -3.2, 0); scene.add(axes);
  }
  (window as unknown as { __report: unknown }).__report = report;
  const cam = new THREE.PerspectiveCamera(40, canvas.clientWidth / canvas.clientHeight, 0.1, 500);
  const view = params.get('view') ?? 'iso';
  const cx = (x - 8) / 2;
  const dist = ids.length === 1 ? 14 : 60;
  if (view === 'side') cam.position.set(cx + dist, 0, 0.001); // look along -x
  else if (view === 'top') cam.position.set(cx, dist, 0.001);
  else if (view === 'front') cam.position.set(cx, 0, dist);
  else cam.position.set(cx + dist * 0.7, dist * 0.5, dist * 0.7);
  cam.lookAt(cx, 0, 0);
  if (view === 'quad') {
    renderer.setScissorTest(true);
    const W = canvas.clientWidth, H = canvas.clientHeight;
    const corners = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
    corners.forEach(([sx, sz], i) => {
      const vx = (i % 2) * W / 2, vy = (i < 2 ? 1 : 0) * H / 2;
      renderer.setViewport(vx, vy, W / 2, H / 2); renderer.setScissor(vx, vy, W / 2, H / 2);
      cam.aspect = 1; cam.updateProjectionMatrix();
      cam.position.set(cx + sx * 9, 7, sz * 9); cam.lookAt(cx, 0, 0);
      renderer.render(scene, cam);
    });
  } else renderer.render(scene, cam);
  hud.textContent = 'inspect ' + ids.join(',') + ' view=' + view + ' (red=x green=y blue=z)';
}
