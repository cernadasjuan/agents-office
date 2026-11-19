import * as THREE from 'three';
import { createScene } from './scene/SceneSetup.js';
import { createOffice } from './scene/Office.js';
import { AgentManager } from './agents/AgentManager.js';
import { ViewController } from './scene/ViewController.js';
import { onSelectionChange, selectAgent } from './scene/Selection.js';
import { AgentPoller } from './agents/AgentPoller.js';
import { AgentPanel } from './ui/AgentPanel.js';
import { chooseLayoutId, createLayout, layoutIds, rememberLayoutId } from './layout/registry.js';
import { activeExtensions, setWorld, type World } from './extensions.js';

// Setup scene
const { scene, camera, renderer, labelRenderer } = createScene();

// Build office and get stations
const stations = createOffice(scene);

// Fork add-ons and the browser parts of server plugins register layouts and extensions.
// Both folders are optional: without them nothing changes.
import.meta.glob('./addons/*.ts', { eager: true });
import.meta.glob('../plugins/*/client.ts', { eager: true });

// Layout: ?layout= in the URL, then the last choice, then the default. Key L cycles layouts.
const layoutId = chooseLayoutId(window.location.search, window.localStorage);
rememberLayoutId(layoutId, window.localStorage);
window.addEventListener('keydown', (event) => {
  if (event.key !== 'l' && event.key !== 'L') return;
  if (document.pointerLockElement || event.target instanceof HTMLSelectElement) return;
  const ids = layoutIds();
  const next = ids[(ids.indexOf(layoutId) + 1) % ids.length];
  rememberLayoutId(next, window.localStorage);
  const url = new URL(window.location.href);
  url.searchParams.delete('layout');
  window.location.assign(url);
});

// Agent manager
const agentManager = new AgentManager(scene, createLayout(layoutId, scene, stations));

// Camera mode (first person by default, key O for the overview) and click to select.
// `#view=overview` starts in the overview, `#focus=<agent id>` selects that agent once it appears.
const view = new ViewController({
  camera,
  canvas: renderer.domElement,
  scene,
  agents: () => agentManager.getAgents(),
  keys: window,
  hint: document.getElementById('pointer-hint'),
  hash: window.location.hash,
});

// --- UI Panel ---
const panel = new AgentPanel(
  document.getElementById('agent-list')!,
  (agentId, activity) => agentManager.setActivity(agentId, activity),
  (agentId) => selectAgent(agentId),
);
onSelectionChange((agentId) => panel.setSelected(agentId));

function buildUI(): void {
  panel.render(agentManager.getAgents().map((managed) => managed.info));
  view.agentsChanged(agentManager.getAgents());
  for (const extension of activeExtensions(scene)) extension.agentsChanged?.(agentManager.getAgents());
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
poller.start(3000, buildUI);

// --- Render loop ---
const clock = new THREE.Clock();

function animate(): void {
  requestAnimationFrame(animate);

  const delta = clock.getDelta();
  const elapsed = clock.getElapsedTime();

  view.update(elapsed, delta);
  agentManager.update(elapsed, delta);
  for (const extension of activeExtensions(scene)) extension.update?.(elapsed, delta);

  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
}

animate();
