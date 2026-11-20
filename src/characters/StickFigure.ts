import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { buildSkeleton, Joints } from './StickFigureParts.js';
import { createLabel, updateLabel } from './Label.js';
import { Activity, animateActivity, animateWalking, getRestPose } from '../agents/ActivityAnimations.js';
import { ACTIVITY_LABELS, activityLabelFor } from '../agents/AgentData.js';
import { attentionLine, callsForYou } from '../ui/attention.js';
import type { AgentExtras } from '../agents/AgentData.js';
import { getToonMaterial } from '../utils/Materials.js';
import type { Posture } from '../layout/LayoutStrategy.js';

const TRANSITION_DURATION = 0.5;
/** One update this long finishes the activity transition and every eased joint (the slowest eases at 8 per second). */
const SETTLE_DELTA = 1;
const WALK_SPEED = 4.5;

export class StickFigure {
  joints: Joints;
  label: CSS2DObject;
  name: string;
  readonly accentColor: THREE.Color;
  activity: Activity = 'idle';
  private targetActivity: Activity = 'idle';
  private transitionProgress = 1;
  private previousPose: Map<THREE.Object3D, THREE.Euler> = new Map();
  private targetPosition = new THREE.Vector3();
  private targetLookAt = new THREE.Vector3();
  private isMoving = false;
  private posture: Posture | undefined;
  private tag: string | undefined;
  private attention: string | undefined;
  private waitMinutes: number | undefined;
  private callsForYou = false;
  private subagent = false;
  private stuck = false;
  private beacon: THREE.Mesh | null = null;

  constructor(name: string, accentColor: THREE.Color) {
    this.name = name;
    this.accentColor = accentColor.clone();
    this.joints = buildSkeleton(accentColor);
    this.label = createLabel(name, ACTIVITY_LABELS.idle);
    this.label.element.style.setProperty('--agent-color', `#${this.accentColor.getHexString()}`);
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
    this.refreshLabel();
  }

  /** A subagent at rest reads "Done": it has finished its task. */
  setSubagent(subagent: boolean): void {
    if (subagent === this.subagent) return;
    this.subagent = subagent;
    this.refreshLabel();
  }

  /** Optional provider mark in the floating label, for example "codex". */
  setTag(tag: string | undefined): void {
    if (tag === this.tag) return;
    this.tag = tag;
    this.refreshLabel();
  }

  /** Who needs the user: every wait changes the label; a fresh wait also raises a hand and shows a beacon. */
  setAttention(attention: string | undefined, waitMinutes: number | undefined): void {
    this.attention = attention;
    this.waitMinutes = waitMinutes;
    this.callsForYou = callsForYou({ attention: attention as AgentExtras['attention'], waitMinutes });
    this.refreshLabel();
    if (this.callsForYou && !this.beacon) {
      this.beacon = new THREE.Mesh(new THREE.OctahedronGeometry(0.16), getToonMaterial(new THREE.Color(0xffb020)));
      this.beacon.position.set(0, 2.55, 0);
      this.joints.root.add(this.beacon);
    }
    if (this.beacon) this.beacon.visible = this.callsForYou;
  }

  /** Busy with no transcript write for a long while: the label reads "Stuck?" instead of the activity. */
  setStuck(stuck: boolean): void {
    if (stuck === this.stuck) return;
    this.stuck = stuck;
    this.refreshLabel();
  }

  /** True while the figure walks to its station; the walk ends with a snap and a turn to the station. */
  get walking(): boolean {
    return this.isMoving;
  }

  /** Changes when the pose to show changes: the activity, the posture or the raised hand. */
  get poseKey(): string {
    return `${this.targetActivity}|${this.posture ?? ''}|${this.callsForYou ? 1 : 0}`;
  }

  /**
   * Show the target pose at once: one update long enough to finish the
   * transition and every eased joint. A sleeping figure (far or out of view)
   * settles once per pose change instead of running its sway. Not for a walk.
   */
  settle(elapsed: number): void {
    if (this.isMoving) return;
    this.update(elapsed, SETTLE_DELTA);
  }

  /** True while the wait calls for the user: the right hand stays up. */
  get isWaiting(): boolean {
    return this.callsForYou;
  }

  private refreshLabel(): void {
    const activityText = activityLabelFor(this.targetActivity, this.subagent);
    updateLabel(this.label, this.name, attentionLine(activityText, this.attention, this.waitMinutes, this.stuck), this.tag);
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
    animateActivity(this.joints, this.activity, elapsed, delta, this.posture, this.isWaiting);
    if (this.beacon?.visible) {
      this.beacon.position.y = 2.55 + Math.sin(elapsed * 3) * 0.06;
      this.beacon.rotation.y = elapsed * 1.5;
    }
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
