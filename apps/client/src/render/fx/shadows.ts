/**
 * Stabilised sun/moon shadow map: a single orthographic DirectionalLight shadow that follows
 * the camera, snapped to whole shadow-map texels in light space (and with the light direction
 * quantised) so static geometry never shimmers while the camera moves. Also opts regular
 * three.js meshes (vehicles, characters, props) into casting/receiving.
 */
import * as THREE from 'three';
import { WORLD_H } from '@blockshore/shared';

/** light distance up the ray: must clear the tallest blocks (Leonia towers reach ~250 m) */
const LIGHT_UP = WORLD_H > 128 ? 620 : 350;

const _up = new THREE.Vector3(0, 1, 0);
const _r = new THREE.Vector3(), _u = new THREE.Vector3(), _c = new THREE.Vector3(), _fw = new THREE.Vector3();

export class SunShadows {
  size = 0;
  range = 120;
  private dir = new THREE.Vector3(0, 1, 0);
  private flagged = new WeakSet<THREE.Object3D>();
  private frame = 0;

  constructor(private renderer: THREE.WebGLRenderer, private light: THREE.DirectionalLight, private scene: THREE.Scene, private skip: THREE.Object3D[]) {
    renderer.shadowMap.type = THREE.PCFShadowMap;
    light.shadow.autoUpdate = true;
  }

  /** size 0 disables shadows */
  configure(size: number, range: number) {
    const enabled = size > 0;
    const changed = enabled !== this.renderer.shadowMap.enabled || (enabled && size !== this.size);
    this.size = size; this.range = range;
    this.renderer.shadowMap.enabled = enabled;
    this.light.castShadow = enabled;
    if (!enabled) { if (changed) this.refreshMaterials(); return; }
    const s = this.light.shadow;
    if (s.mapSize.x !== size) {
      s.mapSize.set(size, size);
      s.map?.dispose();
      (s as unknown as { map: THREE.WebGLRenderTarget | null }).map = null;
    }
    const cam = s.camera as THREE.OrthographicCamera;
    cam.left = -range / 2; cam.right = range / 2; cam.top = range / 2; cam.bottom = -range / 2;
    // light sits 350 m up the light ray; the box ends ~80 m past the focus so far-away
    // ground behind/under it is not drawn into the map
    cam.near = 1; cam.far = LIGHT_UP + 80;
    cam.updateProjectionMatrix();
    const texel = range / size;
    s.bias = -0.0002;
    s.normalBias = texel * 1.6;
    s.radius = size >= 4096 ? 3 : 2.2;
    if (changed) this.refreshMaterials();
  }

  private refreshMaterials() {
    this.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      if (!m) return;
      if (Array.isArray(m)) m.forEach((x) => (x.needsUpdate = true)); else m.needsUpdate = true;
    });
  }

  /** dir = main light direction (towards the sun/moon); strength fades shadows near the horizon */
  update(camera: THREE.Camera, lightDir: THREE.Vector3, strength: number) {
    if (!this.size) return;
    // quantise the direction (~0.15°) so the slow day cycle does not shimmer every frame
    if (this.dir.angleTo(lightDir) > 0.0026) this.dir.copy(lightDir);
    const d = this.dir;
    // centre a bit ahead of the camera, snapped to shadow texels in light space
    camera.getWorldDirection(_fw); _fw.y = 0;
    if (_fw.lengthSq() > 1e-6) _fw.normalize();
    _c.copy(camera.position).addScaledVector(_fw, this.range * 0.22);
    _r.crossVectors(_up, d);
    if (_r.lengthSq() < 1e-6) _r.set(1, 0, 0); else _r.normalize();
    _u.crossVectors(d, _r);
    const texel = this.range / this.size;
    const a = _c.dot(_r), b = _c.dot(_u);
    const a2 = Math.floor(a / texel) * texel, b2 = Math.floor(b / texel) * texel;
    _c.addScaledVector(_r, a2 - a).addScaledVector(_u, b2 - b);
    this.light.target.position.copy(_c);
    this.light.position.copy(_c).addScaledVector(d, LIGHT_UP);
    this.light.target.updateMatrixWorld();
    this.light.updateMatrixWorld();
    this.light.shadow.intensity = strength;
    // opt in regular meshes every so often (new vehicles / characters appear all the time)
    if ((this.frame++ & 31) === 0) this.flagEntities();
  }

  private flagEntities() {
    const skip = this.skip;
    const visit = (o: THREE.Object3D) => {
      if (skip.includes(o)) return;
      if (!this.flagged.has(o)) {
        this.flagged.add(o);
        const mesh = o as THREE.Mesh;
        if ((mesh.isMesh || (o as THREE.SkinnedMesh).isSkinnedMesh) && !o.userData.noShadow) {
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          const lit = mats.some((m) => m && !(m as THREE.MeshBasicMaterial).isMeshBasicMaterial && !(m as THREE.ShaderMaterial).isShaderMaterial);
          const solid = mats.every((m) => m && !m.transparent && m.depthWrite !== false && m.blending === THREE.NormalBlending);
          if (solid && !(mats[0] as THREE.ShaderMaterial)?.isShaderMaterial) o.castShadow = true;
          if (lit) o.receiveShadow = true;
        }
      }
      for (const c of o.children) visit(c);
    };
    visit(this.scene);
  }
}
