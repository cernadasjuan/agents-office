import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { buildSkeleton, Joints } from './StickFigureParts.js';
import { createLabel, updateLabel } from './Label.js';
import { Activity, animateActivity, getRestPose } from '../agents/ActivityAnimations.js';

const TRANSITION_DURATION = 0.5;

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

  constructor(name: string, accentColor: THREE.Color) {
    this.name = name;
    this.joints = buildSkeleton(accentColor);
    this.label = createLabel(name, 'idle');
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
    updateLabel(this.label, this.name, activity);
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
      const diff = new THREE.Vector3().subVectors(this.targetPosition, currentPos);
      const dist = diff.length();

      if (dist < 0.05) {
        currentPos.copy(this.targetPosition);
        this.isMoving = false;
      } else {
        const speed = Math.min(3 * delta, dist);
        currentPos.add(diff.normalize().multiplyScalar(speed));
      }

      // Face target look-at direction
      const lookDir = new THREE.Vector3().subVectors(this.targetLookAt, currentPos);
      lookDir.y = 0;
      if (lookDir.length() > 0.01) {
        const angle = Math.atan2(lookDir.x, lookDir.z);
        const currentAngle = this.joints.root.rotation.y;
        let diff2 = angle - currentAngle;
        while (diff2 > Math.PI) diff2 -= Math.PI * 2;
        while (diff2 < -Math.PI) diff2 += Math.PI * 2;
        this.joints.root.rotation.y += diff2 * Math.min(5 * delta, 1);
      }
    }

    // Handle transition
    if (this.transitionProgress < 1) {
      this.transitionProgress = Math.min(1, this.transitionProgress + delta / TRANSITION_DURATION);

      if (this.transitionProgress >= 1) {
        this.activity = this.targetActivity;
      }
    }

    // Animate
    animateActivity(this.joints, this.activity, elapsed, delta);
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
