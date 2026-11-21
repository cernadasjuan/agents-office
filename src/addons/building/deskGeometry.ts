import * as THREE from 'three';
import { FIGURE_EYE_HEIGHT } from '../../characters/StickFigureParts.js';
import { OFFICE_DESK } from './furnishing.js';
import { RoomFrame } from './rooms.js';
import { slotFor } from './RoomPlanner.js';

/**
 * Pure geometry for the desk view (issue #161) and its two monitors: the one place that
 * knows where the user's own desk, its camera and its monitors sit, so `BuildingLayout.ts`
 * (the camera pose) and `deskMonitors.ts` (the mesh builder) can never drift apart — the
 * review round 2 bug (the camera pose and the monitor placement computed the same numbers
 * twice, independently) is exactly what this module exists to rule out.
 *
 * The office room is always the first rented room (`room-0-office`, `rooms.ts`'s own
 * naming; the Jira wall board makes the same assumption for its own slot).
 */

/** Issue #161: sitting at the desk reads lower than a standing first-person pose, so the desk and its monitors stay in frame. */
export const DESK_EYE_HEIGHT = FIGURE_EYE_HEIGHT * 0.78;
/**
 * How far behind the desk (away from the door) the desk-view camera sits — inside the chair,
 * not on top of the desk. Issue #199: the nearest queue row (`d - 1.6`) sits close enough that
 * its outer pair (`a = ±4.6`) needs a wide horizontal angle to stay in frame; pulled back this
 * far (short of the credenza/display shelf behind the chair, `furnishing.ts`'s `usersOffice`
 * pieces at `d` ~11.7) plus the wider `DESK_CAMERA_FOV` below is what actually closes the gap —
 * neither alone, at a room-safe offset, is enough (see that constant's own comment).
 */
export const DESK_SEAT_OFFSET = 2.0;
/** Where the desk-view camera looks: toward the queue in front of the desk, at a standing agent's eye level (`queueSpots`'s own `look` height). */
export const DESK_LOOK_OFFSET = 3.0;
export const DESK_LOOK_EYE_HEIGHT = 1.2;
/**
 * The desk-view camera's own vertical field of view (issue #199): wider than the first-person
 * default (60°, `SceneSetup.ts`), so the frustum clears the nearest queue row's outer pair at
 * every supported aspect ratio (1280x800 and 1600x1000, both 1.6 — the tighter of the three —
 * and 1920x1080). Pure geometry (`desk-monitors.test.ts`'s own frustum test) puts the minimum
 * at ~78° given `DESK_SEAT_OFFSET` above; this keeps a few degrees of margin. `ViewController`
 * applies it only while in desk mode and restores the shared camera's prior FOV on the way out
 * — first-person and isometric keep the normal lens (rule 2: a bug fix, scoped to the one view
 * it fixes).
 */
export const DESK_CAMERA_FOV = 82;

/** Each monitor's own width and height (issue #161 review round 2: a little larger, and a little lower, than the first round). */
export const MONITOR_WIDTH = 0.55;
export const MONITOR_HEIGHT = 0.34;
/** The bezel frame sits this much wider than the face on every side: the real physical extent a sightline or a label has to clear. */
export const MONITOR_BEZEL_MARGIN = 0.04;
/** Left and right of the desk's own center, where the stock monitor used to sit (issue #161 review round 2: it is gone from the user's own desk now, `furnishing.ts`'s `usersOffice` branch). */
export const MONITOR_A_OFFSET = 0.62;
/** Close to the desk's own screen position, not out at the old, farther offset: nearer the camera than the queue reads naturally lower on screen, not "in the way" of it. */
export const MONITOR_D_OFFSET = 0.45;
/** Low on the desk, below eye level: the camera reads over the top of them to the queue beyond, the AC this round's review asked for directly. */
export const MONITOR_Y = 0.92;

export function officeFrame(): RoomFrame {
  const slot = slotFor(0);
  return new RoomFrame(slot.rect, slot.door);
}

/**
 * Where the fixed desk-view camera sits and looks (issue #161, key `H`), and the vertical FOV
 * it needs (issue #199, `DESK_CAMERA_FOV`). Pure: assumes the office is slot 0, the one
 * assumption this whole module makes.
 */
export function deskCameraPose(): { position: THREE.Vector3; lookAt: THREE.Vector3; fov: number } {
  const frame = officeFrame();
  const position = frame.point(OFFICE_DESK.a, OFFICE_DESK.d + DESK_SEAT_OFFSET, DESK_EYE_HEIGHT);
  const lookAt = frame.point(OFFICE_DESK.a, OFFICE_DESK.d - DESK_LOOK_OFFSET, DESK_LOOK_EYE_HEIGHT);
  return { position, lookAt, fov: DESK_CAMERA_FOV };
}

/**
 * How far in front of the desk (toward the queue) the walk-up talk spot sits (issue #162):
 * closer than the queue's own front row (`queueSpotWorldPositions`'s row 0, `d - 1.6`), so a
 * selected agent visibly steps out of line to address Gabriel, but still nearer the queue than
 * the desk itself — and, the one geometric fact this spot leans on, farther from the desk
 * camera than either monitor (`MONITOR_D_OFFSET`, smaller than this offset): nothing can block
 * a sightline to a point nearer the camera than itself is, so standing here can never put the
 * agent between the camera and a monitor (`rayBlockedByQuad`, `desk-monitors.test.ts`'s own
 * sightline check).
 */
export const DESK_TALK_SPOT_D_OFFSET = 1.0;

/**
 * Where a selected queued agent walks to address Gabriel directly (issue #162, desk mode
 * only): centered on the desk, standing at floor level (review: `Seat.position` is the
 * figure's root, not its eye point — every other standing `Seat` in this layout, `queueSpots`
 * and the home desks, uses `frame.point`'s default height 0; `FIGURE_EYE_HEIGHT` here floated
 * the figure's root joint at eye level instead of its feet), facing back toward the desk
 * camera. Pure, the same "office is slot 0" assumption as the rest of this module.
 */
export function deskTalkSpotPose(): { position: THREE.Vector3; lookAt: THREE.Vector3 } {
  const frame = officeFrame();
  const position = frame.point(0, OFFICE_DESK.d - DESK_TALK_SPOT_D_OFFSET);
  const lookAt = deskCameraPose().position;
  return { position, lookAt };
}

/** Each monitor's own `a` offset: left negative, right positive. The one list every export below walks, so a mesh builder and a declutter/ray check can never see a different pair of monitors. */
const MONITOR_A_OFFSETS = [-MONITOR_A_OFFSET, MONITOR_A_OFFSET] as const;

/**
 * Where a monitor's own group sits, and the rotation that turns its face toward the desk
 * camera (issue #161 review round 2: "angled toward the desk camera", not a fixed
 * straight-ahead face every monitor shares regardless of how far off-center it sits).
 */
export function monitorPose(a: number): { position: THREE.Vector3; rotationY: number } {
  const frame = officeFrame();
  const position = frame.point(a, OFFICE_DESK.d - MONITOR_D_OFFSET, MONITOR_Y);
  const camera = deskCameraPose().position;
  // The same atan2(x, z) convention `RoomFrame.faceAway`/`faceDoor` already use: it is the
  // rotation that turns a `THREE.PlaneGeometry`'s own local +z normal to point at `camera`.
  const rotationY = Math.atan2(camera.x - position.x, camera.z - position.z);
  return { position, rotationY };
}

function quadCorners(position: THREE.Vector3, rotationY: number, width: number, height: number): THREE.Vector3[] {
  const up = new THREE.Vector3(0, 1, 0);
  return ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([sx, sy]) => {
    const local = new THREE.Vector3(sx * (width / 2), sy * (height / 2), 0);
    local.applyAxisAngle(up, rotationY);
    return local.add(position);
  });
}

/**
 * The world-space corners of each monitor's own bezel (its full physical extent, a touch
 * larger than the textured face), left then right: lets the label declutter keep a queued
 * agent's label clear of them, and lets a sightline check know what a monitor can actually
 * block. Pure — no scene, no mounted group needed.
 */
export function monitorWorldCorners(): THREE.Vector3[][] {
  return MONITOR_A_OFFSETS.map((a) => {
    const { position, rotationY } = monitorPose(a);
    return quadCorners(position, rotationY, MONITOR_WIDTH + MONITOR_BEZEL_MARGIN * 2, MONITOR_HEIGHT + MONITOR_BEZEL_MARGIN * 2);
  });
}

/** World positions of every queue spot in front of the desk, at a standing agent's own eye height (issue #161 review round 2: the sightline check's targets). */
export function queueSpotWorldPositions(): THREE.Vector3[] {
  const frame = officeFrame();
  const positions: THREE.Vector3[] = [];
  const full = [-2.3, 2.3, -4.6, 4.6, 0];
  const shifted = [-1.15, 1.15, -3.45, 3.45];
  for (let row = 0; row < 5; row++) {
    const d = OFFICE_DESK.d - 1.6 - row * 1.3;
    for (const a of row % 2 === 0 ? full : shifted) positions.push(frame.point(a, d, FIGURE_EYE_HEIGHT));
  }
  return positions;
}

/**
 * Does the ray from `origin` to `target` pass through the planar quad `corners` (issue #161
 * review round 2's own sightline check)? The quad is a flat rectangle (a pure Y-rotation of a
 * plane, always planar): find where the ray meets that plane, then check the hit falls inside
 * the rectangle's own local axes, and strictly between the two ends (so hitting right at the
 * target, or behind the origin, never counts as "in the way").
 */
export function rayBlockedByQuad(origin: THREE.Vector3, target: THREE.Vector3, corners: THREE.Vector3[]): boolean {
  const [a, b, , d] = corners; // a and d share one edge from a; a and b share the other
  const uAxis = new THREE.Vector3().subVectors(b!, a!);
  const vAxis = new THREE.Vector3().subVectors(d!, a!);
  const normal = new THREE.Vector3().crossVectors(uAxis, vAxis).normalize();
  const direction = new THREE.Vector3().subVectors(target, origin);
  const denom = normal.dot(direction);
  if (Math.abs(denom) < 1e-9) return false; // the ray and the quad's plane never meet
  const t = normal.dot(new THREE.Vector3().subVectors(a!, origin)) / denom;
  if (t <= 1e-6 || t >= 1 - 1e-6) return false; // strictly between the two ends only
  const hit = origin.clone().addScaledVector(direction, t);
  const local = new THREE.Vector3().subVectors(hit, a!);
  const uLenSq = uAxis.lengthSq();
  const vLenSq = vAxis.lengthSq();
  const uProj = local.dot(uAxis) / uLenSq;
  const vProj = local.dot(vAxis) / vLenSq;
  return uProj >= 0 && uProj <= 1 && vProj >= 0 && vProj <= 1;
}
