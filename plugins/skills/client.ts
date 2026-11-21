import * as THREE from 'three';
import { registerExtension, type OfficeExtension } from '../../src/extensions.js';
import type { ManagedAgent } from '../../src/agents/AgentManager.js';
import { handItemFor, faceItemFor, buildHandItem, buildFaceItem, type HandItem, type FaceKind } from './items.js';

/**
 * Skills plugin, browser part (issue #167 v1, equipment catalog): equips the newest-used
 * skill's item in the right hand, and an independent, recency-free face item (glasses or
 * headphones). The head stays the persona hat's slot (`plugins/bmad/client.ts`) — a skill
 * item never competes for head space.
 */

const HAND_GROUP = 'skills-hand-item';
const FACE_GROUP = 'skills-face-item';
/** Held low and slightly forward, roughly where a closed hand would hold a small tool. */
const HAND_OFFSET: [number, number, number] = [0, -0.01, 0.03];
/** At the same depth as the eyes (StickFigureParts.ts's `FACE_DEPTH`), just above them. */
const FACE_OFFSET: [number, number, number] = [0, 0.05, 0.19];

interface Worn {
  figure: ManagedAgent['figure'];
  handKey: string;
  faceKey: string;
  handGroup: THREE.Group | null;
  faceGroup: THREE.Group | null;
}

const worn = new Map<string, Worn>();

function handKeyOf(item: HandItem | undefined): string {
  if (!item) return '';
  return item.tint ? `${item.kind}:${item.tint.getHexString()}` : item.kind;
}

function skillsOf(managed: ManagedAgent): string[] {
  const skills = managed.info.extras?.skills;
  return Array.isArray(skills) ? skills.filter((skill): skill is string => typeof skill === 'string') : [];
}

function removeHand(entry: Worn): void {
  entry.handGroup?.removeFromParent();
  entry.handGroup = null;
}

function removeFace(entry: Worn): void {
  entry.faceGroup?.removeFromParent();
  entry.faceGroup = null;
}

export const skillsEquipment: OfficeExtension = {
  id: 'skills-equipment',
  plugin: 'skills',
  agentsChanged(agents: ManagedAgent[]) {
    const present = new Set<string>();
    for (const managed of agents) {
      present.add(managed.info.id);
      const skills = skillsOf(managed);
      const hand = handItemFor(skills);
      const face = faceItemFor(skills);
      const handKey = handKeyOf(hand);
      const faceKey = face ?? '';

      let entry = worn.get(managed.info.id);
      if (entry && entry.figure !== managed.figure) {
        removeHand(entry);
        removeFace(entry);
        entry = undefined;
      }
      if (!entry) {
        entry = { figure: managed.figure, handKey: '', faceKey: '', handGroup: null, faceGroup: null };
        worn.set(managed.info.id, entry);
      }

      if (entry.handKey !== handKey) {
        removeHand(entry);
        if (hand) {
          entry.handGroup = buildHandItem(hand);
          entry.handGroup.position.set(...HAND_OFFSET);
          entry.handGroup.name = HAND_GROUP;
          managed.figure.joints.rightHand.add(entry.handGroup);
        }
        entry.handKey = handKey;
      }

      if (entry.faceKey !== faceKey) {
        removeFace(entry);
        if (face) {
          entry.faceGroup = buildFaceItem(face as FaceKind);
          entry.faceGroup.position.set(...FACE_OFFSET);
          entry.faceGroup.name = FACE_GROUP;
          managed.figure.joints.head.add(entry.faceGroup);
        }
        entry.faceKey = faceKey;
      }
    }
    for (const [id, entry] of worn) {
      if (present.has(id)) continue;
      removeHand(entry);
      removeFace(entry);
      worn.delete(id);
    }
  },
};

registerExtension(skillsEquipment);
