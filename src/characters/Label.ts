import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

function setLabelText(div: HTMLElement, name: string, activity: string, tag?: string, id?: string, wait?: string): void {
  const nameEl = document.createElement('div');
  nameEl.className = 'name';
  nameEl.textContent = name;

  const activityEl = document.createElement('div');
  activityEl.className = 'activity';
  activityEl.textContent = tag ? `${activity} · ${tag}` : activity;

  const idEl = document.createElement('div');
  idEl.className = 'agent-id-tag';
  idEl.textContent = id ? `#${id}` : '';

  const children = [nameEl, activityEl, idEl];
  // A compact label hides the activity line; the wait chip keeps the wait time readable without it.
  if (wait !== undefined) {
    const waitEl = document.createElement('div');
    waitEl.className = 'wait';
    waitEl.textContent = wait;
    children.push(waitEl);
  }
  div.replaceChildren(...children);
}

/**
 * `tag` is an optional provider mark (for example "codex"), shown after the activity. `id` is
 * a short, stable agent id (issue #171): hidden in compact labels by CSS, the same as the
 * activity line, so it never crowds the label when many agents are on screen. `wait` is a short
 * chip (for example "12m") shown only in a compact label.
 */
export function createLabel(name: string, activity: string, tag?: string, id?: string, wait?: string): CSS2DObject {
  const div = document.createElement('div');
  div.className = 'agent-label';
  setLabelText(div, name, activity, tag, id, wait);

  const label = new CSS2DObject(div);
  label.position.set(0, 2.1, 0);
  return label;
}

export function updateLabel(label: CSS2DObject, name: string, activity: string, tag?: string, id?: string, wait?: string): void {
  setLabelText(label.element, name, activity, tag, id, wait);
}
