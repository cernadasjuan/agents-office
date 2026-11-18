import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

function setLabelText(div: HTMLElement, name: string, activity: string): void {
  const nameEl = document.createElement('div');
  nameEl.className = 'name';
  nameEl.textContent = name;

  const activityEl = document.createElement('div');
  activityEl.className = 'activity';
  activityEl.textContent = activity;

  div.replaceChildren(nameEl, activityEl);
}

export function createLabel(name: string, activity: string): CSS2DObject {
  const div = document.createElement('div');
  div.className = 'agent-label';
  setLabelText(div, name, activity);

  const label = new CSS2DObject(div);
  label.position.set(0, 2.1, 0);
  return label;
}

export function updateLabel(label: CSS2DObject, name: string, activity: string): void {
  setLabelText(label.element, name, activity);
}
