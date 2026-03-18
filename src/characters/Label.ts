import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

export function createLabel(name: string, activity: string): CSS2DObject {
  const div = document.createElement('div');
  div.className = 'agent-label';
  div.innerHTML = `
    <div class="name">${name}</div>
    <div class="activity">${activity}</div>
  `;

  const label = new CSS2DObject(div);
  label.position.set(0, 2.1, 0);
  return label;
}

export function updateLabel(label: CSS2DObject, name: string, activity: string): void {
  const div = label.element;
  div.innerHTML = `
    <div class="name">${name}</div>
    <div class="activity">${activity}</div>
  `;
}
