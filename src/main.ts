import * as THREE from 'three';
import { createScene } from './scene/SceneSetup.js';
import { createOffice } from './scene/Office.js';
import { AgentManager } from './agents/AgentManager.js';
import { ACTIVITIES, ACTIVITY_LABELS } from './agents/AgentData.js';
import { Activity } from './agents/ActivityAnimations.js';
import { updateFreeCamera } from './scene/FreeCamera.js';
import { AgentPoller } from './agents/AgentPoller.js';

// Setup scene
const { scene, camera, renderer, labelRenderer } = createScene();

// Build office and get stations
const stations = createOffice(scene);

// Agent manager
const agentManager = new AgentManager(scene, stations);

// --- UI Panel ---
function buildUI(): void {
  const listEl = document.getElementById('agent-list')!;
  listEl.innerHTML = '';

  for (const managed of agentManager.getAgents()) {
    const card = document.createElement('div');
    card.className = 'agent-card';

    const nameEl = document.createElement('div');
    nameEl.className = 'agent-name';
    nameEl.textContent = managed.info.name;
    card.appendChild(nameEl);

    const select = document.createElement('select');
    for (const act of ACTIVITIES) {
      const option = document.createElement('option');
      option.value = act;
      option.textContent = ACTIVITY_LABELS[act];
      if (act === managed.info.activity) option.selected = true;
      select.appendChild(option);
    }
    select.addEventListener('change', () => {
      agentManager.setActivity(managed.info.id, select.value as Activity);
    });
    card.appendChild(select);

    listEl.appendChild(card);
  }
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
