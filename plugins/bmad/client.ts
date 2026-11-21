import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { registerExtension, type OfficeExtension } from '../../src/extensions.js';
import type { ManagedAgent } from '../../src/agents/AgentManager.js';
import type { StickFigure } from '../../src/characters/StickFigure.js';
import { activityLabel } from '../../src/agents/AgentData.js';
import { buildHat } from './hats.js';
import { personaName } from './roster.js';

/**
 * BMAD plugin, browser part. Puts a pile of toon hats on each figure's head,
 * one hat per persona badge, and lists the persona names on the label.
 */

export const MAX_HATS = 4;
/** Issue #165 round 2: the Hero head grew from a 0.15 to a 0.205 radius; this keeps the
 * same ratio to the head (0.12 / 0.15) so a hat still sits where hair and a persona's
 * own head-top previously sat, not floating above a now-bigger head. */
const HEAD_TOP = 0.164;
const SHRINK = 0.9;

interface Worn {
  figure: StickFigure;
  key: string;
  stack: THREE.Group | null;
}

const worn = new Map<string, Worn>();

function moreMarker(count: number, y: number): CSS2DObject {
  const element = document.createElement('div');
  element.className = 'bmad-more';
  element.textContent = `+${count}`;
  element.style.cssText = 'font: 600 11px sans-serif; color: #fff; background: rgba(0,0,0,0.55); padding: 0 4px; border-radius: 6px;';
  const marker = new CSS2DObject(element);
  marker.name = 'bmad-more';
  marker.position.set(0.18, y, 0);
  return marker;
}

function buildStack(badges: string[]): THREE.Group {
  const stack = new THREE.Group();
  stack.name = 'bmad-hats';
  let y = HEAD_TOP;
  for (const [index, badge] of badges.slice(0, MAX_HATS).entries()) {
    const hat = buildHat(badge);
    const scale = SHRINK ** index;
    hat.group.userData = { badge, hat: hat.kind };
    hat.group.position.y = y;
    hat.group.scale.multiplyScalar(scale);
    // A pile, not a tower: each hat leans a little the other way.
    if (index > 0) hat.group.rotation.z += index % 2 === 0 ? 0.12 : -0.12;
    stack.add(hat.group);
    y += hat.height * scale;
  }
  if (badges.length > MAX_HATS) stack.add(moreMarker(badges.length - MAX_HATS, y));
  return stack;
}

function removeStack(entry: Worn): void {
  if (!entry.stack) return;
  // Hat shapes are shared by every hat of the kind (see hats.ts): only the marker goes
  entry.stack.traverse((object) => {
    if (object instanceof CSS2DObject) object.element.remove();
  });
  entry.stack.removeFromParent();
  entry.stack = null;
}

function showNames(managed: ManagedAgent, badges: string[]): void {
  const line = managed.figure.label.element.querySelector('.activity');
  if (!line) return;
  const base = activityLabel(managed.info);
  line.textContent = badges.length > 0 ? `${base} · ${badges.map(personaName).join(', ')}` : base;
}

function badgesOf(managed: ManagedAgent): string[] {
  const badges = managed.info.extras?.badges;
  return Array.isArray(badges) ? badges.filter((badge) => typeof badge === 'string') : [];
}

export const bmadHats: OfficeExtension = {
  id: 'bmad-hats',
  plugin: 'bmad',
  agentsChanged(agents: ManagedAgent[]) {
    const present = new Set<string>();
    for (const managed of agents) {
      present.add(managed.info.id);
      const badges = badgesOf(managed);
      const key = badges.join(',');
      let entry = worn.get(managed.info.id);
      if (entry && entry.figure !== managed.figure) {
        removeStack(entry);
        entry = undefined;
      }
      if (!entry) {
        if (badges.length === 0) continue;
        entry = { figure: managed.figure, key: '', stack: null };
        worn.set(managed.info.id, entry);
      }
      if (entry.key !== key) {
        removeStack(entry);
        if (badges.length > 0) {
          entry.stack = buildStack(badges);
          managed.figure.joints.head.add(entry.stack);
        }
        entry.key = key;
      }
      showNames(managed, badges);
      if (badges.length === 0) worn.delete(managed.info.id);
    }
    for (const [id, entry] of worn) {
      if (present.has(id)) continue;
      removeStack(entry);
      worn.delete(id);
    }
  },
};

registerExtension(bmadHats);
