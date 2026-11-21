import * as THREE from 'three';
import { registerExtension, type OfficeExtension } from '../../src/extensions.js';
import type { ManagedAgent } from '../../src/agents/AgentManager.js';
import { handItemFor, faceItemFor, buildHandItem, buildFaceItem, type HandItem, type FaceKind } from './items.js';

/**
 * Skills plugin, browser part (issue #167, equipment catalog): equips the one true
 * newest-introduced item in the right hand, across both `extras.skills` (a named `Skill`
 * tool call) and `extras.tools` (round 2: a fixed allow-list of raw built-in tool calls,
 * `lastEquipSource` says which list had it), plus an independent, recency-free face item
 * (glasses or headphones). The head stays the persona hat's slot (`plugins/bmad/client.ts`)
 * — a skill or tool item never competes for head space.
 */

/** A `userData` marker, not `.name` (review: `.name` stays the item's own kind, from
 * `plugins/skills/items.ts`'s `group(kind, ...)`, so a test or an inspector can tell
 * which kind is actually worn without sniffing geometry dimensions). */
const HAND_ITEM_MARKER = 'skillsHandItem';
const FACE_ITEM_MARKER = 'skillsFaceItem';
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

function toolsOf(managed: ManagedAgent): string[] {
  const tools = managed.info.extras?.tools;
  return Array.isArray(tools) ? tools.filter((tool): tool is string => typeof tool === 'string') : [];
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
      const tools = toolsOf(managed);
      const hand = handItemFor(skills, tools, managed.info.extras?.lastEquipSource);
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
          entry.handGroup.userData[HAND_ITEM_MARKER] = true;
          managed.figure.joints.rightHand.add(entry.handGroup);
        }
        entry.handKey = handKey;
      }

      if (entry.faceKey !== faceKey) {
        removeFace(entry);
        if (face) {
          entry.faceGroup = buildFaceItem(face as FaceKind);
          entry.faceGroup.position.set(...FACE_OFFSET);
          entry.faceGroup.userData[FACE_ITEM_MARKER] = true;
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
