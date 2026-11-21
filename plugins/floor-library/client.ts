import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { registerExtension, type OfficeExtension, type World, type WorldLibrary, type WorldLibraryEntry, type WorldLibrarySection } from '../../src/extensions.js';
import { ALL_FLOORS, matchesFloor } from '../../src/floors/FloorRegistry.js';
import { focusedFloor } from '../../src/floors/floorState.js';
import { ROOM_SIZE, slotFor, type Door, type Rect, type Side } from '../../src/addons/building/RoomPlanner.js';
import type { PickTarget } from '../../src/scene/Selection.js';
import { libraryEntryId, libraryIndexId, librarySectionId } from '../../src/ui/LibraryCard.js';
import { StickFigure } from '../../src/characters/StickFigure.js';

/**
 * Library shelves (issue #191 AC1, #119; issue #221 AC1/AC2/AC4): a self-contained extension
 * that attaches to whatever library room the building layout already built, the same pattern
 * `plugins/jira/client.ts` uses for its office board. Degrades to nothing without the room in
 * the scene (another layout, or the building has not grown a library yet — it always does, but
 * this never assumes it), or without any library at all in `/api/world`. On a specific focused
 * floor, only that floor's own matching library shows (`matchesFloor`). On `ALL_FLOORS` (the
 * default view every cold start lands on), there is no single floor to key one off: this shows
 * every configured library's sections together, still bounded by `MAX_SECTIONS_SHOWN`.
 *
 * Issue #221: each shown entry is now its own clickable object (`src/ui/LibraryCard.ts`'s
 * entry card), not a line of inert text on a shared board; each section's own label is
 * clickable too (the section card, listing every file the section carries — not just the few
 * physically shown here). The server now carries up to 100 sections and 100 entries per
 * library (`plugins/floor-library/bibliotheque.ts`'s `MAX_SECTIONS`/`MAX_ENTRIES`), far more
 * than one shared room's own wall space can seat as individual shelves — see this module's own
 * `MAX_SECTIONS_SHOWN`/`MAX_ENTRY_LINES` below, and the "more" signs that keep the rest
 * reachable rather than hidden (AC1). Fitting the full catalog as physical shelves needs the
 * library's own scene (issue #220 slice 2, Gabriel's "different dimension" idea) — not
 * attempted here.
 */

/** The library's own group name, whatever index it actually rented at (`rooms.ts`'s
 * `buildRoom`: `room-${index}-${kind}`). `BuildingLayout`'s constructor force-adds a missing
 * library early, so it is almost always index 1, right after the office — but a floor whose
 * room list already existed before the library was always forced to exist can have it land at
 * a later index within the first ring (review round 1: a hardcoded `room-1-library` matched
 * nothing there, silently showing no shelves). This reads the room's real index back out of
 * its own name instead of assuming one. */
const LIBRARY_ROOM_PATTERN = /^room-(\d+)-library$/;

function findLibraryRoomIndex(scene: THREE.Scene): number | undefined {
  for (const child of scene.children) {
    const match = LIBRARY_ROOM_PATTERN.exec(child.name);
    if (match) return Number(match[1]);
  }
  return undefined;
}

const INWARD_BY_SIDE: Record<Side, [number, number]> = { west: [1, 0], east: [-1, 0], north: [0, 1], south: [0, -1] };

/**
 * A room's own door-wall-center point, `along` and `inward` directions, duplicated from
 * `rooms.ts`'s own `RoomFrame` (plain number math, no THREE needed for it): a plugin's client
 * extension stays self-contained rather than importing the room-building module's full THREE
 * dependency graph (toon materials, static-merge zones, furnishing plans) for one formula —
 * the same reason `server/floor.ts` keeps its own copy of `plugins/peek/transcript.ts`'s
 * `worktreeMain` instead of importing across that core/plugin boundary. `d` is the depth from
 * the door wall into the room, `a` runs along it; see `rooms.ts`'s own doc comment on `RoomFrame`.
 */
function shelfPoint(rect: Rect, door: Door, a: number, d: number, y: number): [number, number, number] {
  const [nx, nz] = INWARD_BY_SIDE[door.side];
  const doorWallX = (rect.minX + rect.maxX) / 2 - (nx * ROOM_SIZE) / 2;
  const doorWallZ = (rect.minZ + rect.maxZ) / 2 - (nz * ROOM_SIZE) / 2;
  return [doorWallX + -nz * a + nx * d, y, doorWallZ + nx * a + nz * d];
}

/**
 * Review (issue #221 FAIL round): a hit-test box's own long axis (local X, `ENTRY_HIT_GEOMETRY`/
 * `SECTION_HIT_GEOMETRY`'s 1.0/1.2 dimension) is built to run along the shelf row — the "a"
 * axis `shelfPoint` reads above — but that axis is world Z for a west/east door room and world
 * X for a north/south one (the same `(-nz, nx)` pair `shelfPoint` itself uses). Left unrotated,
 * every hit box pointed along world X regardless, so it lined up with the visible label only
 * in a north/south-door room and sat rotated 90° off it — wrong footprint, same area — in a
 * west/east-door one (today: the library room most commonly rents a west-door slot). A Y
 * rotation of this box is symmetric (the geometry is centered, so the sign of the angle
 * doesn't matter, only whether it's rotated at all): 0 for north/south, a quarter turn for
 * west/east.
 */
function hitRotationY(door: Door): number {
  return door.side === 'north' || door.side === 'south' ? 0 : Math.PI / 2;
}

/**
 * `d = 11.5` is the far wall, the same depth `furnishLibrary` already shelves at; `a` in
 * `[-1.3, 0, 1.3]` sits inside the open middle gap that plan leaves on purpose (its own
 * shelves sit off-center at `a = +/-2.2` and `+/-3.9`), so a sign never shares wall space with
 * a shelf. Both are the furnishing plan's own choice, not the slot's — they hold regardless of
 * which first-ring rect/door the library actually rented.
 *
 * `MAX_SECTIONS_SHOWN`/`MAX_ENTRY_LINES` are this shared room's own physical ceiling, separate
 * from the server's data cap (`bibliotheque.ts`'s `MAX_SECTIONS`/`MAX_ENTRIES`, 100 each):
 * three wall slots and four lines of vertical space each is what the room's furnishing plan
 * actually has, not a number chosen to match the server. A library past this (today: the real
 * Klever bibliothèque already has 14 top-level sections, each able to carry up to 100 files)
 * cannot seat every file as its own physical shelf in one shared room — the "more" signs below
 * keep the rest reachable (a card, one click away) rather than silently dropped.
 */
const SIGN_DEPTH = 11.5;
const SIGN_Y = 1.9;
const SIGN_ALONGS = [-1.3, 0, 1.3];
const MAX_SECTIONS_SHOWN = SIGN_ALONGS.length;
const MAX_ENTRY_LINES = 4;
/**
 * Review (issue #221 FAIL round): the section label and its first entry visually merged at a
 * normal isometric zoom. A CSS2D label never shrinks with distance (it is a fixed-size DOM
 * element wherever it projects to), but the screen-space *gap* between two labels' world
 * positions does shrink with distance, the same as anything else under perspective — 0.24
 * world units between entries (0.5 between the plaque and the first entry) was simply too
 * tight once that shrink was accounted for at a normal viewing distance. Both are wider now.
 */
const ENTRY_LINE_HEIGHT = 0.44;
const PLAQUE_GAP = 0.7;
/**
 * Round 7 feedback (#214, reconciled here since that PR and this one touch the same file):
 * these labels used to fade in and out depending on where the mouse pointed (`hoverOnly:
 * true`), only within the generic war-room-sign read distance — Gabriel wants to read them by
 * standing near the shelf, not by hunting for the one mouse position that reveals them. Every
 * sign here is `hoverOnly: false` with its own, more generous read distance instead.
 */
const LIBRARY_SIGN_MAX_DISTANCE = 20;

function plaqueElement(section: WorldLibrarySection): HTMLDivElement {
  const element = document.createElement('div');
  element.textContent = section.name;
  Object.assign(element.style, {
    background: 'rgba(90, 74, 58, 0.9)', color: '#f5f0e8', padding: '2px 8px', borderRadius: '4px',
    font: '600 13px system-ui, sans-serif', whiteSpace: 'nowrap', pointerEvents: 'none',
  });
  return element;
}

function entryElement(entry: WorldLibraryEntry): HTMLDivElement {
  const element = document.createElement('div');
  element.textContent = entry.archived ? `${entry.title} (archived)` : entry.title;
  Object.assign(element.style, {
    background: 'rgba(247, 243, 234, 0.95)', color: '#2a2a3e', padding: '2px 8px', borderRadius: '4px',
    font: '12px system-ui, sans-serif', whiteSpace: 'nowrap', pointerEvents: 'none', textAlign: 'left',
    opacity: entry.archived ? '0.65' : '1',
  });
  return element;
}

/** The "more" sign (issue #221 AC1): never a dead end. It carries whichever of two things is
 * true — more entries in this section than the shelf shows, more sections in the library than
 * the room shows — and is itself a pick target (`mount`'s own `moreId`), so neither is ever
 * only "visible as text with no way to actually reach it". */
function moreElement(lines: string[]): HTMLDivElement {
  const element = document.createElement('div');
  Object.assign(element.style, {
    background: 'rgba(247, 243, 234, 0.95)', color: '#2a2a3e', padding: '2px 8px', borderRadius: '4px',
    font: '12px system-ui, sans-serif', whiteSpace: 'nowrap', pointerEvents: 'none', textAlign: 'left', opacity: '0.75',
  });
  for (const line of lines) {
    const row = document.createElement('div');
    row.textContent = line;
    element.appendChild(row);
  }
  return element;
}

/** One section, tagged with the library it actually came from and its own index inside that
 * library's own `sections` array — `src/ui/LibraryCard.ts`'s `libraryEntryId`/
 * `librarySectionId` need both to look the right thing back up out of `/api/world`'s own data,
 * the same way a flattened `libraries.flatMap((l) => l.sections)` used to lose that boundary. */
interface MatchedSection {
  libraryId: string;
  sectionIndex: number;
  section: WorldLibrarySection;
}

function relevantLibraries(libraries: WorldLibrary[], floor: string): WorldLibrary[] {
  if (floor === ALL_FLOORS) return libraries;
  const match = libraries.find((candidate) => matchesFloor(floor, candidate.repo));
  return match ? [match] : [];
}

function matchedSections(libraries: WorldLibrary[], floor: string): MatchedSection[] {
  return relevantLibraries(libraries, floor).flatMap((library) =>
    library.sections.map((section, sectionIndex) => ({ libraryId: library.id, sectionIndex, section })));
}

/** Pure geometry for a shelf item's own invisible pick target (issue #221 AC2): no existing
 * mesh sits at an individual entry's own position the way a tombstone's or an issue board's
 * own mesh already does for `BuildingLayout`'s own pick targets — a shelf entry is CSS2D text,
 * nothing else — so this is a small box with `material.visible = false`. `RenderBudget.ts`'s
 * own `callsOf` skips a mesh whose material is not visible (0 draw calls, camera pass and every
 * shadow map alike); only `object.visible` (left at its default `true`) gates whether
 * `THREE.Raycaster` ever tests it at all, and this never touches that. A test
 * (`floor-library-client.test.ts`) asserts the render budget does not move.
 */
const ENTRY_HIT_GEOMETRY = new THREE.BoxGeometry(1.0, 0.22, 0.2);
const SECTION_HIT_GEOMETRY = new THREE.BoxGeometry(1.2, 0.32, 0.2);
const HIT_MATERIAL = new THREE.MeshBasicMaterial({ visible: false });
/** A standing figure's own hit box: tall and narrow, not the shelf signs' wide-and-flat shape. */
const NPC_HIT_GEOMETRY = new THREE.BoxGeometry(0.7, 1.7, 0.5);

/**
 * The librarian NPC (issue #248, Gabriel's own words: "doesn't do much... you can interact
 * with him, maybe he shows you the catalog"). Near the door, clear of the shelf signs
 * (`a` in `[-1.3, 0, 1.3]`, `d = SIGN_DEPTH`) and the room's own furnishing (`furnishing.ts`'s
 * `furnishLibrary`, off-center at `a = +/-2.2` and `+/-3.9`): `a = 4.8` sits just past that
 * outer shelf column, close to the door (`d = 2`) so Gabriel sees him on the way in, not
 * tucked against the far wall with the shelves themselves.
 */
const NPC_A = 4.8;
const NPC_D = 2;
const NPC_COLOR = 0x5a4a3a;

export class FloorLibraryOfficeExtension implements OfficeExtension {
  readonly id = 'floor-library-shelves';
  readonly plugin = 'floor-library';
  private scene: THREE.Scene | null = null;
  private mounted: THREE.Object3D[] = [];
  private picks: PickTarget[] = [];
  private signature = '';
  private slot: { rect: Rect; door: Door } | null = null;
  private npc: StickFigure | null = null;
  private npcHit: THREE.Mesh | null = null;
  private npcLibraryId: string | null = null;

  start(scene: THREE.Scene): void {
    this.scene = scene;
  }

  pickTargets(): PickTarget[] {
    return this.npcHit ? [...this.picks, { id: libraryIndexId(this.npcLibraryId!), object: this.npcHit }] : this.picks;
  }

  /** Issue #248: the librarian NPC draws through the shared figure batch, same as a real
   * agent, at the same near-zero marginal draw-call cost. */
  npcFigures(): THREE.Object3D[] {
    return this.npc ? [this.npc.group] : [];
  }

  worldChanged(world: World): void {
    if (!this.scene) return;
    const floor = focusedFloor();
    const matched = matchedSections(world.libraries ?? [], floor);
    const roomIndex = findLibraryRoomIndex(this.scene);
    this.slot = roomIndex === undefined ? null : slotFor(roomIndex);
    this.syncNpc(matched[0]?.libraryId);
    const sections = this.slot ? matched.slice(0, MAX_SECTIONS_SHOWN) : [];
    // Review (issue #221 FAIL round): with more than one library visible at once (`ALL_FLOORS`
    // combining them), the hidden-sections count used to be the *global* overflow across every
    // library combined, always attached to the last shown slot's own library — so a "+N more"
    // sign could point a library's index at sections that actually belong to a different
    // library entirely, which that index has no way to show. Scoped to "how many of THIS SAME
    // library's own sections didn't get a slot" instead, the count and the index it opens
    // always agree, however many libraries are configured.
    const lastLibraryId = sections.length > 0 ? sections[sections.length - 1]!.libraryId : undefined;
    const hiddenSections = this.slot && lastLibraryId !== undefined
      ? matched.filter((candidate) => candidate.libraryId === lastLibraryId).length
        - sections.filter((candidate) => candidate.libraryId === lastLibraryId).length
      : 0;
    const signature = `${roomIndex}:${JSON.stringify(sections)}:${hiddenSections}`;
    if (signature === this.signature) return;
    this.signature = signature;
    this.unmountAll();
    sections.forEach((matchedSection, index) => this.mount(matchedSection, index, index === sections.length - 1 ? hiddenSections : 0));
  }

  private mount(matched: MatchedSection, index: number, hiddenSections: number): void {
    const along = SIGN_ALONGS[index];
    if (along === undefined || !this.scene || !this.slot) return;
    const { rect, door } = this.slot;
    const { libraryId, sectionIndex, section } = matched;
    const rotationY = hitRotationY(door);
    const add = (object: THREE.Object3D): void => {
      this.scene!.add(object);
      this.mounted.push(object);
    };
    const addHit = (id: string, position: [number, number, number], geometry: THREE.BufferGeometry): void => {
      const hit = new THREE.Mesh(geometry, HIT_MATERIAL);
      hit.position.set(...position);
      hit.rotation.y = rotationY;
      add(hit);
      this.picks.push({ id, object: hit });
    };
    // Round 7 (#214): no longer hover-only, and read from `LIBRARY_SIGN_MAX_DISTANCE` away —
    // every sign in this room shares both, not just the section label.
    const detailSign = { rect, hoverOnly: false, maxDistance: LIBRARY_SIGN_MAX_DISTANCE };

    // The section label (issue #221 AC2): clickable, opens the section card listing every
    // file the section carries, not just the few shown below.
    const plaquePos = shelfPoint(rect, door, along, SIGN_DEPTH, SIGN_Y + PLAQUE_GAP);
    const plaque = new CSS2DObject(plaqueElement(section));
    plaque.position.set(...plaquePos);
    plaque.userData.detailSign = detailSign;
    plaque.userData.shelfRole = 'plaque';
    add(plaque);
    const sectionId = librarySectionId(libraryId, sectionIndex);
    addHit(sectionId, plaquePos, SECTION_HIT_GEOMETRY);

    // Each shown entry (issue #221 AC2): its own clickable object, its own line, stacked
    // downward from the shelf's own depth — no longer one shared board of inert text.
    const shown = section.entries.slice(0, MAX_ENTRY_LINES);
    shown.forEach((entry, entryIndex) => {
      const position = shelfPoint(rect, door, along, SIGN_DEPTH, SIGN_Y - entryIndex * ENTRY_LINE_HEIGHT);
      const object = new CSS2DObject(entryElement(entry));
      object.position.set(...position);
      object.userData.detailSign = detailSign;
      object.userData.shelfRole = 'entry';
      add(object);
      addHit(libraryEntryId(libraryId, sectionIndex, entryIndex), position, ENTRY_HIT_GEOMETRY);
    });

    // The "more" sign (issue #221 AC1): a section within the server's own cap can still carry
    // more entries than `MAX_ENTRY_LINES` physically shows here (review carried over from the
    // original board), and the last shown section can stand in for a whole library that
    // carries more sections than the three wall slots seat. Either reason, or both, still
    // mounts one sign — never silent, always one click from everything the cap actually holds.
    const hiddenEntries = section.truncated === true || section.entries.length > shown.length;
    if (hiddenEntries || hiddenSections > 0) {
      const lines: string[] = [];
      if (hiddenEntries) lines.push('…more on this shelf');
      if (hiddenSections > 0) lines.push(`+${hiddenSections} more section${hiddenSections === 1 ? '' : 's'} in the library`);
      const position = shelfPoint(rect, door, along, SIGN_DEPTH, SIGN_Y - shown.length * ENTRY_LINE_HEIGHT);
      const object = new CSS2DObject(moreElement(lines));
      object.position.set(...position);
      object.userData.detailSign = detailSign;
      object.userData.shelfRole = 'more';
      add(object);
      // The bigger reveal wins the click target when both apply: a whole missing library
      // section is a larger "never hidden" gap than a few extra files already reachable one
      // click away through the section card below — and the index itself still links back into
      // this very section (`src/ui/LibraryCard.ts`'s own index-to-section navigation), so
      // nothing here is actually a dead end either way. `hiddenSections` is already scoped to
      // this section's own library (`worldChanged`), so the index it opens always matches.
      addHit(hiddenSections > 0 ? libraryIndexId(libraryId) : sectionId, position, ENTRY_HIT_GEOMETRY);
    }
  }

  private unmountAll(): void {
    for (const object of this.mounted) object.removeFromParent();
    this.mounted = [];
    this.picks = [];
  }

  /**
   * The librarian NPC itself (issue #248): mounted once a library room and at least one
   * library's own catalog exist, torn down the moment either goes away (another layout, the
   * room not grown yet, or no library configured at all — the same graceful-degradation rule
   * every other part of this extension already follows). Never rebuilt on every section
   * remount: `worldChanged` calls this every poll regardless of the shelf `signature` gate, so
   * the figure stays the same `StickFigure` instance (and so the same figure-batch identity)
   * across ordinary polls, only actually changing hands when the room or the library itself
   * appears or disappears.
   */
  private syncNpc(libraryId: string | undefined): void {
    const shouldExist = this.slot !== null && libraryId !== undefined;
    if (!shouldExist) {
      if (this.npc) {
        this.npc.group.removeFromParent();
        this.npcHit?.removeFromParent();
        this.npc = null;
        this.npcHit = null;
        this.npcLibraryId = null;
      }
      return;
    }
    this.npcLibraryId = libraryId;
    if (this.npc) return; // already mounted; its position never needs to move once placed
    const { rect, door } = this.slot!;
    const position = shelfPoint(rect, door, NPC_A, NPC_D, 0);
    const lookAt = shelfPoint(rect, door, NPC_A, NPC_D + 4, 0);
    const npc = new StickFigure('Prospero', new THREE.Color(NPC_COLOR));
    npc.teleportTo(new THREE.Vector3(...position), new THREE.Vector3(...lookAt));
    this.scene!.add(npc.group);
    this.npc = npc;
    const hit = new THREE.Mesh(NPC_HIT_GEOMETRY, HIT_MATERIAL);
    hit.position.set(position[0], position[1] + 0.85, position[2]);
    this.scene!.add(hit);
    this.npcHit = hit;
  }
}

registerExtension(new FloorLibraryOfficeExtension());
