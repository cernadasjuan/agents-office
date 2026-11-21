import * as THREE from 'three';
import { HIP_HEIGHT, SHOULDERS_Y, NECK_HEIGHT, Joints } from '../characters/StickFigureParts.js';
import type { Posture } from '../layout/LayoutStrategy.js';

/**
 * The seated rig drops by this much from standing, at every proportion (issue #165's
 * Hero body changed HIP_HEIGHT/SHOULDERS_Y/NECK_HEIGHT; this drop is a chair-seat
 * relationship, not a body one, so it stays a fixed offset rather than scaling with
 * the figure).
 *
 * Issue #165 round 7 (review: "the sub-agents when sitting on a sofa look that
 * they're sinking in a sofa... And the agents too"): 0.4 was tuned for the old,
 * taller plain-stick body (seated hips landed at 0.9 - 0.4 = 0.5, a hair above the
 * seat). The Hero body's shorter `HIP_HEIGHT` (0.74) kept this same fixed drop,
 * landing seated hips at 0.34 — well *below* every seat surface this office builds
 * (the sofa's own cushion top, `Sofa.ts`: 0.35 + 0.15 / 2 = 0.425; the armchair's,
 * `Armchair.ts`: 0.35 + 0.14 / 2 = 0.42; the desk chair's and the stool's, `Desk.ts`/
 * `Stool.ts`: ~0.445-0.46) — reading as sinking into the cushion instead of resting
 * on it. Re-tuned so seated hips land at 0.425, the sofa's own seat height (the
 * piece of furniture the review named): close enough to the desk chair and stool
 * too (within 2-3 cm) that neither reads as sinking either.
 */
const SEATED_DROP = HIP_HEIGHT - 0.425;
/** Exported so a test can assert against the real computed seat height, not a second hardcoded copy of it. */
export const SEATED_HIP_HEIGHT = HIP_HEIGHT - SEATED_DROP;
export const SEATED_SHOULDERS_Y = SHOULDERS_Y - SEATED_DROP;
export const SEATED_NECK_HEIGHT = NECK_HEIGHT - SEATED_DROP;

export type Activity =
  | 'idle'
  | 'planning'
  | 'implementing'
  | 'researching'
  | 'testing'
  | 'debugging'
  | 'reviewing'
  | 'writing_docs'
  | 'deploying'
  | 'meeting';

export function getRestPose(joints: Joints): Map<THREE.Object3D, THREE.Euler> {
  const pose = new Map<THREE.Object3D, THREE.Euler>();
  pose.set(joints.leftUpperArm, new THREE.Euler(0, 0, 0));
  pose.set(joints.leftForearm, new THREE.Euler(0, 0, 0));
  pose.set(joints.rightUpperArm, new THREE.Euler(0, 0, 0));
  pose.set(joints.rightForearm, new THREE.Euler(0, 0, 0));
  pose.set(joints.leftUpperLeg, new THREE.Euler(0, 0, 0));
  pose.set(joints.leftLowerLeg, new THREE.Euler(0, 0, 0));
  pose.set(joints.rightUpperLeg, new THREE.Euler(0, 0, 0));
  pose.set(joints.rightLowerLeg, new THREE.Euler(0, 0, 0));
  pose.set(joints.neck, new THREE.Euler(0, 0, 0));
  return pose;
}

function lerpAngle(current: number, target: number, t: number): number {
  return current + (target - current) * t;
}

function approach(current: number, target: number, delta: number, speed = 8): number {
  return lerpAngle(current, target, Math.min(speed * delta, 1));
}

function approachY(current: number, target: number, delta: number, speed = 8): number {
  return current + (target - current) * Math.min(speed * delta, 1);
}

// --- OCCASIONAL VARIANTS (#164): a short canned clip now and then, on top of an
// otherwise still pose. Each figure's own root uuid seeds its gap and clip choice,
// so a room full of idle (or testing, or planning) figures never plays the same
// clip at the same time. A channel keys the schedule per activity, so idle's
// clock and testing's clock never share state. ---

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** A deterministic 0..1 value from a figure's uuid and an integer draw: no shared RNG state to desync in tests. */
function seededFraction(uuid: string, draw: number): number {
  return fnv1a(`${uuid}:${draw}`) / 0xffffffff;
}

interface VariantConfig {
  /** Seconds between the end of one clip and the earliest the next can start, at least. */
  minGap: number;
  /** The upper end of that same random gap. */
  maxGap: number;
  /** How long a clip plays once it starts, in seconds. */
  duration: number;
  /** How many clips this channel offers; `clipCount <= 1` never varies which one plays. */
  clipCount: number;
}

interface VariantState {
  nextAt: number;
  playing: boolean;
  clipEndsAt: number;
  clipIndex: number;
  lastIndex: number;
  draws: number;
}

const variantStates = new WeakMap<THREE.Object3D, Map<string, VariantState>>();

function variantStateFor(root: THREE.Object3D, channel: string): VariantState {
  let byChannel = variantStates.get(root);
  if (!byChannel) {
    byChannel = new Map();
    variantStates.set(root, byChannel);
  }
  let state = byChannel.get(channel);
  if (!state) {
    state = { nextAt: -1, playing: false, clipEndsAt: 0, clipIndex: -1, lastIndex: -1, draws: 0 };
    byChannel.set(channel, state);
  }
  return state;
}

function scheduleNext(state: VariantState, root: THREE.Object3D, t: number, cfg: VariantConfig): void {
  state.draws++;
  const span = cfg.maxGap - cfg.minGap;
  state.nextAt = t + cfg.minGap + seededFraction(root.uuid, state.draws) * span;
}

/**
 * -1 while the base pose should show; otherwise the clip index to apply this
 * frame. A figure gets its first gap the first time its channel is asked
 * about, so nothing plays before the pose itself has settled.
 */
function occasionalVariant(root: THREE.Object3D, channel: string, t: number, cfg: VariantConfig): number {
  const state = variantStateFor(root, channel);
  if (state.nextAt < 0) scheduleNext(state, root, t, cfg);

  if (state.playing) {
    if (t >= state.clipEndsAt) {
      state.playing = false;
      scheduleNext(state, root, t, cfg);
      return -1;
    }
    return state.clipIndex;
  }

  if (t < state.nextAt || cfg.clipCount <= 0) return -1;

  state.draws++;
  let index = Math.floor(seededFraction(root.uuid, state.draws) * cfg.clipCount);
  if (cfg.clipCount > 1 && index === state.lastIndex) index = (index + 1) % cfg.clipCount;
  state.lastIndex = index;
  state.clipIndex = index;
  state.playing = true;
  state.clipEndsAt = t + cfg.duration;
  return index;
}

// Rotations that only some poses drive. Every other pose eases them back to rest.
type SideAxis = 'leftUpperArm.z' | 'rightUpperArm.z' | 'neck.x' | 'neck.y';
const SIDE_AXES: SideAxis[] = ['leftUpperArm.z', 'rightUpperArm.z', 'neck.x', 'neck.y'];
const SIDE_AXES_DRIVEN_BY: Record<Activity | 'walking', SideAxis[]> = {
  idle: [],
  planning: ['rightUpperArm.z', 'neck.x'],
  implementing: ['neck.x'],
  researching: ['rightUpperArm.z', 'neck.x'],
  testing: ['leftUpperArm.z', 'rightUpperArm.z', 'neck.x'],
  debugging: ['neck.x'],
  reviewing: ['neck.x'],
  writing_docs: ['neck.x'],
  deploying: ['leftUpperArm.z', 'rightUpperArm.z', 'neck.x'],
  meeting: ['rightUpperArm.z', 'neck.x', 'neck.y'],
  walking: [],
};

function relaxUndrivenSideAxes(j: Joints, pose: Activity | 'walking', dt: number): void {
  const driven = SIDE_AXES_DRIVEN_BY[pose];
  for (const sideAxis of SIDE_AXES) {
    if (driven.includes(sideAxis)) continue;
    const [joint, axis] = sideAxis.split('.') as ['leftUpperArm' | 'rightUpperArm' | 'neck', 'x' | 'y' | 'z'];
    j[joint].rotation[axis] = approach(j[joint].rotation[axis], 0, dt);
  }
}

// The seat can force a posture (a sofa, an open-floor spot). Otherwise each pose uses its own.
let postureOverride: Posture | undefined;

function applySittingBase(j: Joints, dt: number): void {
  if (postureOverride === 'standing') applyUprightBase(j, dt);
  else applySeatedBase(j, dt);
}

function applyStandingBase(j: Joints, dt: number): void {
  if (postureOverride === 'seated') applySeatedBase(j, dt);
  else applyUprightBase(j, dt);
}

// Seated pose: hips, shoulders, neck all drop together
// Standing: hips=HIP_HEIGHT, shoulders=SHOULDERS_Y, neck=NECK_HEIGHT
// Seated: each minus SEATED_DROP
//
// Round 7 follow-up (subagents sink into the sofa): SEATED_HIP_HEIGHT etc. are tuned
// against a real sofa/armchair/desk-chair seat top in world space, but these targets
// are set on a joint local to `j.root`, which AgentManager scales by 0.85 for every
// subagent (`figure.group.scale.multiplyScalar(SUBAGENT_SCALE)`). Left unscaled here,
// a subagent's seated hips would land at 0.85 * 0.425 = ~0.361, about 6 cm below the
// seat it was just tuned to meet, undoing the round 7 fix for the half of the figures
// the review named ("the sub-agents... and the agents too"). Dividing by the root's
// own y scale cancels that scale out before the position lands on the parent sofa's
// local frame, so both a full-scale agent and an 0.85 subagent land hips on the same
// world-space seat top.
function applySeatedBase(j: Joints, dt: number): void {
  const scale = j.root.scale.y || 1;
  j.hips.position.y = approachY(j.hips.position.y, SEATED_HIP_HEIGHT / scale, dt);
  j.shoulders.position.y = approachY(j.shoulders.position.y, SEATED_SHOULDERS_Y / scale, dt);
  j.neck.position.y = approachY(j.neck.position.y, SEATED_NECK_HEIGHT / scale, dt);

  j.leftUpperLeg.rotation.x = approach(j.leftUpperLeg.rotation.x, -1.5, dt);
  j.leftLowerLeg.rotation.x = approach(j.leftLowerLeg.rotation.x, 1.5, dt);
  j.rightUpperLeg.rotation.x = approach(j.rightUpperLeg.rotation.x, -1.5, dt);
  j.rightLowerLeg.rotation.x = approach(j.rightLowerLeg.rotation.x, 1.5, dt);
}

function applyUprightBase(j: Joints, dt: number): void {
  j.hips.position.y = approachY(j.hips.position.y, HIP_HEIGHT, dt);
  j.shoulders.position.y = approachY(j.shoulders.position.y, SHOULDERS_Y, dt);
  j.neck.position.y = approachY(j.neck.position.y, NECK_HEIGHT, dt);

  j.leftUpperLeg.rotation.x = approach(j.leftUpperLeg.rotation.x, 0, dt);
  j.leftLowerLeg.rotation.x = approach(j.leftLowerLeg.rotation.x, 0, dt);
  j.rightUpperLeg.rotation.x = approach(j.rightUpperLeg.rotation.x, 0, dt);
  j.rightLowerLeg.rotation.x = approach(j.rightLowerLeg.rotation.x, 0, dt);
}

export function animateWalking(j: Joints, elapsed: number, dt: number): void {
  // Standing base
  applyUprightBase(j, dt);
  relaxUndrivenSideAxes(j, 'walking', dt);

  const walkCycle = elapsed * 9; // speed of walk cycle
  const legSwing = Math.sin(walkCycle) * 0.5;
  const kneeAngle = Math.max(0, Math.sin(walkCycle)) * 0.6;
  const altKneeAngle = Math.max(0, Math.sin(walkCycle + Math.PI)) * 0.6;

  // Legs swing opposite to each other
  j.leftUpperLeg.rotation.x = approach(j.leftUpperLeg.rotation.x, legSwing, dt, 12);
  j.leftLowerLeg.rotation.x = approach(j.leftLowerLeg.rotation.x, kneeAngle, dt, 12);
  j.rightUpperLeg.rotation.x = approach(j.rightUpperLeg.rotation.x, -legSwing, dt, 12);
  j.rightLowerLeg.rotation.x = approach(j.rightLowerLeg.rotation.x, altKneeAngle, dt, 12);

  // Arms swing opposite to legs
  const armSwing = Math.sin(walkCycle) * 0.4;
  j.leftUpperArm.rotation.x = approach(j.leftUpperArm.rotation.x, -armSwing, dt, 12);
  j.leftForearm.rotation.x = approach(j.leftForearm.rotation.x, -0.3, dt, 12);
  j.rightUpperArm.rotation.x = approach(j.rightUpperArm.rotation.x, armSwing, dt, 12);
  j.rightForearm.rotation.x = approach(j.rightForearm.rotation.x, -0.3, dt, 12);

  // Subtle body bounce
  const bounce = Math.abs(Math.sin(walkCycle)) * 0.03;
  j.hips.position.y = approachY(j.hips.position.y, HIP_HEIGHT + bounce, dt, 15);
  j.shoulders.position.y = approachY(j.shoulders.position.y, SHOULDERS_Y + bounce, dt, 15);
  j.neck.position.y = approachY(j.neck.position.y, NECK_HEIGHT + bounce, dt, 15);
}

/**
 * `raiseHand` is the true "Gabriel, I need you" signal: it owns the right arm, whatever the
 * activity pose does with it. `orchestrating` (issue #168) is the calm alternative for an
 * agent that finished its own turn but still has a subagent of its own running: it owns both
 * arms instead, for a hands-on-hips pose, and never fires together with `raiseHand` — a true
 * call for you always wins when, somehow, both are set.
 */
export function animateActivity(
  joints: Joints, activity: Activity, elapsed: number, delta: number, posture?: Posture, raiseHand = false, orchestrating = false,
): void {
  postureOverride = posture;
  relaxUndrivenSideAxes(joints, activity, delta);
  // A raised hand owns the right arm: the activity pose must not pull it back down.
  const rightArm = raiseHand ? [joints.rightUpperArm.rotation.clone(), joints.rightForearm.rotation.clone()] : null;
  // Hands on hips owns both arms, the same way, but only when there is no true call for you.
  const hips = !raiseHand && orchestrating
    ? [joints.leftUpperArm.rotation.clone(), joints.leftForearm.rotation.clone(), joints.rightUpperArm.rotation.clone(), joints.rightForearm.rotation.clone()]
    : null;
  // Review fix (#164): either override owns an arm (or both) that an idle/testing/planning
  // clip also reaches for (the other arm, or the neck). Saving and restoring only the
  // joints each override names let a clip still move the rest mid-override; the clip
  // scheduler itself must not run at all while either override is active, so its own
  // clock keeps waiting rather than drawing and losing a clip.
  animateActivityPose(joints, activity, elapsed, delta, raiseHand || orchestrating);
  if (rightArm) {
    joints.rightUpperArm.rotation.copy(rightArm[0]);
    joints.rightForearm.rotation.copy(rightArm[1]);
    animateRaisedHand(joints, elapsed, delta);
  } else if (hips) {
    joints.leftUpperArm.rotation.copy(hips[0]);
    joints.leftForearm.rotation.copy(hips[1]);
    joints.rightUpperArm.rotation.copy(hips[2]);
    joints.rightForearm.rotation.copy(hips[3]);
    animateHandsOnHips(joints, delta);
  }
}

// --- RAISED HAND: an agent that waits for the user raises and waves its right hand ---
function animateRaisedHand(j: Joints, t: number, dt: number): void {
  j.rightUpperArm.rotation.x = approach(j.rightUpperArm.rotation.x, -2.9, dt);
  j.rightUpperArm.rotation.z = approach(j.rightUpperArm.rotation.z, -0.25 + Math.sin(t * 5) * 0.15, dt);
  j.rightForearm.rotation.x = approach(j.rightForearm.rotation.x, -0.2, dt);
}

// --- HANDS ON HIPS: an orchestrator whose own subagents are busy, not asking for Gabriel (#168) ---
function animateHandsOnHips(j: Joints, dt: number): void {
  j.leftUpperArm.rotation.x = approach(j.leftUpperArm.rotation.x, -0.3, dt);
  j.leftUpperArm.rotation.z = approach(j.leftUpperArm.rotation.z, 0.9, dt);
  j.leftForearm.rotation.x = approach(j.leftForearm.rotation.x, -1.9, dt);
  j.rightUpperArm.rotation.x = approach(j.rightUpperArm.rotation.x, -0.3, dt);
  j.rightUpperArm.rotation.z = approach(j.rightUpperArm.rotation.z, -0.9, dt);
  j.rightForearm.rotation.x = approach(j.rightForearm.rotation.x, -1.9, dt);
}

/** `suppressVariant`: true while a raised hand or hands-on-hips owns an arm the clip scheduler would also reach for (#164 review fix). */
function animateActivityPose(joints: Joints, activity: Activity, elapsed: number, delta: number, suppressVariant: boolean): void {
  switch (activity) {
    case 'idle':
      animateIdle(joints, elapsed, delta, suppressVariant);
      break;
    case 'planning':
      animatePlanning(joints, elapsed, delta, suppressVariant);
      break;
    case 'implementing':
      animateImplementing(joints, elapsed, delta);
      break;
    case 'researching':
      animateResearching(joints, elapsed, delta);
      break;
    case 'testing':
      animateTesting(joints, elapsed, delta, suppressVariant);
      break;
    case 'debugging':
      animateDebugging(joints, elapsed, delta);
      break;
    case 'reviewing':
      animateReviewing(joints, elapsed, delta);
      break;
    case 'writing_docs':
      animateWritingDocs(joints, elapsed, delta);
      break;
    case 'deploying':
      animateDeploying(joints, elapsed, delta);
      break;
    case 'meeting':
      animateMeeting(joints, elapsed, delta);
      break;
  }
}

// --- IDLE: Holding coffee cup, holds still (#163: no continuous sway) ---

/** One figure's clip plays roughly every 45-90s: across a dozen idle figures, that reads as "one of them, every several seconds" (#164), not a crowd all moving at once. */
const IDLE_CLIP_CONFIG: VariantConfig = { minGap: 45, maxGap: 90, duration: 1.6, clipCount: 3 };

/** Stretches both arms up for a moment, then settles back. */
function applyIdleStretch(j: Joints, dt: number): void {
  j.leftUpperArm.rotation.x = approach(j.leftUpperArm.rotation.x, -2.6, dt, 5);
  j.rightUpperArm.rotation.x = approach(j.rightUpperArm.rotation.x, -2.6, dt, 5);
  j.leftForearm.rotation.x = approach(j.leftForearm.rotation.x, -0.1, dt, 5);
  j.rightForearm.rotation.x = approach(j.rightForearm.rotation.x, -0.1, dt, 5);
  j.neck.rotation.z = approach(j.neck.rotation.z, -0.1, dt, 5);
}

/** Glances at a phone held up near the face. */
function applyIdleCheckPhone(j: Joints, t: number, dt: number): void {
  j.rightUpperArm.rotation.x = approach(j.rightUpperArm.rotation.x, -2.2, dt, 6);
  j.rightForearm.rotation.x = approach(j.rightForearm.rotation.x, -2.3, dt, 6);
  j.leftUpperArm.rotation.x = approach(j.leftUpperArm.rotation.x, 0.1, dt, 6);
  j.leftForearm.rotation.x = approach(j.leftForearm.rotation.x, -0.1, dt, 6);
  j.neck.rotation.z = approach(j.neck.rotation.z, 0.25 + Math.sin(t * 2) * 0.03, dt, 6);
}

/** Looks around the room, head turning side to side. */
function applyIdleLookAround(j: Joints, t: number, dt: number): void {
  j.neck.rotation.z = approach(j.neck.rotation.z, Math.sin(t * 1.4) * 0.35, dt, 5);
  j.rightUpperArm.rotation.x = approach(j.rightUpperArm.rotation.x, -1.0, dt, 5);
  j.rightForearm.rotation.x = approach(j.rightForearm.rotation.x, -1.5, dt, 5);
  j.leftUpperArm.rotation.x = approach(j.leftUpperArm.rotation.x, 0.1, dt, 5);
  j.leftForearm.rotation.x = approach(j.leftForearm.rotation.x, -0.1, dt, 5);
}

const IDLE_CLIPS: Array<(j: Joints, t: number, dt: number) => void> = [
  (j, _t, dt) => applyIdleStretch(j, dt),
  applyIdleCheckPhone,
  applyIdleLookAround,
];

/**
 * The same pose and clips apply whether the layout seated this figure at the
 * coffee machine or on open floor (no idle seat was free, #164): an overflow
 * standing idle figure is not a special case, it reads the same "taking a
 * break" as a seated one, clips included.
 *
 * `suppressVariant` (review fix): a raised hand or hands-on-hips already owns
 * an arm a clip would also reach for. Rather than save and restore every
 * joint a clip could touch, the clip scheduler does not run at all while
 * either override is active — its own clock keeps waiting, so nothing is
 * lost, a clip simply never starts (or shows) during an override.
 *
 * Review fix: the clip owns every joint it drives for the frames it plays.
 * The base held pose and a clip used to both write the same joints every
 * frame (base, then the clip on top), so the two targets fought and a clip
 * like the stretch settled around half its real angle. Below, exactly one of
 * the two branches runs per frame on those joints.
 */
function animateIdle(j: Joints, t: number, dt: number, suppressVariant = false): void {
  applyStandingBase(j, dt);
  j.body.rotation.z = approach(j.body.rotation.z, 0, dt);

  const clip = suppressVariant ? -1 : occasionalVariant(j.root, 'idle', t, IDLE_CLIP_CONFIG);
  if (clip >= 0) {
    IDLE_CLIPS[clip](j, t, dt);
    return;
  }

  // Base pose: holding a coffee cup.
  j.rightUpperArm.rotation.x = approach(j.rightUpperArm.rotation.x, -1.2, dt);
  j.rightForearm.rotation.x = approach(j.rightForearm.rotation.x, -1.8, dt);

  j.leftUpperArm.rotation.x = approach(j.leftUpperArm.rotation.x, 0.1, dt);
  j.leftForearm.rotation.x = approach(j.leftForearm.rotation.x, -0.1, dt);

  j.neck.rotation.z = approach(j.neck.rotation.z, 0, dt);
}

/** #164: now and then, sketches on a notepad instead of the whiteboard: hands lower, closer to the body. */
const PLANNING_VARIANT_CONFIG: VariantConfig = { minGap: 25, maxGap: 55, duration: 2.2, clipCount: 1 };

function applyDrawing(j: Joints, t: number, dt: number): void {
  const sketch = Math.sin(t * 4) * 0.12;
  j.rightUpperArm.rotation.x = approach(j.rightUpperArm.rotation.x, -1.1 + sketch, dt, 6);
  j.rightUpperArm.rotation.z = approach(j.rightUpperArm.rotation.z, -0.1, dt, 6);
  j.rightForearm.rotation.x = approach(j.rightForearm.rotation.x, -1.3, dt, 6);

  j.leftUpperArm.rotation.x = approach(j.leftUpperArm.rotation.x, -1.0, dt, 6);
  j.leftForearm.rotation.x = approach(j.leftForearm.rotation.x, -1.4, dt, 6);

  j.neck.rotation.x = approach(j.neck.rotation.x, 0.15, dt, 6);
}

// --- PLANNING: Writing on whiteboard ---
function animatePlanning(j: Joints, t: number, dt: number, suppressVariant = false): void {
  applyStandingBase(j, dt);
  j.neck.rotation.z = approach(j.neck.rotation.z, Math.sin(t * 1.5) * 0.05, dt);
  j.body.rotation.z = approach(j.body.rotation.z, 0, dt);

  const clip = suppressVariant ? -1 : occasionalVariant(j.root, 'planning', t, PLANNING_VARIANT_CONFIG);
  if (clip >= 0) {
    applyDrawing(j, t, dt);
    return;
  }

  const writeX = Math.sin(t * 3) * 0.3;
  const writeY = Math.cos(t * 2.1) * 0.15;
  j.rightUpperArm.rotation.x = approach(j.rightUpperArm.rotation.x, -2.5 + writeY, dt);
  j.rightUpperArm.rotation.z = approach(j.rightUpperArm.rotation.z, -0.3 + writeX * 0.2, dt);
  j.rightForearm.rotation.x = approach(j.rightForearm.rotation.x, -0.5, dt);

  j.leftUpperArm.rotation.x = approach(j.leftUpperArm.rotation.x, -0.3, dt);
  j.leftForearm.rotation.x = approach(j.leftForearm.rotation.x, -0.2, dt);

  j.neck.rotation.x = approach(j.neck.rotation.x, -0.2, dt);
}

// --- IMPLEMENTING: Typing at keyboard ---
function animateImplementing(j: Joints, t: number, dt: number): void {
  applySittingBase(j, dt);

  const typeL = Math.sin(t * 8) * 0.1;
  const typeR = Math.sin(t * 8 + Math.PI) * 0.1;
  j.leftUpperArm.rotation.x = approach(j.leftUpperArm.rotation.x, -1.0, dt);
  j.leftForearm.rotation.x = approach(j.leftForearm.rotation.x, -1.3 + typeL, dt);
  j.rightUpperArm.rotation.x = approach(j.rightUpperArm.rotation.x, -1.0, dt);
  j.rightForearm.rotation.x = approach(j.rightForearm.rotation.x, -1.3 + typeR, dt);

  j.neck.rotation.x = approach(j.neck.rotation.x, -0.15, dt);
  j.neck.rotation.z = approach(j.neck.rotation.z, 0, dt);

  j.body.rotation.z = approach(j.body.rotation.z, 0, dt);
}

// --- RESEARCHING: Looking at books, reaching for one ---
function animateResearching(j: Joints, t: number, dt: number): void {
  applyStandingBase(j, dt);

  const reachPhase = (Math.sin(t * 0.6) + 1) / 2;
  j.rightUpperArm.rotation.x = approach(j.rightUpperArm.rotation.x, -2.0 - reachPhase * 0.8, dt);
  j.rightForearm.rotation.x = approach(j.rightForearm.rotation.x, -0.3, dt);
  j.rightUpperArm.rotation.z = approach(j.rightUpperArm.rotation.z, -0.2, dt);

  j.leftUpperArm.rotation.x = approach(j.leftUpperArm.rotation.x, -1.5, dt);
  j.leftForearm.rotation.x = approach(j.leftForearm.rotation.x, -1.8, dt);

  j.neck.rotation.x = approach(j.neck.rotation.x, -0.3 - reachPhase * 0.2, dt);
  j.neck.rotation.z = approach(j.neck.rotation.z, 0, dt);

  j.body.rotation.z = approach(j.body.rotation.z, 0, dt);
}

/** #164: now and then, prays for the tests to pass instead of watching with crossed arms. Gabriel likes this one. */
const TESTING_VARIANT_CONFIG: VariantConfig = { minGap: 25, maxGap: 55, duration: 2.2, clipCount: 1 };

function applyPraying(j: Joints, dt: number): void {
  j.leftUpperArm.rotation.x = approach(j.leftUpperArm.rotation.x, -2.0, dt, 6);
  j.leftUpperArm.rotation.z = approach(j.leftUpperArm.rotation.z, 0.35, dt, 6);
  j.leftForearm.rotation.x = approach(j.leftForearm.rotation.x, -1.6, dt, 6);

  j.rightUpperArm.rotation.x = approach(j.rightUpperArm.rotation.x, -2.0, dt, 6);
  j.rightUpperArm.rotation.z = approach(j.rightUpperArm.rotation.z, -0.35, dt, 6);
  j.rightForearm.rotation.x = approach(j.rightForearm.rotation.x, -1.6, dt, 6);

  j.neck.rotation.x = approach(j.neck.rotation.x, 0.3, dt, 6);
}

// --- TESTING: Arms crossed, watching monitor ---
function animateTesting(j: Joints, t: number, dt: number, suppressVariant = false): void {
  applyStandingBase(j, dt);
  j.body.rotation.z = approach(j.body.rotation.z, 0, dt);
  j.neck.rotation.z = approach(j.neck.rotation.z, 0, dt);

  const clip = suppressVariant ? -1 : occasionalVariant(j.root, 'testing', t, TESTING_VARIANT_CONFIG);
  if (clip >= 0) {
    applyPraying(j, dt);
    return;
  }

  j.leftUpperArm.rotation.x = approach(j.leftUpperArm.rotation.x, -1.2, dt);
  j.leftUpperArm.rotation.z = approach(j.leftUpperArm.rotation.z, 0.5, dt);
  j.leftForearm.rotation.x = approach(j.leftForearm.rotation.x, -1.5, dt);

  j.rightUpperArm.rotation.x = approach(j.rightUpperArm.rotation.x, -1.2, dt);
  j.rightUpperArm.rotation.z = approach(j.rightUpperArm.rotation.z, -0.5, dt);
  j.rightForearm.rotation.x = approach(j.rightForearm.rotation.x, -1.5, dt);

  j.neck.rotation.x = approach(j.neck.rotation.x, -0.1, dt);
}

// --- DEBUGGING: Scratching head, looking at red screen ---
function animateDebugging(j: Joints, t: number, dt: number): void {
  applySittingBase(j, dt);

  j.rightUpperArm.rotation.x = approach(j.rightUpperArm.rotation.x, -2.8, dt);
  j.rightForearm.rotation.x = approach(j.rightForearm.rotation.x, -1.5 + Math.sin(t * 4) * 0.2, dt);

  j.leftUpperArm.rotation.x = approach(j.leftUpperArm.rotation.x, -0.8, dt);
  j.leftForearm.rotation.x = approach(j.leftForearm.rotation.x, -0.5, dt);

  j.neck.rotation.x = approach(j.neck.rotation.x, -0.2, dt);
  j.neck.rotation.z = approach(j.neck.rotation.z, 0, dt);

  j.body.rotation.z = approach(j.body.rotation.z, 0, dt);
}

// --- REVIEWING: Seated, hand on chin, reading ---
function animateReviewing(j: Joints, t: number, dt: number): void {
  applySittingBase(j, dt);

  j.rightUpperArm.rotation.x = approach(j.rightUpperArm.rotation.x, -1.8, dt);
  j.rightForearm.rotation.x = approach(j.rightForearm.rotation.x, -2.2, dt);

  j.leftUpperArm.rotation.x = approach(j.leftUpperArm.rotation.x, -1.0, dt);
  j.leftForearm.rotation.x = approach(j.leftForearm.rotation.x, -1.5, dt);

  j.neck.rotation.x = approach(j.neck.rotation.x, -0.15 + Math.sin(t * 0.8) * 0.08, dt);
  j.neck.rotation.z = approach(j.neck.rotation.z, 0, dt);

  j.body.rotation.z = approach(j.body.rotation.z, 0, dt);
}

// --- WRITING DOCS: Seated, writing on paper ---
function animateWritingDocs(j: Joints, t: number, dt: number): void {
  applySittingBase(j, dt);

  const writeMotion = Math.sin(t * 5) * 0.1;
  j.rightUpperArm.rotation.x = approach(j.rightUpperArm.rotation.x, -1.3, dt);
  j.rightForearm.rotation.x = approach(j.rightForearm.rotation.x, -1.0 + writeMotion, dt);

  j.leftUpperArm.rotation.x = approach(j.leftUpperArm.rotation.x, -1.0, dt);
  j.leftForearm.rotation.x = approach(j.leftForearm.rotation.x, -0.8, dt);

  j.neck.rotation.x = approach(j.neck.rotation.x, 0.2, dt);
  j.neck.rotation.z = approach(j.neck.rotation.z, 0, dt);

  j.body.rotation.z = approach(j.body.rotation.z, 0, dt);
}

// --- DEPLOYING: Hands up, jumping, celebrating ---
function animateDeploying(j: Joints, t: number, dt: number): void {
  const jumpPhase = Math.abs(Math.sin(t * 3));
  j.hips.position.y = approachY(j.hips.position.y, HIP_HEIGHT + jumpPhase * 0.3, dt, 12);
  j.shoulders.position.y = approachY(j.shoulders.position.y, SHOULDERS_Y + jumpPhase * 0.3, dt, 12);
  j.neck.position.y = approachY(j.neck.position.y, NECK_HEIGHT + jumpPhase * 0.3, dt, 12);

  j.leftUpperArm.rotation.x = approach(j.leftUpperArm.rotation.x, -3.0, dt, 12);
  j.leftUpperArm.rotation.z = approach(j.leftUpperArm.rotation.z, 0.3 + Math.sin(t * 6) * 0.2, dt, 12);
  j.leftForearm.rotation.x = approach(j.leftForearm.rotation.x, -0.3, dt, 12);

  j.rightUpperArm.rotation.x = approach(j.rightUpperArm.rotation.x, -3.0, dt, 12);
  j.rightUpperArm.rotation.z = approach(j.rightUpperArm.rotation.z, -0.3 - Math.sin(t * 6) * 0.2, dt, 12);
  j.rightForearm.rotation.x = approach(j.rightForearm.rotation.x, -0.3, dt, 12);

  j.leftUpperLeg.rotation.x = approach(j.leftUpperLeg.rotation.x, jumpPhase * -0.3, dt);
  j.leftLowerLeg.rotation.x = approach(j.leftLowerLeg.rotation.x, jumpPhase * 0.3, dt);
  j.rightUpperLeg.rotation.x = approach(j.rightUpperLeg.rotation.x, jumpPhase * -0.3, dt);
  j.rightLowerLeg.rotation.x = approach(j.rightLowerLeg.rotation.x, jumpPhase * 0.3, dt);

  j.neck.rotation.x = approach(j.neck.rotation.x, -0.2, dt);
  j.neck.rotation.z = approach(j.neck.rotation.z, 0, dt);

  j.body.rotation.z = approach(j.body.rotation.z, 0, dt);
}

// --- MEETING: Gesturing, conversing ---
function animateMeeting(j: Joints, t: number, dt: number): void {
  applyStandingBase(j, dt);

  const gesture = Math.sin(t * 2);
  j.rightUpperArm.rotation.x = approach(j.rightUpperArm.rotation.x, -1.0 + gesture * 0.4, dt);
  j.rightForearm.rotation.x = approach(j.rightForearm.rotation.x, -0.8 + gesture * 0.3, dt);
  j.rightUpperArm.rotation.z = approach(j.rightUpperArm.rotation.z, -0.3, dt);

  j.leftUpperArm.rotation.x = approach(j.leftUpperArm.rotation.x, -0.5 - gesture * 0.2, dt);
  j.leftForearm.rotation.x = approach(j.leftForearm.rotation.x, -0.4, dt);

  j.neck.rotation.y = approach(j.neck.rotation.y ?? 0, Math.sin(t * 1.2) * 0.2, dt);
  j.neck.rotation.z = approach(j.neck.rotation.z, 0, dt);
  j.neck.rotation.x = approach(j.neck.rotation.x, 0, dt);

  j.body.rotation.z = approach(j.body.rotation.z, 0, dt);
}
