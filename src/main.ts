import { createScene } from './scene/SceneSetup.js';
import { createOffice } from './scene/Office.js';
import { AgentManager } from './agents/AgentManager.js';
import { ViewController } from './scene/ViewController.js';
import { onSelectionChange, selectAgent, selectedAgentId } from './scene/Selection.js';
import { AgentPoller } from './agents/AgentPoller.js';
import { AgentPanel, isDemoMode, setupPanelCollapse } from './ui/AgentPanel.js';
import { chooseLayoutId, confirmLayoutSwitch, createLayout, defaultViewFor, isLayoutSwitchKey, layoutName, rememberLayoutId, reloadForLayoutSwitch } from './layout/registry.js';
import { chooseViewMode, rememberViewMode, viewStatusText } from './scene/ViewMemory.js';
import { activeExtensions, currentWorld, setWorld, type World } from './extensions.js';
import { tabTitleFor } from './ui/attention.js';
import { LabelDetailController } from './ui/LabelDetail.js';
import { AgentCard } from './ui/AgentCard.js';
import { FrameLoop } from './scene/FrameLoop.js';
import { FrameStats, isDebugMode } from './scene/RenderScheduler.js';
import { FreshnessFooter } from './ui/freshness.js';
import { Legend } from './ui/Legend.js';

// Setup scene
const { scene, camera, renderer, labelRenderer } = createScene();

// Build office and get stations
const stations = createOffice(scene);

// Fork add-ons and the browser parts of server plugins register layouts and extensions.
// Both folders are optional: without them nothing changes.
import.meta.glob('./addons/*.ts', { eager: true });
import.meta.glob('../plugins/*/client.ts', { eager: true });

// Layout: ?layout= in the URL, then the last choice, then the default. Shift+L, then a confirmation, cycles layouts.
const layoutId = chooseLayoutId(window.location.search, window.localStorage);
rememberLayoutId(layoutId, window.localStorage);
window.addEventListener('keydown', (event) => {
  if (!isLayoutSwitchKey(event) || document.pointerLockElement) return;
  const next = confirmLayoutSwitch(layoutId, (question) => window.confirm(question));
  if (!next) return;
  rememberLayoutId(next, window.localStorage);
  reloadForLayoutSwitch(window.location);
});

// Agent manager
const agentManager = new AgentManager(scene, createLayout(layoutId, scene, stations));

// Agent card: opens on a selection, docked left of the triage panel. Plugins add buttons and links.
const agentCard = new AgentCard(document.body, { anchor: document.getElementById('ui-panel')! });

// Camera mode (key O toggles first person and the overview, key I the isometric view) and click to select.
// Start view: `#view=overview|first-person|iso`, then the last view, then the layout default.
// `#focus=<agent id>` selects that agent once it appears. The panel header shows the layout and the view.
const viewStatus = document.getElementById('view-status');
const view = new ViewController({
  camera,
  canvas: renderer.domElement,
  scene,
  agents: () => agentManager.getAgents(),
  keys: window,
  hint: document.getElementById('pointer-hint'),
  hash: window.location.hash,
  view: chooseViewMode(window.location.hash, window.localStorage, defaultViewFor(layoutId)),
  modeChanged: (mode) => {
    rememberViewMode(mode, window.localStorage);
    if (viewStatus) viewStatus.textContent = viewStatusText(layoutName(layoutId), mode);
  },
  figureShiftPx: () => agentCard.cameraShiftPx(),
});

// --- Triage list (side panel) ---
// `?demo=1` adds the prototype activity menu to each row. Live polls overwrite a choice.
const panel = new AgentPanel(document.getElementById('agent-list')!, {
  onSelect: (agentId) => selectAgent(agentId),
  onPick: (agentId, activity) => agentManager.setActivity(agentId, activity),
  demo: isDemoMode(window.location.search),
});
setupPanelCollapse(document.getElementById('ui-panel')!, document.getElementById('ui-panel-toggle')!, window.localStorage);
onSelectionChange((agentId) => panel.setSelected(agentId));
// Footer: "Updated N s ago", amber after 2 failed polls, red after 5. "?" opens the legend.
const freshness = new FreshnessFooter(document.getElementById('panel-footer')!);
new Legend({ parent: document.body, button: document.getElementById('legend-button')!, keys: window, layout: layoutId, plugins: () => currentWorld().plugins });

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
  pick: (x, y) => view.pickAt(x, y),
  selected: () => selectedAgentId(),
  hash: window.location.hash,
  indicator: document.getElementById('label-mode'),
});
onSelectionChange(() => labelDetail.refresh());

function buildUI(): void {
  const agents = agentManager.getAgents();
  panel.render(agents.map((managed) => managed.info));
  agentCard.render(agents.map((managed) => managed.info));
  document.title = tabTitleFor(agents.map((managed) => managed.info.extras));
  view.agentsChanged(agents);
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

// Start polling for real agents (an empty office when none are found)
const poller = new AgentPoller(agentManager);
poller.start(3000, buildUI, (health) => freshness.show(health));

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
    for (const extension of activeExtensions(scene)) extension.update?.(elapsed, delta);
  },
  figures: () => agentManager.getAgents().map((managed) => managed.figure.group),
  mode: () => view.mode,
  animating: () => selectedAgentId() !== null,
  events: window,
  devicePixelRatio: () => window.devicePixelRatio,
  stats,
});
if (stats) Object.assign(window, { __officeStats: Object.assign(stats, { drawCalls: () => frameLoop.drawCalls(), cameraPosition: () => view.activeCamera.position.toArray(), viewMode: () => view.mode }) });
frameLoop.start((callback) => requestAnimationFrame(callback));
