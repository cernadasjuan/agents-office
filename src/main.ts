import * as THREE from 'three';
import { createScene } from './scene/SceneSetup.js';
import { createOffice } from './scene/Office.js';
import { AgentManager } from './agents/AgentManager.js';
import { updateFreeCamera } from './scene/FreeCamera.js';
import { AgentPoller } from './agents/AgentPoller.js';
import { AgentPanel } from './ui/AgentPanel.js';

// Setup scene
const { scene, camera, renderer, labelRenderer } = createScene();

// Build office and get stations
const stations = createOffice(scene);

// Agent manager
const agentManager = new AgentManager(scene, stations);

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
