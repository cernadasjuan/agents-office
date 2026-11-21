import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';

// Toon materials paint a gradient on a canvas at import time; rooms add signs and boards.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
dom.window.HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, {
  get: () => () => undefined,
  set: () => true,
})) as never;
const { buildRealSizeOffice, realSizeCameras, REAL_SIZE } = await import('./real-size-office.js');
const { countDrawCalls, DRAW_CALL_BUDGET } = await import('../src/scene/RenderBudget.js');
const { StaticBatch, STATIC_SOURCE_LAYER } = await import('../src/scene/StaticMerge.js');
const { FigureBatch } = await import('../src/characters/FigureBatch.js');
after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'document');
});

function vertexCount(meshes: THREE.Mesh[]): number {
  return meshes.reduce((sum, mesh) => sum + mesh.geometry.attributes.position.count, 0);
}

function countNamed(scene: THREE.Object3D, name: string): number {
  let count = 0;
  scene.traverse((object) => { if (object.name === name) count++; });
  return count;
}

test('the real-size fixture wears BMAD hats and GitHub cards, as with the fork plugins on', () => {
  const { scene, github } = buildRealSizeOffice();
  assert.equal(countNamed(scene, 'bmad-hats'), REAL_SIZE.hatWearers);
  assert.equal(countNamed(scene, 'github-cards'), 1, 'all cards are one mesh');
  assert.equal(new Set(github.cards.placements.map((placement) => placement.agentId)).size, REAL_SIZE.cardHolders);
});

/**
 * Review (issue #167 round 2): a pinned total alone cannot tell a bucket that is actually
 * built apart from one that quietly dropped out (the `code-review` loupe never won the hand
 * slot once, despite the fixture's own comments claiming full coverage — the pinned total
 * stayed stable because another kind's draw call happened to backfill the count). This checks
 * every mapped hand kind and both face kinds directly, by name (`plugins/skills/items.ts`'s
 * `group(kind, ...)`), so a future regression here fails on a readable kind name, not just a
 * number drifting by coincidence.
 */
test('the real-size fixture equips every hand-item and face-item kind this catalog maps (issue #167 round 2 review)', () => {
  const { scene } = buildRealSizeOffice();
  const expectedHandKinds = [
    'wrench', 'clipboard', 'gavel', 'loupe', 'stamp', 'easel-chart', 'open-book', 'magnifier', 'toolbox',
    'terminal-screen', 'pencil', 'globe',
  ];
  for (const kind of expectedHandKinds) {
    assert.ok(countNamed(scene, kind) > 0, `expected at least one agent to wear the "${kind}" hand item`);
  }
  for (const kind of ['glasses', 'headphones']) {
    assert.ok(countNamed(scene, kind) > 0, `expected at least one agent to wear the "${kind}" face item`);
  }
});

test('at the real size (25 rooms, 40 agents, hats and cards) a frame from each start view stays under the draw-call budget, shadow pass included', () => {
  const { scene, manager } = buildRealSizeOffice();
  scene.updateMatrixWorld();
  const cameras = realSizeCameras(scene);
  const before = countDrawCalls(scene, cameras.firstPerson);
  // Without the batches the same scene is far above the budget: the test can fail
  assert.ok(before.total > DRAW_CALL_BUDGET * 2, `unbatched ${JSON.stringify(before)}`);

  const statics = new StaticBatch(scene);
  statics.update();
  new FigureBatch(scene).sync(manager.getAgents().map((managed) => managed.figure.group));
  for (const [view, camera] of Object.entries(cameras)) {
    const after = countDrawCalls(scene, camera);
    console.log(`${view}: draw calls before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);
    assert.equal(after.shadowLights, 3);
    assert.ok(after.total < DRAW_CALL_BUDGET, `${view} batched ${JSON.stringify(after)}`);
  }
});

test('the count culls like the renderer: a mesh behind the camera or outside every lamp cone costs nothing', () => {
  const scene = new THREE.Scene();
  const light = new THREE.SpotLight(0xffffff, 1, 20, Math.PI / 3);
  light.castShadow = true;
  light.position.set(0, 5, 0);
  light.target.position.set(0, 0, 0);
  scene.add(light, light.target);
  const box = () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
    mesh.castShadow = true;
    scene.add(mesh);
    return mesh;
  };
  box().position.set(0, 0.5, 0); // seen by the camera and the lamp
  box().position.set(0, 0.5, 30); // behind the camera, outside the cone
  const always = box();
  always.position.set(50, 0.5, 50);
  always.frustumCulled = false; // an instanced batch: drawn in every pass
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(0, 2, 10);
  camera.lookAt(0, 0, 0);
  scene.updateMatrixWorld();
  camera.updateMatrixWorld();

  const culled = countDrawCalls(scene, camera);
  assert.deepEqual({ main: culled.main, shadowCalls: culled.shadowCalls, total: culled.total }, { main: 2, shadowCalls: 2, total: 4 });
  // Without a camera the count stays the worst case: every mesh, every caster for every light
  const worst = countDrawCalls(scene);
  assert.deepEqual({ main: worst.main, shadowCalls: worst.shadowCalls, total: worst.total }, { main: 3, shadowCalls: 3, total: 6 });
});

test('with 5 issue cards on each of the 40 agents the frame stays under the draw-call budget', () => {
  const { scene, manager, github } = buildRealSizeOffice();
  const agents = manager.getAgents();
  agents.forEach((managed, a) => {
    managed.info.extras = { ...managed.info.extras, issues: Array.from({ length: 5 }, (_, i) => ({ number: a * 10 + i + 1, title: '', repo: 'agents-office', color: '0e8a16' })) };
  });
  github.agentsChanged(agents);
  const cards = github.cards;
  scene.updateMatrixWorld();
  new StaticBatch(scene).update();
  new FigureBatch(scene).sync(agents.map((managed) => managed.figure.group));
  const after = countDrawCalls(scene);

  console.log(`draw calls with 200 cards ${JSON.stringify(after)}`);
  assert.equal(cards.placements.length, 200);
  assert.ok(after.total < DRAW_CALL_BUDGET, `with cards ${JSON.stringify(after)}`);
  // This is the worst case this suite measures. It was 466 before issue #121/#122 (main-room
  // desks and furniture), then dropped to 367 once the perf-shadow-budget PR recovered
  // headroom and moved DRAW_CALL_BUDGET to 430. The library wing move, the persona-badge
  // routing fix and the Librarian hat (issues #120/#128/#149) land it at 372, with the hat
  // genuinely worn (`tests/real-size-office.ts`'s own PERSONAS list, issue #128 review) and
  // its one source of randomness seeded (the library's bookshelves, same file, issue #128
  // review round 2: an unseeded book count and color made this total drift between runs,
  // 368 to 372, depending on how many book colors a shelf happened to draw). Two more things
  // land on top of 372, together in this round, 402: issue #176's per-room ceilings (every
  // room's ceiling merges into the one shared zone `buildCeiling` marks it for, `rooms.ts`'s
  // `CEILING_ZONE`; `FrameLoop` toggles that *merged* mesh's own `visible` by name on a view
  // switch, review, #184 round 2, not each source's, so the cost is one call for every room's
  // ceiling together, war rooms included now that they build one too), and the mission
  // wing's own furniture package (issue #125: a clock, whiteboard, bookshelf, sofa, low
  // table, water cooler, TV, low divider, debug station and desk per war room, up to 9 of
  // them, a new piece-type variety the fixture did not carry before), landing it at 402 on
  // `origin/main` (ceilings plus the mission furniture package). Issue #159's tombstone
  // engraving adds one more on top of that merge: a single instanced draw call for the whole
  // scene's engraved names (`TombstoneNameBatch`), however many tombstones exist, landing it
  // at 403. Issue #209 recovers 3 (war-room sofa and low table gone, a guaranteed base desk
  // and debug station added), landing it at 400 on #209 alone. The Hero look (issue #165
  // round 2: a face and seeded hair on every figure, chunky proportions on the existing body
  // shapes) adds 6 more on top of that: 1 bucket for the shared eye shape, 1 for the mouth
  // (every agent in this fixture starts idle, so all 40 share the one 'neutral' bucket), and
  // the rest for however many of the 3 non-'none' hair kinds (cap, spiky, bun) this fixture's
  // 40 seeded names land on — re-measured with both changes in, landing it at 406, not a
  // hand-picked 400 + 6. The skills equipment catalog v1 (issue #167) adds one bucket per
  // hand-item kind this round's `HAND_MAP` maps (`plugins/skills/items.ts` — wrench,
  // clipboard, gavel, loupe, stamp, easel-chart, open-book, magnifier, the unmapped-skill
  // toolbox fallback; jira and klever-mr share the one clipboard bucket, tinted apart, never
  // a second one), plus 2 buckets each for the 2 face items (glasses, headphones — each built
  // from 2 distinct primitive shapes). The tool crib (issue #167 addendum,
  // `src/furniture/ToolCrib.ts`, a small static counter in the hall) adds 2 more merged draw
  // calls (one per material it uses, `StaticMerge.ts`'s one-mesh-per-material rule — the
  // counter and its legs share one, every tool prop on it shares the other). Round 2 (issue
  // #167 review) extends the server enricher to also track a fixed allow-list of raw
  // built-in tool calls (`plugins/skills/index.ts`'s `TOOL_ALLOWLIST`) and keys 3 more
  // catalog items on it (`terminal-screen` for `Bash`, `pencil` for `Edit`/`Write`, `globe`
  // for `WebSearch`/`WebFetch` — `Grep`/`Glob` reuse the existing `magnifier` bucket and
  // `Read` reuses the existing `open-book` one, tinted apart from `research`'s the same way
  // `jira`/`klever-mr` already share `clipboard`, so neither spends a new bucket).
  // `tests/real-size-office.ts`'s `skillsFor`/`toolsFor`/`lastEquipSourceFor` deliberately
  // exercise every one of these kinds, not a subset that would undercount the real worst
  // case — re-measured with every change in (#209, the Hero look, and the full equipment
  // catalog together), not a hand-picked sum, landing it at 424, not 423 (review: the first
  // `lastEquipSourceFor` alternation let `code-review`'s loupe silently never win the hand
  // slot, since its only two non-suppressed occurrences both landed on the `tool`-wins side
  // of an `i % 2` split; it now alternates per full lap of `SKILL_SEQUENCES` instead, so
  // every mapped kind actually gets built at least once before this baseline is pinned).
  // Pinned here at 427, 424 plus 3: real headroom above the number this fixture actually and
  // repeatably measures, not a number nobody reproduces. Each PR gets a deliberate, reviewed
  // addition against the 424 baseline before it must recover headroom elsewhere, not just
  // add to the margin left by the last one. 3 points of headroom remain against the 430 cap
  // — the next addition should still trim an existing item kind before asking for more
  // budget (Gabriel: raise the cap only after measuring his own laptop).
  //
  // Issue #218 steps 2/3: the hex Hub and Office (always built, not opt-in, side by side with
  // this fixture's own rect rooms) add 4 more merged draw calls — hex walls (1 material), both
  // hex floors sharing one material (review: a two-tone split was purely cosmetic, not worth
  // a 5th call), the walkway deck plus both stair ramps (1 material), and the Hub's placeholder
  // elevator/kitchen/play corner (1 material). None of the new geometry casts a shadow, so
  // this is a main-pass-only cost. New pin: 428, 2 points of headroom left against the 430
  // cap — not free money: the budget rule from issue #217 is that every later step which adds
  // hex geometry pays for itself by deleting the rect-building code it replaces in the same
  // PR (step 4 deletes the rect library's room path, step 5 deletes the mission corridor), so
  // this never needs a cap raise before step 7 deletes the legacy rect system outright.
  assert.ok(after.total <= 428, `worst case ${after.total} exceeds the pinned baseline (428, issue #218 steps 2/3)`);
});

test('the worst case measures the same total every run: the fixture\'s one random draw is seeded (issue #128 review round 2)', () => {
  const totals = new Set<number>();
  for (let run = 0; run < 8; run++) {
    const { scene, manager, github } = buildRealSizeOffice();
    const agents = manager.getAgents();
    agents.forEach((managed, a) => {
      managed.info.extras = { ...managed.info.extras, issues: Array.from({ length: 5 }, (_, i) => ({ number: a * 10 + i + 1, title: '', repo: 'agents-office', color: '0e8a16' })) };
    });
    github.agentsChanged(agents);
    scene.updateMatrixWorld();
    new StaticBatch(scene).update();
    new FigureBatch(scene).sync(agents.map((managed) => managed.figure.group));
    totals.add(countDrawCalls(scene).total);
  }
  // 402, not the pre-#176/#182 372: every room's ceiling merges into one mesh (one more call
  // together, not one per room), and the mission wing's own furniture package (issue #125)
  // added to this fixture; see the baseline comment above. 402 became 403 with issue #159's
  // tombstone engraving: one instanced draw call for the whole scene's engraved names, not
  // one per tombstone (`TombstoneNameBatch`), so the full MAX_TOMBSTONES cap across all 9
  // mission rooms this fixture builds still only costs +1. Issue #209's war-room base work
  // set (sofa and low table removed, a base desk and debug station guaranteed) drops it to
  // 400 on #209 alone; see the baseline comment above. The Hero look (issue #165 round 2)
  // adds its own 6 buckets on top of that (406), then the full skills equipment catalog
  // (issue #167: v1, the tool crib, and the raw-tool review round together) adds the rest —
  // re-measured with everything in, not a hand-picked sum, landing it at 424 (not the
  // first-pass undercount of 423: see the baseline comment above). Still exactly one value
  // across all 8 runs — the fixture's own seeded names (`tests/real-size-office.ts`) never
  // change which hair style, face state or equipped item an agent lands on between runs, and
  // the tool crib is one fixed static piece.
  // 424 became 428 with issue #218 steps 2/3: the hex Hub and Office build unconditionally
  // (not behind a flag), so this fixture's own scene carries them too — see the baseline
  // comment in the test above for the +4 breakdown and the pay-for-itself budget rule.
  assert.deepEqual([...totals], [428], `expected every one of 8 runs to measure 428, got ${[...totals]}`);
});

test('the merge keeps every visible furniture triangle: merged vertices equal the source vertices', () => {
  const { scene } = buildRealSizeOffice();
  scene.updateMatrixWorld();
  const statics = new StaticBatch(scene);
  statics.update();
  const sources: THREE.Mesh[] = [];
  scene.traverse((object) => {
    if ((object as THREE.Mesh).isMesh && object.layers.isEnabled(STATIC_SOURCE_LAYER)) sources.push(object as THREE.Mesh);
  });
  assert.ok(sources.length > 2000, `${sources.length} merged sources`);
  assert.equal(vertexCount(statics.mergedMeshes), vertexCount(sources));
  const sourceMaterials = new Set(sources.map((mesh) => mesh.material));
  for (const mesh of statics.mergedMeshes) assert.ok(sourceMaterials.has(mesh.material), 'a merged mesh uses a source material');
});

test('a second update with no change rebuilds nothing', () => {
  const { scene } = buildRealSizeOffice();
  scene.updateMatrixWorld();
  const statics = new StaticBatch(scene);
  assert.equal(statics.update(), true);
  assert.equal(statics.update(), false);
});

test('a sprite (a room label) counts as one camera draw call and casts no shadow', () => {
  const scene = new THREE.Scene();
  const before = countDrawCalls(scene).main;
  scene.add(new THREE.Sprite(new THREE.SpriteMaterial()));
  const after = countDrawCalls(scene);
  assert.equal(after.main, before + 1);
  assert.equal(after.shadowCasters, 0);
});
