import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

function setLabelText(div: HTMLElement, name: string, activity: string, tag?: string, wait?: string): void {
  const nameEl = document.createElement('div');
  nameEl.className = 'name';
  nameEl.textContent = name;

  const activityEl = document.createElement('div');
  activityEl.className = 'activity';
  activityEl.textContent = tag ? `${activity} · ${tag}` : activity;

  const children = [nameEl, activityEl];
  // A compact label hides the activity line; the wait chip keeps the wait time readable without it.
  if (wait !== undefined) {
    const waitEl = document.createElement('div');
    waitEl.className = 'wait';
    waitEl.textContent = wait;
    children.push(waitEl);
  }
  div.replaceChildren(...children);
}

/** `tag` is an optional provider mark (for example "codex"), shown after the activity. `wait` is a short chip (for example "12m") shown only in a compact label. */
export function createLabel(name: string, activity: string, tag?: string, wait?: string): CSS2DObject {
  const div = document.createElement('div');
  div.className = 'agent-label';
  setLabelText(div, name, activity, tag, wait);

  const label = new CSS2DObject(div);
  label.position.set(0, 2.1, 0);
  return label;
}

export function updateLabel(label: CSS2DObject, name: string, activity: string, tag?: string, wait?: string): void {
  setLabelText(label.element, name, activity, tag, wait);
}
