import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { buildSkeleton, Joints } from './StickFigureParts.js';
import { createLabel, updateLabel } from './Label.js';
import { Activity, animateActivity, animateWalking, getRestPose } from '../agents/ActivityAnimations.js';
import { ACTIVITY_LABELS } from '../agents/AgentData.js';
import type { Posture } from '../layout/LayoutStrategy.js';

const TRANSITION_DURATION = 0.5;
const WALK_SPEED = 4.5;

export class StickFigure {
  joints: Joints;
  label: CSS2DObject;
  name: string;
  activity: Activity = 'idle';
  private targetActivity: Activity = 'idle';
  private transitionProgress = 1;
  private previousPose: Map<THREE.Object3D, THREE.Euler> = new Map();
  private targetPosition = new THREE.Vector3();
  private targetLookAt = new THREE.Vector3();
  private isMoving = false;
  private posture: Posture | undefined;

  constructor(name: string, accentColor: THREE.Color) {
    this.name = name;
    this.joints = buildSkeleton(accentColor);
    this.label = createLabel(name, ACTIVITY_LABELS.idle);
    this.joints.root.add(this.label);

    // Apply rest pose
    this.applyPose(getRestPose(this.joints));
  }

  get group(): THREE.Group {
    return this.joints.root;
  }

  setActivity(activity: Activity): void {
    if (activity === this.activity && this.transitionProgress >= 1) return;

    // Save current pose for blending
    this.previousPose.clear();
    this.saveCurrentPose(this.joints.root);

    this.targetActivity = activity;
    this.transitionProgress = 0;
    updateLabel(this.label, this.name, ACTIVITY_LABELS[activity] ?? activity);
  }

  /** Force a posture for the current seat, or undefined to let the activity decide. */
  setPosture(posture: Posture | undefined): void {
    this.posture = posture;
  }

  moveTo(position: THREE.Vector3, lookAt: THREE.Vector3): void {
    this.targetPosition.copy(position);
    this.targetLookAt.copy(lookAt);
    this.isMoving = true;
  }

  teleportTo(position: THREE.Vector3, lookAt: THREE.Vector3): void {
    this.joints.root.position.copy(position);
    this.targetPosition.copy(position);
    this.isMoving = false;

    // Face look-at direction immediately
    const lookDir = new THREE.Vector3().subVectors(lookAt, position);
    lookDir.y = 0;
    if (lookDir.length() > 0.01) {
      this.joints.root.rotation.y = Math.atan2(lookDir.x, lookDir.z);
    }
  }

  update(elapsed: number, delta: number): void {
    // Handle movement
    if (this.isMoving) {
      const currentPos = this.joints.root.position;
      const moveDir = new THREE.Vector3().subVectors(this.targetPosition, currentPos);
      const dist = moveDir.length();

      if (dist < 0.05) {
        currentPos.copy(this.targetPosition);
        this.isMoving = false;
        // Snap to face the station's lookAt direction on arrival
        const lookDir = new THREE.Vector3().subVectors(this.targetLookAt, currentPos);
        lookDir.y = 0;
        if (lookDir.length() > 0.01) {
          this.joints.root.rotation.y = Math.atan2(lookDir.x, lookDir.z);
        }
      } else {
        const speed = Math.min(WALK_SPEED * delta, dist);
        currentPos.add(moveDir.normalize().multiplyScalar(speed));

        // Face movement direction while walking
        const faceDir = moveDir.clone();
        faceDir.y = 0;
        if (faceDir.length() > 0.01) {
          const angle = Math.atan2(faceDir.x, faceDir.z);
          const currentAngle = this.joints.root.rotation.y;
          let angleDiff = angle - currentAngle;
          while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
          while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
          this.joints.root.rotation.y += angleDiff * Math.min(5 * delta, 1);
        }
      }

      // Walking animation overrides activity animation
      animateWalking(this.joints, elapsed, delta);
      return;
    }

    // Handle transition
    if (this.transitionProgress < 1) {
      this.transitionProgress = Math.min(1, this.transitionProgress + delta / TRANSITION_DURATION);

      if (this.transitionProgress >= 1) {
        this.activity = this.targetActivity;
      }
    }

    // Animate activity
    animateActivity(this.joints, this.activity, elapsed, delta, this.posture);
  }

  private saveCurrentPose(obj: THREE.Object3D): void {
    this.previousPose.set(obj, obj.rotation.clone());
    for (const child of obj.children) {
      this.saveCurrentPose(child);
    }
  }

  dispose(): void {
    // Remove label DOM element
    if (this.label.element && this.label.element.parentNode) {
      this.label.element.parentNode.removeChild(this.label.element);
    }
    // Traverse and dispose geometries/materials
    this.joints.root.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry?.dispose();
        if (obj.material instanceof THREE.Material) {
          obj.material.dispose();
        }
      }
    });
  }

  private applyPose(pose: Map<THREE.Object3D, THREE.Euler>): void {
    for (const [obj, euler] of pose) {
      obj.rotation.copy(euler);
    }
  }
}
