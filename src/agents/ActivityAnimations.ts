import * as THREE from 'three';
import { Joints } from '../characters/StickFigureParts.js';

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

// Seated pose: hips, shoulders, neck all drop together
// Standing: hips=0.9, shoulders=1.5, neck=1.6
// Seated:   hips=0.5, shoulders=1.1, neck=1.2  (all -0.4)
function applySittingBase(j: Joints, dt: number): void {
  j.hips.position.y = approachY(j.hips.position.y, 0.5, dt);
  j.shoulders.position.y = approachY(j.shoulders.position.y, 1.1, dt);
  j.neck.position.y = approachY(j.neck.position.y, 1.2, dt);

  j.leftUpperLeg.rotation.x = approach(j.leftUpperLeg.rotation.x, -1.5, dt);
  j.leftLowerLeg.rotation.x = approach(j.leftLowerLeg.rotation.x, 1.5, dt);
  j.rightUpperLeg.rotation.x = approach(j.rightUpperLeg.rotation.x, -1.5, dt);
  j.rightLowerLeg.rotation.x = approach(j.rightLowerLeg.rotation.x, 1.5, dt);
}

function applyStandingBase(j: Joints, dt: number): void {
  j.hips.position.y = approachY(j.hips.position.y, 0.9, dt);
  j.shoulders.position.y = approachY(j.shoulders.position.y, 1.5, dt);
  j.neck.position.y = approachY(j.neck.position.y, 1.6, dt);

  j.leftUpperLeg.rotation.x = approach(j.leftUpperLeg.rotation.x, 0, dt);
  j.leftLowerLeg.rotation.x = approach(j.leftLowerLeg.rotation.x, 0, dt);
  j.rightUpperLeg.rotation.x = approach(j.rightUpperLeg.rotation.x, 0, dt);
  j.rightLowerLeg.rotation.x = approach(j.rightLowerLeg.rotation.x, 0, dt);
}

export function animateWalking(j: Joints, elapsed: number, dt: number): void {
  // Standing base
  applyStandingBase(j, dt);

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
  j.hips.position.y = approachY(j.hips.position.y, 0.9 + bounce, dt, 15);
  j.shoulders.position.y = approachY(j.shoulders.position.y, 1.5 + bounce, dt, 15);
  j.neck.position.y = approachY(j.neck.position.y, 1.6 + bounce, dt, 15);
}

export function animateActivity(joints: Joints, activity: Activity, elapsed: number, delta: number): void {
  switch (activity) {
    case 'idle':
      animateIdle(joints, elapsed, delta);
      break;
    case 'planning':
      animatePlanning(joints, elapsed, delta);
      break;
    case 'implementing':
      animateImplementing(joints, elapsed, delta);
      break;
    case 'researching':
      animateResearching(joints, elapsed, delta);
      break;
    case 'testing':
      animateTesting(joints, elapsed, delta);
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

// --- IDLE: Holding coffee cup, subtle sway ---
function animateIdle(j: Joints, t: number, dt: number): void {
  applyStandingBase(j, dt);

  const sway = Math.sin(t * 0.8) * 0.03;
  j.body.rotation.z = approach(j.body.rotation.z, sway, dt);

  j.rightUpperArm.rotation.x = approach(j.rightUpperArm.rotation.x, -1.2, dt);
  j.rightForearm.rotation.x = approach(j.rightForearm.rotation.x, -1.8, dt);

  j.leftUpperArm.rotation.x = approach(j.leftUpperArm.rotation.x, 0.1, dt);
  j.leftForearm.rotation.x = approach(j.leftForearm.rotation.x, -0.1, dt);

  j.neck.rotation.z = approach(j.neck.rotation.z, Math.sin(t * 0.5) * 0.05, dt);
}

// --- PLANNING: Writing on whiteboard ---
function animatePlanning(j: Joints, t: number, dt: number): void {
  applyStandingBase(j, dt);

  const writeX = Math.sin(t * 3) * 0.3;
  const writeY = Math.cos(t * 2.1) * 0.15;
  j.rightUpperArm.rotation.x = approach(j.rightUpperArm.rotation.x, -2.5 + writeY, dt);
  j.rightUpperArm.rotation.z = approach(j.rightUpperArm.rotation.z, -0.3 + writeX * 0.2, dt);
  j.rightForearm.rotation.x = approach(j.rightForearm.rotation.x, -0.5, dt);

  j.leftUpperArm.rotation.x = approach(j.leftUpperArm.rotation.x, -0.3, dt);
  j.leftForearm.rotation.x = approach(j.leftForearm.rotation.x, -0.2, dt);

  j.neck.rotation.x = approach(j.neck.rotation.x, -0.2, dt);
  j.neck.rotation.z = approach(j.neck.rotation.z, Math.sin(t * 1.5) * 0.05, dt);

  j.body.rotation.z = approach(j.body.rotation.z, 0, dt);
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

// --- TESTING: Arms crossed, watching monitor ---
function animateTesting(j: Joints, t: number, dt: number): void {
  applyStandingBase(j, dt);

  j.leftUpperArm.rotation.x = approach(j.leftUpperArm.rotation.x, -1.2, dt);
  j.leftUpperArm.rotation.z = approach(j.leftUpperArm.rotation.z, 0.5, dt);
  j.leftForearm.rotation.x = approach(j.leftForearm.rotation.x, -1.5, dt);

  j.rightUpperArm.rotation.x = approach(j.rightUpperArm.rotation.x, -1.2, dt);
  j.rightUpperArm.rotation.z = approach(j.rightUpperArm.rotation.z, -0.5, dt);
  j.rightForearm.rotation.x = approach(j.rightForearm.rotation.x, -1.5, dt);

  j.body.rotation.z = approach(j.body.rotation.z, Math.sin(t * 0.4) * 0.03, dt);

  j.neck.rotation.x = approach(j.neck.rotation.x, -0.1, dt);
  j.neck.rotation.z = approach(j.neck.rotation.z, Math.sin(t * 0.3) * 0.05, dt);
}

// --- DEBUGGING: Scratching head, looking at red screen ---
function animateDebugging(j: Joints, t: number, dt: number): void {
  applySittingBase(j, dt);

  j.rightUpperArm.rotation.x = approach(j.rightUpperArm.rotation.x, -2.8, dt);
  j.rightForearm.rotation.x = approach(j.rightForearm.rotation.x, -1.5 + Math.sin(t * 4) * 0.2, dt);

  j.leftUpperArm.rotation.x = approach(j.leftUpperArm.rotation.x, -0.8, dt);
  j.leftForearm.rotation.x = approach(j.leftForearm.rotation.x, -0.5, dt);

  j.neck.rotation.x = approach(j.neck.rotation.x, -0.2, dt);
  j.neck.rotation.z = approach(j.neck.rotation.z, Math.sin(t * 0.7) * 0.15, dt);

  j.body.rotation.z = approach(j.body.rotation.z, Math.sin(t * 0.5) * 0.04, dt);
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
  j.hips.position.y = approachY(j.hips.position.y, 0.9 + jumpPhase * 0.3, dt, 12);
  j.shoulders.position.y = approachY(j.shoulders.position.y, 1.5 + jumpPhase * 0.3, dt, 12);
  j.neck.position.y = approachY(j.neck.position.y, 1.6 + jumpPhase * 0.3, dt, 12);

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
  j.neck.rotation.z = approach(j.neck.rotation.z, Math.sin(t * 4) * 0.1, dt);

  j.body.rotation.z = approach(j.body.rotation.z, Math.sin(t * 3) * 0.05, dt);
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
  j.neck.rotation.z = approach(j.neck.rotation.z, Math.sin(t * 1.5) * 0.05, dt);
  j.neck.rotation.x = approach(j.neck.rotation.x, 0, dt);

  j.body.rotation.z = approach(j.body.rotation.z, Math.sin(t * 0.7) * 0.03, dt);
}
