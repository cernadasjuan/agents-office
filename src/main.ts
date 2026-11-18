import * as THREE from 'three';
import { createScene } from './scene/SceneSetup.js';
import { createOffice } from './scene/Office.js';
import { AgentManager } from './agents/AgentManager.js';
import { updateFreeCamera } from './scene/FreeCamera.js';
import { AgentPoller } from './agents/AgentPoller.js';
import { AgentPanel } from './ui/AgentPanel.js';
import { chooseLayoutId, createLayout, layoutIds, rememberLayoutId } from './layout/registry.js';

// Setup scene
const { scene, camera, renderer, labelRenderer } = createScene();

// Build office and get stations
const stations = createOffice(scene);

// Fork add-ons register extra layouts. The folder is optional: no add-ons, no change.
import.meta.glob('./addons/*.ts', { eager: true });

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

// --- UI Panel ---
const panel = new AgentPanel(
  document.getElementById('agent-list')!,
  (agentId, activity) => agentManager.setActivity(agentId, activity),
);

function buildUI(): void {
  panel.render(agentManager.getAgents().map((managed) => managed.info));
}

// Start polling for real agents (an empty office when none are found)
const poller = new AgentPoller(agentManager);
poller.start(3000, buildUI);

// --- Render loop ---
const clock = new THREE.Clock();

function animate(): void {
  requestAnimationFrame(animate);

  const delta = clock.getDelta();
  const elapsed = clock.getElapsedTime();

  updateFreeCamera(camera, delta);
  agentManager.update(elapsed, delta);

  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
}

animate();
