import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { registerExtension, type OfficeExtension, type World, type WorldLibrarySection } from '../../src/extensions.js';
import { ALL_FLOORS, matchesFloor } from '../../src/floors/FloorRegistry.js';
import { focusedFloor } from '../../src/floors/floorState.js';

/**
 * Library shelves (issue #191 AC1, #119): a self-contained extension that attaches to whatever
 * library room the building layout already built, the same pattern `plugins/jira/client.ts`
 * uses for its office board — no runtime import of `RoomPlanner.ts`/`BuildingLayout.ts`, no
 * geometry change there. Degrades to nothing without the room in the scene (another layout,
 * or the building has not grown a library yet — it always does, but this never assumes it),
 * without a focused floor (`ALL_FLOORS`: no single floor to key "the focused floor's library"
 * off, so this shows nothing rather than guessing one), or without that floor's own library
 * in `/api/world`.
 */

/** The library is always the second room rented (`RoomPlanner.ts`'s `FIRST_RING[1]`,
 * `BuildingLayout`'s constructor always adds it right after the office), so its group name is
 * as stable as `plugins/jira/client.ts`'s own `OFFICE_ROOM_NAME`. */
const LIBRARY_ROOM_NAME = 'room-1-library';

/** The library's own fixed slot (`RoomPlanner.ts`'s `slotFor(1)`): rect
 * `{minX:15,maxX:27,minZ:6,maxZ:18}`, door `{side:'west',at:9.5}`. Used only for the detail
 * sign's hover rect (`LabelDetailController`), the same floor-plane rect a room label or a
 * mission sign already carries. */
const LIBRARY_RECT = { minX: 15, maxX: 27, minZ: 6, maxZ: 18 };

/**
 * World positions for up to 3 shelf signs, precomputed through the library's own `RoomFrame`
 * math (`rooms.ts`): `inward = (1,0,0)`, `along = (0,0,1)`, `doorWallCenter = (15,0,12)`, so
 * `point(a, d, y) = (15+d, y, 12+a)`. `d = 11.5` is the far wall, the same depth
 * `furnishLibrary` already shelves at; `a` in `[-1.3, 0, 1.3]` sits inside the open middle gap
 * that plan leaves on purpose (its own shelves sit off-center at `a = +/-2.2` and `+/-3.9`), so
 * a sign never shares wall space with a shelf.
 */
const SIGN_POSITIONS: Array<[number, number, number]> = [
  [26.5, 1.9, 10.7],
  [26.5, 1.9, 12],
  [26.5, 1.9, 13.3],
];
const MAX_SECTIONS_SHOWN = SIGN_POSITIONS.length;
const MAX_ENTRY_LINES = 4;

function plaqueElement(section: WorldLibrarySection): HTMLDivElement {
  const element = document.createElement('div');
  element.textContent = section.name;
  Object.assign(element.style, {
    background: 'rgba(90, 74, 58, 0.9)', color: '#f5f0e8', padding: '2px 8px', borderRadius: '4px',
    font: '600 13px system-ui, sans-serif', whiteSpace: 'nowrap', pointerEvents: 'none',
  });
  return element;
}

function boardElement(section: WorldLibrarySection): HTMLDivElement {
  const element = document.createElement('div');
  Object.assign(element.style, {
    background: 'rgba(247, 243, 234, 0.95)', color: '#2a2a3e', padding: '4px 8px', borderRadius: '4px',
    font: '12px system-ui, sans-serif', whiteSpace: 'nowrap', pointerEvents: 'none', textAlign: 'left',
  });
  for (const entry of section.entries.slice(0, MAX_ENTRY_LINES)) {
    const line = document.createElement('div');
    line.textContent = entry.archived ? `${entry.title} (archived)` : entry.title;
    if (entry.archived) line.style.opacity = '0.65';
    element.appendChild(line);
  }
  if (section.truncated) {
    const more = document.createElement('div');
    more.textContent = '…more on this shelf';
    more.style.opacity = '0.65';
    element.appendChild(more);
  }
  return element;
}

interface MountedShelf {
  plaque: CSS2DObject;
  board: CSS2DObject;
}

export class FloorLibraryOfficeExtension implements OfficeExtension {
  readonly id = 'floor-library-shelves';
  readonly plugin = 'floor-library';
  private scene: THREE.Scene | null = null;
  private shelves: MountedShelf[] = [];
  private signature = '';

  start(scene: THREE.Scene): void {
    this.scene = scene;
  }

  worldChanged(world: World): void {
    if (!this.scene) return;
    const floor = focusedFloor();
    const library = floor === ALL_FLOORS ? undefined : (world.libraries ?? []).find((candidate) => matchesFloor(floor, candidate.repo));
    const room = this.scene.getObjectByName(LIBRARY_ROOM_NAME);
    const sections = room && library ? library.sections.slice(0, MAX_SECTIONS_SHOWN) : [];
    const signature = JSON.stringify(sections);
    if (signature === this.signature) return;
    this.signature = signature;
    this.unmountAll();
    sections.forEach((section, index) => this.mount(section, index));
  }

  private mount(section: WorldLibrarySection, index: number): void {
    const position = SIGN_POSITIONS[index];
    if (!position || !this.scene) return;
    const plaque = new CSS2DObject(plaqueElement(section));
    plaque.position.set(position[0], position[1] + 0.5, position[2]);
    plaque.userData.detailSign = { rect: LIBRARY_RECT, hoverOnly: false };
    const board = new CSS2DObject(boardElement(section));
    board.position.set(...position);
    board.userData.detailSign = { rect: LIBRARY_RECT, hoverOnly: true };
    this.scene.add(plaque, board);
    this.shelves.push({ plaque, board });
  }

  private unmountAll(): void {
    for (const shelf of this.shelves) {
      shelf.plaque.removeFromParent();
      shelf.board.removeFromParent();
    }
    this.shelves = [];
  }
}

registerExtension(new FloorLibraryOfficeExtension());
