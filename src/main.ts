import { createScene } from './scene/SceneSetup.js';
import { createOffice } from './scene/Office.js';
import { AgentManager } from './agents/AgentManager.js';
import { ViewController } from './scene/ViewController.js';
import { onSelectionChange, selectAgent, selectOrFly, selectedAgentId } from './scene/Selection.js';
import { AgentPoller } from './agents/AgentPoller.js';
import { AgentPanel, expandPanel, isDemoMode, setupPanelCollapse } from './ui/AgentPanel.js';
import { chooseLayoutId, confirmLayoutSwitch, createLayout, defaultViewFor, isLayoutSwitchKey, layoutName, rememberLayoutId, reloadForLayoutSwitch } from './layout/registry.js';
import { chooseViewMode, rememberViewMode, viewStatusText } from './scene/ViewMemory.js';
import { activeExtensions, currentWorld, setWorld, type World } from './extensions.js';
import { nextInQueue, tabTitleFor, triageQueue } from './ui/attention.js';
import { LabelDetailController } from './ui/LabelDetail.js';
import { AgentCard } from './ui/AgentCard.js';
import { TombstoneCard } from './ui/TombstoneCard.js';
import { MissionIssuesCard } from './ui/MissionIssuesCard.js';
import { LibraryCard } from './ui/LibraryCard.js';
import { OffscreenMarkers } from './ui/OffscreenMarkers.js';
import { FrameLoop } from './scene/FrameLoop.js';
import { FrameStats, isDebugMode } from './scene/RenderScheduler.js';
import { FreshnessFooter } from './ui/freshness.js';
import { Legend } from './ui/Legend.js';
import { handleTriageKey } from './ui/TriageKeys.js';
import { FloorSwitch } from './ui/FloorSwitch.js';
import { ALL_FLOORS, defaultFloor, floorsWithStoredRooms, rememberFloor, reloadForFloorSwitch } from './floors/FloorRegistry.js';
import { focusedFloor, setFocusedFloor } from './floors/floorState.js';
import { isLibrarySceneSearch, libraryEntryUrl } from './library/sceneNav.js';
import { consumeReturningFromLibrary, navigateAfterTransition, removeTransition, showTransition } from './library/transition.js';

/**
 * Issue #239: the library stopped being a room inside this scene; it is its own scene now
 * (Gabriel's "different dimension" idea). `?scene=library` in the URL is the one seam
 * (`src/library/sceneNav.ts`) that decides which of the two boots runs; this file's own
 * office bootstrap (everything below) is otherwise unchanged from before that scene existed.
 */
function bootOffice(): void {

// Setup scene
const { scene, camera, renderer, labelRenderer } = createScene();

// Issue #239: a brief "welcome back" overlay, shown only right after the library's own back
// door navigated here (`consumeReturningFromLibrary` clears the flag so an ordinary reload
// never replays it) — never added to every ordinary office load.
if (consumeReturningFromLibrary()) {
  const overlay = showTransition('Welcome back.');
  window.setTimeout(() => removeTransition(overlay), 420);
}

// Build office and get stations
const stations = createOffice(scene);

// Fork add-ons and the browser parts of server plugins register layouts and extensions.
// Both folders are optional: without them nothing changes.
import.meta.glob('./addons/*.ts', { eager: true });
import.meta.glob('../plugins/*/client.ts', { eager: true });

// Layout: ?layout= in the URL, then the last choice, then the default. Shift+L, then a confirmation, cycles layouts.
const layoutId = chooseLayoutId(window.location.search, window.localStorage);
rememberLayoutId(layoutId, window.localStorage);

// Floors (issue #118): meaningful only for the building layout (the flat activity layout is
// one shared office, P8, no floors). The floor to focus: `#floor=` in the URL, the last
// visited floor, else `ALL_FLOORS` (review: a fresh page load has not polled any agent yet,
// so there is nothing to pick a "busiest floor" default from before the first poll answers;
// showing everything, same as today, is the only safe default at that point — the
// floor-switch menu lets the user narrow to one floor once agents are known).
const chosenFloor = layoutId === 'building' ? (() => {
  const floor = defaultFloor(window.localStorage, window.location.hash);
  setFocusedFloor(floor);
  rememberFloor(floor, window.localStorage);
  return floor;
})() : undefined;
// `ALL_FLOORS` means no filter: `AgentPoller`/`BuildingLayout`/the triage panel only know
// about an actual floor name or "unset", never the sentinel itself, so it is normalized
// away right here, once, for every consumer below.
const focusFloor = chosenFloor !== undefined && chosenFloor !== ALL_FLOORS ? chosenFloor : undefined;
window.addEventListener('keydown', (event) => {
  if (!isLayoutSwitchKey(event) || document.pointerLockElement) return;
  const next = confirmLayoutSwitch(layoutId, (question) => window.confirm(question));
  if (!next) return;
  rememberLayoutId(next, window.localStorage);
  reloadForLayoutSwitch(window.location);
});

// Agent manager
const layout = createLayout(layoutId, scene, stations);
const agentManager = new AgentManager(scene, layout);

// Agent card: opens on a selection, docked left of the triage panel. Plugins add buttons and links.
const agentCard = new AgentCard(document.body, { anchor: document.getElementById('ui-panel')! });
// Tombstone card (issue #127): same dock spot, same selection; shares it with the agent card
// since a tombstone id never matches an agent id, so only one of the two ever shows.
const tombstoneCard = new TombstoneCard(document.body, { anchor: document.getElementById('ui-panel')! });
// Mission issues card (issue #146): same dock spot and selection, a click on a war room's issue board opens it.
const missionIssuesCard = new MissionIssuesCard(document.body, { anchor: document.getElementById('ui-panel')! });
// Library card (issue #221): same dock spot and selection, a click on a shelf entry or a
// section label (`plugins/floor-library/client.ts`'s own pick targets) opens it.
const libraryCard = new LibraryCard(document.body, { anchor: document.getElementById('ui-panel')! });

// Camera mode (key I toggles first person and the isometric view) and click to select.
// Start view: `#view=first-person|iso|desk`, then the last view, then the layout default.
// `#select=<agent id>` (`#focus=`, its older name, still works) selects that agent once it
// appears. `#zoom=<distance>` starts at that camera distance. `#room=<name>` frames a room
// from the active layout (issue #89); a layout with no rooms, or an unknown name, is a no-op.
// The panel header shows the layout and the view.
const viewStatus = document.getElementById('view-status');
const view = new ViewController({
  camera,
  canvas: renderer.domElement,
  scene,
  agents: () => agentManager.getAgents(),
  tombstones: () => activeExtensions(scene).flatMap((extension) => extension.pickTargets?.() ?? []),
  roomView: (name) => layout.roomView?.(name) ?? null,
  deskView: () => layout.deskView?.() ?? null,
  roomAt: (x, z) => layout.roomAt?.(x, z) ?? null,
  wallColliders: () => layout.wallColliders?.() ?? [],
  keys: window,
  hint: document.getElementById('pointer-hint'),
  crosshair: document.getElementById('crosshair-dot'),
  hash: window.location.hash,
  view: chooseViewMode(window.location.hash, window.localStorage, defaultViewFor(layoutId)),
  modeChanged: (mode) => {
    rememberViewMode(mode, window.localStorage);
    if (viewStatus) viewStatus.textContent = viewStatusText(layoutName(layoutId), mode);
    // Issue #162: leaving desk mode walks a talker back to its queue spot, same as deselecting it.
    agentManager.setDeskTalker(mode === 'desk' ? selectedAgentId() : null);
  },
  figureShiftPx: () => agentCard.cameraShiftPx(),
  // Issue #239: double-clicking the library room swaps to its own scene instead of the normal
  // first-person teleport every other room kind gets.
  onEnterLibrary: () => {
    navigateAfterTransition('Entering the library…', () => {
      window.location.assign(libraryEntryUrl(window.location));
    });
  },
});

// --- Triage list (side panel) ---
// `?demo=1` adds the prototype activity menu to each row. Live polls overwrite a choice.
const panel = new AgentPanel(document.getElementById('agent-list')!, {
  onSelect: (agentId) => selectAgent(agentId),
  onPick: (agentId, activity) => agentManager.setActivity(agentId, activity),
  onTopCount: (agentId) => selectOrFly(agentId),
  demo: isDemoMode(window.location.search),
  // Issue #192: a row's own floor only shows while a specific floor is focused (never on
  // "All floors", same normalization `focusFloor` already gives the poller and the building).
  focusFloor,
});
setupPanelCollapse(document.getElementById('ui-panel')!, document.getElementById('ui-panel-toggle')!, window.localStorage);

// Floor switch (issue #118 AC3): only while the building layout is active. Choosing a
// different floor remembers it and reloads the page (the same pattern Shift+L already uses
// for a layout switch): a live teardown-and-rebuild of the whole building risks the render
// budget and the static-merge zones far more than a reload the user already expects.
const floorSwitchContainer = document.getElementById('floor-switch-container');
const floorSwitch = chosenFloor !== undefined && floorSwitchContainer
  ? new FloorSwitch(floorSwitchContainer, chosenFloor, {
    onSelect: (floor) => {
      rememberFloor(floor, window.localStorage);
      reloadForFloorSwitch(window.location, floor);
    },
  })
  : null;
if (floorSwitchContainer) floorSwitchContainer.hidden = floorSwitch === null;
onSelectionChange((agentId) => panel.setSelected(agentId));
// Issue #162: selecting a queued agent in desk mode walks it to the front of the desk; any
// other selection (or none) walks the previous talker, if any, back to its queue spot.
onSelectionChange((agentId) => agentManager.setDeskTalker(view.mode === 'desk' ? agentId : null));
// Footer: "Updated N s ago", amber after 2 failed polls, red after 5. "?" opens the legend.
const freshness = new FreshnessFooter(document.getElementById('panel-footer')!);
new Legend({ parent: document.body, button: document.getElementById('legend-button')!, keys: window, layout: layoutId, plugins: () => currentWorld().plugins });

// Off-screen markers: an arrow at the screen edge for each fresh wait outside the frame.
// A click flies to the agent and selects it, through the same selection the cards use.
// `avoid` keeps markers off the side panel: the panel's own rect, in canvas-local pixels.
const uiPanel = document.getElementById('ui-panel')!;
const offscreenMarkers = new OffscreenMarkers({
  container: document.getElementById('offscreen-markers')!,
  canvas: renderer.domElement,
  camera: () => view.activeCamera,
  onSelect: (agentId) => selectOrFly(agentId),
  avoid: () => {
    const panelRect = uiPanel.getBoundingClientRect();
    if (panelRect.width === 0 || panelRect.height === 0) return null;
    const canvasRect = renderer.domElement.getBoundingClientRect();
    return {
      left: panelRect.left - canvasRect.left,
      top: panelRect.top - canvasRect.top,
      right: panelRect.right - canvasRect.left,
      bottom: panelRect.bottom - canvasRect.top,
    };
  },
});

// Keyboard triage (issue #85): N the next agent in queue, F recenters and pulses Focus, / the filter field.
window.addEventListener('keydown', (event) => {
  handleTriageKey(event, {
    next: () => {
      const queue = triageQueue(agentManager.getAgents().map((managed) => managed.info));
      const next = nextInQueue(queue, selectedAgentId());
      if (next) selectAgent(next.id);
    },
    focus: () => {
      const current = selectedAgentId();
      if (current) {
        // Already selected: a reselect would be a no-op, so recenter directly.
        view.refocus(current);
      } else {
        const next = nextInQueue(triageQueue(agentManager.getAgents().map((managed) => managed.info)), null);
        if (!next) return;
        selectAgent(next.id); // flies there and opens the card through the normal selection path
      }
      agentCard.pulseFocus();
    },
    filter: () => {
      expandPanel(document.getElementById('ui-panel')!, document.getElementById('ui-panel-toggle')!, window.localStorage);
      panel.focusFilter();
    },
  });
});

// The beacon hint tooltip (issue #170 review): labels have `pointer-events: none`, so a title
// attribute there never shows. A small DOM element near the cursor, shown only while hovering
// an agent that calls for you; the agent card's own status line is the fallback everywhere else
// (first person with the pointer locked, no mouse to hover with).
const beaconTooltip = document.createElement('div');
beaconTooltip.className = 'beacon-tooltip';
beaconTooltip.hidden = true;
document.body.appendChild(beaconTooltip);

// Label detail: full labels only for waiting, selected, hovered or near agents. Key V or `#labels=all` shows all.
// War room signs show only when zoomed in, near or hovered.
const labelDetail = new LabelDetailController({
  agents: () => agentManager.getAgents(),
  camera,
  activeCamera: () => view.activeCamera,
  scene,
  changed: () => frameLoop.scheduler.request(),
  canvas: renderer.domElement,
  keys: window,
  viewMode: () => view.mode,
  zoomDistance: () => view.zoomDistance,
  deskMonitorCorners: () => layout.deskMonitorCorners?.() ?? [],
  pick: (x, y) => view.pickAt(x, y),
  selected: () => selectedAgentId(),
  hash: window.location.hash,
  indicator: document.getElementById('label-mode'),
  onHoverHint: (hint, point) => {
    beaconTooltip.hidden = hint === null || point === null;
    if (hint === null || point === null) return;
    beaconTooltip.textContent = hint;
    beaconTooltip.style.left = `${point.x + 14}px`;
    beaconTooltip.style.top = `${point.y + 14}px`;
  },
});
onSelectionChange(() => labelDetail.refresh());

function buildUI(): void {
  const agents = agentManager.getAgents();
  panel.render(agents.map((managed) => managed.info));
  agentCard.render(agents.map((managed) => managed.info));
  document.title = tabTitleFor(agents.map((managed) => managed.info.extras));
  view.agentsChanged(agents);
  // Issue #113: an agent-driven layout can grow or shrink the building (a new room seated),
  // so the isometric pan/zoom limits may need to catch up here too, not only after `pollWorld`.
  view.sceneChanged();
  labelDetail.sceneChanged();
  labelDetail.refresh();
  for (const extension of activeExtensions(scene)) extension.agentsChanged?.(agentManager.getAgents());
  frameLoop.sceneChanged();
}

// World: rooms and boards from server plugins, every 10 s, one request at a time.
let worldInFlight = false;
async function pollWorld(): Promise<void> {
  if (worldInFlight) return;
  worldInFlight = true;
  try {
    const res = await fetch('/api/world', { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return;
    const world = (await res.json()) as World;
    setWorld(world);
    for (const extension of activeExtensions(scene)) extension.worldChanged?.(world);
    tombstoneCard.render(world.rooms.flatMap((room) => room.sleepers ?? []));
    missionIssuesCard.render(world.rooms.map((room) => ({ id: room.id, title: room.title, issues: room.walls.issues ?? [] })));
    libraryCard.render(world.libraries ?? []);
    view.sceneChanged();
    labelDetail.sceneChanged();
    frameLoop.sceneChanged();
  } catch {
    // Keep the last world
  } finally {
    worldInFlight = false;
  }
}
void pollWorld();
window.setInterval(() => void pollWorld(), 10_000);

// Start polling for real agents (an empty office when none are found). `focusFloor` (issue
// #118 AC4) filters to one floor's sessions when the building layout is active; `onAgents`
// still sees the raw, unfiltered answer, so the floor-switch menu lists every floor with a
// tracked session, not only the focused one.
const poller = new AgentPoller(agentManager, undefined, focusFloor);
// Issue #191 review (revised): a floor chosen before it was renamed (the remote-naming
// revision, for example), or one that simply has no live agent right now, both render as a
// quiet building — its own stored rooms, its own mission war rooms and kanban boards, just
// with nobody currently in it. Neither forces a reload: a client-side snapshot of "who is
// active right now" cannot reliably tell a quiet-but-valid floor apart from one that is gone
// for good, so this never guesses. `floorSwitch.render` lists every floor with its own stored
// room list too (`floorsWithStoredRooms`), not only the floors agents are tracked on right
// now, so Gabriel can always leave a quiet floor through the menu himself.
poller.start(3000, buildUI, (health) => freshness.show(health), (agents) => {
  floorSwitch?.render(agents, floorsWithStoredRooms(window.localStorage));
});

// --- Render loop ---
// On demand, at most 30 fps, once a second when nothing moves. `?debug=1` exposes `window.__officeStats`.
const stats = isDebugMode(window.location.search) ? new FrameStats() : null;
const frameLoop = new FrameLoop({
  scene,
  camera,
  activeCamera: () => view.activeCamera,
  renderer,
  labelRenderer,
  update(elapsed, delta) {
    view.update(elapsed, delta);
    agentManager.update(elapsed, delta);
    labelDetail.update(performance.now());
    offscreenMarkers.refresh(agentManager.getAgents().map((managed) => ({
      id: managed.info.id,
      object: managed.figure.group,
      color: managed.figure.accentColor,
      wait: managed.info.extras,
    })));
    for (const extension of activeExtensions(scene)) extension.update?.(elapsed, delta);
  },
  // Issue #248: the library's own NPC (and any other extension's) decorative figures draw
  // through the exact same instanced batch real agents do, at the same near-zero marginal
  // draw-call cost — never their own unbatched meshes, which the office's own tight budget
  // (430, no headroom to spare) could not otherwise absorb.
  figures: () => [
    ...agentManager.getAgents().map((managed) => managed.figure.group),
    ...activeExtensions(scene).flatMap((extension) => extension.npcFigures?.() ?? []),
  ],
  mode: () => view.mode,
  animating: () => selectedAgentId() !== null,
  events: window,
  devicePixelRatio: () => window.devicePixelRatio,
  stats,
});
if (stats) Object.assign(window, { __officeStats: Object.assign(stats, { drawCalls: () => frameLoop.drawCalls(), cameraPosition: () => view.activeCamera.position.toArray(), viewMode: () => view.mode }) });
frameLoop.start((callback) => requestAnimationFrame(callback));
}

if (isLibrarySceneSearch(window.location.search)) {
  void import('./library/bootLibrary.js').then((module) => module.bootLibraryScene());
} else {
  bootOffice();
}
