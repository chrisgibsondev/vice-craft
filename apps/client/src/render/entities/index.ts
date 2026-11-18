/**
 * EntityRenderer: draws every dynamic entity (characters, vehicles, objects, doors) plus objective markers and pings.
 * The game loop calls `update(dt, ents, local)` each frame with interpolated states, after `GameRenderer.update`.
 */
import * as THREE from 'three';
import { VEHICLES, seatOffset, type Ent, type NpcEnt, type ObjectiveView, type PlayerEnt, type VehicleModel } from '@blockshore/shared';
import type { GameRenderer } from '../renderer';
import { CharRig, Characters, lookFor, type PoseIn } from './characters';
import { disposeLabelCache, lerpAngle } from './util';
import { MarkerSystem } from './markers';
import { ObjectSystem } from './objects';
import { Vehicles, beginSeatEnter, beginSeatExit, occupantDrop, stepSeatTrans, type SeatTrans, type VehicleRig } from './vehicles';
import { disposeWeapons } from './weapons';
import { disposeVoxelProtos } from './voxelVehicles';
import { AnimalSystem } from './animals';
import { SpeechSystem } from './speech';

export { ViewModel } from './viewmodel';

export interface LocalView {
  id: string; x: number; y: number; z: number; yaw: number; pitch: number; anim: number;
  veh?: string; seat?: number; outfit: number; hair?: number; firstPerson: boolean; weapon: string; aiming: boolean; firing: boolean;
}

interface CharEntry { rig: CharRig; seen: boolean; c: number; hr: number; sk: number; role: string; parent: 'world' | THREE.Object3D; px: number; pz: number; spd: number; init: boolean;
  /** remote get-in/out blend state: last known vehicle/seat, last on-foot pose, running blend */
  vid?: string; vseat: number; known: boolean; foot: THREE.Vector3; footYaw: number; tr: SeatTrans | null }

const CULL_MAX = 180;
const _to = new THREE.Vector3();
const pose: PoseIn = { a: 0, pitch: 0, speed: 0, weapon: '', aiming: false, firing: false, stun: false };

export class EntityRenderer {
  readonly group = new THREE.Group();
  readonly chars = new Characters();
  readonly vehicles: Vehicles;
  readonly objects = new ObjectSystem();
  readonly markers = new MarkerSystem();
  readonly animals = new AnimalSystem();
  readonly speech = new SpeechSystem();
  /** NPC speech bubbles on/off (settings) */
  speechEnabled = true;
  private entries = new Map<string, CharEntry>();
  private t = 0;
  private frame = 0;
  private readonly camPos = new THREE.Vector3();
  private disposed = false;

  constructor(private r: GameRenderer) {
    this.vehicles = new Vehicles(r.L);
    this.group.name = 'entities';
    this.group.add(this.chars.group, this.vehicles.group, this.objects.group, this.markers.group, this.animals.group, this.speech.group);
    r.scene.add(this.group);
  }

  async preload(onProgress?: (p: number) => void): Promise<void> {
    try { await this.vehicles.load((p) => onProgress?.(p * 0.95)); } catch (e) { console.warn('[entities] preload error', e); }
    onProgress?.(1);
  }

  /** debug/demo: render fallback voxel vehicles even when GLBs are loaded */
  set forceVoxel(v: boolean) { this.vehicles.forceVoxel = v; }

  setMarkers(markers: ObjectiveView['markers'], colorblind: boolean) { this.markers.set(markers, colorblind); }
  setPings(pings: { x: number; y: number; z: number; kind: string; from: string; at: number }[]) { this.markers.setPings(pings); }
  vehicleObject(id: string): THREE.Object3D | null { return this.vehicles.rigs.get(id)?.root ?? null; }

  update(dt: number, ents: Ent[], local: LocalView): void {
    if (this.disposed) return;
    dt = Math.min(dt, 0.1);
    this.t += dt; this.frame++;
    const r = this.r;
    this.camPos.copy(r.camera.position);
    const cull = Math.min(CULL_MAX, Math.max(80, r.L.fogFar.value * 1.0));
    const night = r.L.night.value;
    const cull2 = cull * cull;
    for (const e of this.entries.values()) e.seen = false;
    const seenV = new Set<string>(), seenO = new Set<string>(), seenD = new Set<string>();

    // ── pass 1: vehicles, objects, doors
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      if (e.k === 'v') {
        const rig = this.vehicles.get(e.id, e);
        seenV.add(e.id);
        rig.setTarget(e);
        const dx = e.x - this.camPos.x, dz = e.z - this.camPos.z;
        const d2 = dx * dx + dz * dz;
        rig.root.visible = d2 < cull2 || this.isLocalVeh(e.id, local);
        if (rig.root.visible) rig.update(dt, this.t, night, Math.sqrt(d2));
        else { rig.init = false; }
        this.updateVehicleLabel(rig, e.label, Math.sqrt(d2));
      } else if (e.k === 'o') {
        seenO.add(e.id);
        const dx = e.x - this.camPos.x, dz = e.z - this.camPos.z, d2 = dx * dx + dz * dz;
        const rig = this.objects.getObj(e);
        rig.root.visible = d2 < cull2;
        if (rig.root.visible) rig.update(dt, this.t, e, Math.sqrt(d2), this.camPos);
      } else if (e.k === 'd') {
        seenD.add(e.id);
        const rig = this.objects.getDoor(e);
        const dx = e.x - this.camPos.x, dz = e.z - this.camPos.z, d2 = dx * dx + dz * dz;
        rig.root.visible = d2 < cull2;
        if (rig.root.visible) rig.update(dt, e);
      }
    }
    for (const id of [...this.vehicles.rigs.keys()]) if (!seenV.has(id)) this.vehicles.remove(id);
    for (const id of [...this.objects.rigs.keys()]) if (!seenO.has(id)) this.objects.removeObj(id);
    for (const id of [...this.objects.doors.keys()]) if (!seenD.has(id)) this.objects.removeDoor(id);

    // ── pass 2: characters
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      if (e.k === 'p') this.updatePlayer(dt, e, cull2);
      else if (e.k === 'n') this.updateNpc(dt, e, cull2);
    }
    this.updateLocal(dt, local);
    this.animals.sweep();
    for (const [id, en] of this.entries) if (!en.seen) { this.chars.removeRig(en.rig); this.entries.delete(id); }

    this.markers.update(dt, r.camera);
    this.speech.update(dt, r.camera, (id, out) => this.headAnchor(id, out), this.speechEnabled);
    this.updateShared(dt, night);
  }

  /** an NPC or traffic car says a line (server bark): returns the speaker caption for subtitles ('' when bubbles are off) */
  say(id: string, line: string, text: string): string { return this.speechEnabled ? this.speech.say(id, line, text) : ''; }

  /** world position just above an NPC's head or a vehicle's roof; false when it is not drawn */
  private headAnchor(id: string, out: THREE.Vector3): boolean {
    const en = this.entries.get(id);
    if (en && en.rig.root.visible) { out.copy(en.rig.root.position); out.y += 2.2 * en.rig.scale + 0.12; return true; }
    const vr = this.vehicles.rigs.get(id);
    if (vr && vr.root.visible) { out.copy(vr.root.position); out.y += vr.proto.height + 0.35; return true; }
    return false;
  }

  private isLocalVeh(id: string, l: LocalView) { return l.veh === id; }

  // ───────────────────────────── shared per-frame light state
  private updateShared(dt: number, night: number) {
    const A = this.vehicles.assets;
    A.lampMat.color.setRGB(1, 0.95, 0.8).multiplyScalar(0.55 + night * 3.2);
    A.tailLampMat.color.setRGB(1, 0.12, 0.08).multiplyScalar(0.7 + night * 1.6);
    A.brakeLampMat.color.setRGB(1, 0.2, 0.14).multiplyScalar(2.4 + night);
    A.beamMat.opacity = Math.min(0.5, night * 0.55);
    const sirenK = 1.5 + night * 5;
    A.sirenRed.color.setRGB(1, 0.1, 0.1).multiplyScalar(sirenK); A.sirenBlue.color.setRGB(0.1, 0.3, 1).multiplyScalar(sirenK);
    A.headMat.opacity = 0.35 + night * 0.65;
    A.tailMat.opacity = 0.5 + night * 0.5; A.brakeMat.opacity = 1;
    this.vehicles.smoke.update(dt, this.r.renderer.domElement.height || 800, this.r.camera.fov);
  }

  private updateVehicleLabel(rig: VehicleRig, label: string | undefined, dist: number) {
    void rig; void label; void dist;
  }

  // ───────────────────────────── characters
  private entry(id: string, kind: 'p' | 'n', role: string, sk: number, c: number, hr = 0): CharEntry {
    let en = this.entries.get(id);
    if (en && (en.role !== role || en.sk !== sk || en.c !== c || en.hr !== hr)) {
      const def = lookFor(kind, role, sk, c, id, hr);
      en.rig.setLook(def, JSON.stringify(def)); en.role = role; en.sk = sk; en.c = c; en.hr = hr;
    }
    if (!en) {
      const def = lookFor(kind, role, sk, c, id, hr);
      const rig = this.chars.createRig(def);
      en = { rig, seen: true, c, hr, sk, role, parent: 'world', px: 0, pz: 0, spd: 0, init: false, vseat: 0, known: false, foot: new THREE.Vector3(), footYaw: 0, tr: null };
      this.entries.set(id, en);
    }
    en.seen = true;
    return en;
  }

  /** place a rig either in the world or in a vehicle seat; returns the vehicle rig when seated */
  private seat(en: CharEntry, vehId: string | undefined, seat: number): VehicleRig | null {
    const vr = vehId ? this.vehicles.rigs.get(vehId) : undefined;
    if (!vr) {
      if (en.parent !== 'world') { this.chars.group.add(en.rig.root); en.parent = 'world'; en.rig.root.scale.set(en.rig.root.scale.x, en.rig.root.scale.y, en.rig.root.scale.z); }
      return null;
    }
    if (en.parent !== vr.seats) { vr.seats.add(en.rig.root); en.parent = vr.seats; }
    const def = VEHICLES[vr.model as VehicleModel];
    const [right, up, fwd] = seatOffset(def, seat);
    const bike = !!def.bike, boat = !!def.boat;
    en.rig.root.position.set(right, up - (bike ? 0.5 : 0.45) + (boat ? 0.02 : 0) - occupantDrop(vr.proto, up), -fwd);
    en.rig.root.rotation.set(0, 0, 0);
    en.rig.bike = bike;
    return vr;
  }

  private tagFor(en: CharEntry, text: string | null, color: string, dist: number, baseY: number) {
    const rig = en.rig;
    if (!text) { if (rig.tag) rig.tag.visible = false; return; }
    this.chars.setTag(rig, text, color);
    const tag = rig.tag!;
    const s = Math.max(0.22, dist * 0.0245);
    const ratio = tag.userData.ratio as number;
    tag.scale.set(s * ratio, s, 1);
    tag.position.set(0, baseY / Math.max(0.01, rig.root.scale.y), 0);
    tag.visible = true;
  }

  private drive(dt: number, en: CharEntry, x: number, y: number, z: number, yaw: number, vr: VehicleRig | null, p: { a: number; pitch: number; weapon: string; aiming: boolean; firing: boolean; stun: boolean }) {
    const rig = en.rig;
    if (!en.init) { en.px = x; en.pz = z; en.init = true; }
    const dx = x - en.px, dz = z - en.pz;
    const sp = dt > 0 ? Math.sqrt(dx * dx + dz * dz) / dt : 0;
    en.spd += (Math.min(sp, 14) - en.spd) * Math.min(1, 10 * dt);
    en.px = x; en.pz = z;
    if (!vr) {
      rig.root.position.set(x, y, z);
      rig.root.rotation.y = lerpAngle(rig.root.rotation.y, yaw, 1 - Math.exp(-18 * dt));
    }
    pose.a = p.a; pose.pitch = p.pitch; pose.speed = en.spd; pose.weapon = p.weapon; pose.aiming = p.aiming; pose.firing = p.firing; pose.stun = p.stun;
    rig.setWeapon(p.weapon);
    rig.animate(dt, pose, !!vr);
  }

  private updatePlayer(dt: number, e: PlayerEnt, cull2: number) {
    const dx = e.x - this.camPos.x, dz = e.z - this.camPos.z, d2 = dx * dx + dz * dz;
    const en = this.entry(e.id, 'p', 'player', 0, e.c, e.hr ?? 0);
    // remote players: blend into / out of the seat instead of snapping (visual only, positions stay authoritative)
    const seatNow = e.s ?? 0;
    if (!en.known) { en.known = true; en.vid = e.v; en.vseat = seatNow; }
    else if (en.vid !== e.v || en.vseat !== seatNow) {
      en.tr = null;
      const prev = en.vid ? this.vehicles.rigs.get(en.vid) : undefined, next = e.v ? this.vehicles.rigs.get(e.v) : undefined;
      if (!en.vid && next) en.tr = beginSeatEnter(next, seatNow, this.t, en.foot, en.footYaw);
      else if (en.vid && !e.v && prev) en.tr = beginSeatExit(prev, en.vseat, this.t, _to.set(e.x, e.y, e.z));
      en.vid = e.v; en.vseat = seatNow;
    }
    const trRig = en.tr ? this.vehicles.rigs.get(en.tr.veh) : undefined;
    const trPose = en.tr && trRig ? stepSeatTrans(en.tr, trRig, this.t, _to.set(e.x, e.y, e.z)) : null;
    if (!trPose) en.tr = null;
    if (!e.v && !trPose) { en.foot.set(e.x, e.y, e.z); en.footYaw = e.yaw; }
    const vr = trPose ? this.seat(en, undefined, 0) : this.seat(en, e.v, seatNow);
    const wx = vr ? vr.root.position.x : trPose ? trPose.x : e.x, wz = vr ? vr.root.position.z : trPose ? trPose.z : e.z;
    const ddx = wx - this.camPos.x, ddz = wz - this.camPos.z;
    const d2b = vr ? ddx * ddx + ddz * ddz : d2;
    en.rig.root.visible = d2b < cull2;
    if (!en.rig.root.visible) { en.init = false; return; }
    if (trPose) this.drive(dt, en, trPose.x, trPose.y, trPose.z, trPose.yaw, null, { a: trPose.anim, pitch: 0, weapon: e.w ?? '', aiming: false, firing: false, stun: false });
    else this.drive(dt, en, e.x, e.y, e.z, e.yaw, vr, { a: e.a, pitch: e.pitch, weapon: e.w ?? '', aiming: !!e.fa, firing: false, stun: false });
    en.rig.body.visible = trPose ? !(trPose.inSeat && trRig!.proto.enclosed) : !(vr && vr.proto.enclosed);
    const dist = Math.sqrt(d2b);
    const top = vr ? vr.proto.height + 0.45 : 2.12 * en.rig.scale;
    this.tagFor(en, dist < 140 ? e.n : null, e.party ? '#6ee7ff' : '#ffffff', dist, vr ? top - en.rig.root.position.y : top);
    this.chars.setAlert(en.rig, 0);
  }

  private updateNpc(dt: number, e: NpcEnt, cull2: number) {
    if (e.r.startsWith('animal:')) { this.animals.update(dt, e, this.camPos.x, this.camPos.z, cull2); return; }
    const dx = e.x - this.camPos.x, dz = e.z - this.camPos.z, d2 = dx * dx + dz * dz;
    const en = this.entry(e.id, 'n', e.r, e.sk, 0);
    en.rig.root.visible = d2 < cull2;
    if (!en.rig.root.visible) { en.init = false; return; }
    const dist = Math.sqrt(d2);
    this.drive(dt, en, e.x, e.y, e.z, e.yaw, null, { a: e.a, pitch: 0, weapon: '', aiming: false, firing: false, stun: !!e.stun });
    en.rig.body.visible = true;
    en.rig.ground = true;
    en.rig.cad = e.a === 1 ? Math.max(0.55, Math.min(1.1, 0.45 + en.spd * 0.22)) : 1;
    const alert = e.al ?? 0;
    this.tagFor(en, e.name && dist < 8 ? e.name : null, '#ffe2a0', dist, 2.12 * en.rig.scale);
    this.chars.setAlert(en.rig, e.r === 'guard' || e.al !== undefined ? alert : 0);
    if (en.rig.alert && en.rig.alert.visible) {
      const s = Math.max(0.5, dist * 0.05);
      en.rig.alert.scale.set(s * 0.75, s, 1);
      en.rig.alert.position.set(0, (2.55 * en.rig.scale + s * 0.5) / Math.max(0.01, en.rig.root.scale.y), 0);
      if (alert >= 1) { const p = 1 + Math.sin(this.t * 14) * 0.12; en.rig.alert.scale.multiplyScalar(p); }
    }
  }

  private updateLocal(dt: number, l: LocalView) {
    const hr = l.hair ?? 0;
    const en = this.entry('__local', 'p', 'player', 0, l.outfit, hr);
    // keep the local look keyed by the local id so skin/hair stay stable
    if (en.sk !== -7) { const def = lookFor('p', 'player', 0, l.outfit, l.id, hr); en.rig.setLook(def, JSON.stringify(def)); en.sk = -7; en.c = l.outfit; en.hr = hr; }
    const vr = this.seat(en, l.veh, l.seat ?? 0);
    en.rig.root.visible = !l.firstPerson;
    if (l.firstPerson) { en.init = false; return; }
    this.drive(dt, en, l.x, l.y, l.z, l.yaw, vr, { a: l.anim, pitch: l.pitch, weapon: l.weapon, aiming: l.aiming, firing: l.firing, stun: false });
    en.rig.body.visible = !(vr && vr.proto.enclosed);
    if (en.rig.tag) en.rig.tag.visible = false;
    if (en.rig.alert) en.rig.alert.visible = false;
  }

  dispose() {
    this.disposed = true;
    this.group.removeFromParent();
    this.speech.dispose(); this.chars.dispose(); this.animals.dispose(); this.vehicles.dispose(); this.objects.dispose(); this.markers.dispose();
    this.entries.clear();
    disposeLabelCache(); disposeWeapons(); disposeVoxelProtos();
  }
}
