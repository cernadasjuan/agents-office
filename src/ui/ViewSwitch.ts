import { VIEW_NAMES } from '../scene/ViewMemory.js';
import type { ViewMode } from '../scene/Selection.js';

/**
 * The view switch (issue #231): three small icon buttons in the panel header, the only
 * visible control for a camera mode that today only the footer's keyboard hint (and reading
 * it) exposes. Neither key (I, H) is a three-way selector — each one toggles between its own
 * mode and first person — so this reuses exactly those two methods rather than adding a third
 * transition of its own: the isometric and desk buttons call `options.isometric`/`options.desk`
 * directly (the same thing key I/H does); the first-person button calls whichever of the two
 * is the way back from the mode actually active right now (at most one ever is, since
 * isometric and desk are mutually exclusive). Desk mode's own graceful degradation (a no-op
 * without a desk pose, `ViewController.setMode`) still applies: the button is never disabled,
 * it just does nothing, the same as key H does today.
 */
export interface ViewSwitchOptions {
  /** Key I's own method: `ViewController.toggleIsometric`. */
  isometric(): void;
  /** Key H's own method: `ViewController.toggleDesk`. */
  desk(): void;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg(doc: Document, build: (el: SVGSVGElement) => void): SVGSVGElement {
  const el = doc.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
  el.setAttribute('width', '14');
  el.setAttribute('height', '14');
  el.setAttribute('viewBox', '0 0 14 14');
  el.setAttribute('aria-hidden', 'true');
  build(el);
  return el;
}

function shape(doc: Document, tag: string, attrs: Record<string, string>): SVGElement {
  const el = doc.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

/** One simple geometric mark per mode (the same "shape, not a downloaded asset" rule the agent card's provider mark already follows): a diamond for the isometric view from above, an eye for first person, a little monitor for the desk. */
const ICONS: Record<ViewMode, (doc: Document) => SVGSVGElement> = {
  isometric: (doc) => svg(doc, (el) => {
    el.appendChild(shape(doc, 'polygon', { points: '7,1 13,7 7,13 1,7', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.3' }));
  }),
  'first-person': (doc) => svg(doc, (el) => {
    el.appendChild(shape(doc, 'circle', { cx: '7', cy: '7', r: '5', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.3' }));
    el.appendChild(shape(doc, 'circle', { cx: '7', cy: '7', r: '2', fill: 'currentColor' }));
  }),
  desk: (doc) => svg(doc, (el) => {
    el.appendChild(shape(doc, 'rect', { x: '2', y: '2.5', width: '10', height: '6.5', rx: '1', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.3' }));
    el.appendChild(shape(doc, 'rect', { x: '5', y: '10.5', width: '4', height: '1.5', fill: 'currentColor' }));
  }),
};

const KEY_HINT: Record<ViewMode, string> = { isometric: 'key I', 'first-person': 'click, or Esc from another view', desk: 'key H' };

export class ViewSwitch {
  private buttons: Record<ViewMode, HTMLButtonElement>;
  private current: ViewMode;

  constructor(private root: HTMLElement, current: ViewMode, options: ViewSwitchOptions) {
    const doc = this.root.ownerDocument;
    const group = doc.createElement('div');
    group.className = 'view-switch';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'Camera view');

    // The first-person button has no method of its own: it runs whichever of the other two
    // toggles is the live one's way back. Neither ever runs from first person itself (there is
    // nothing to toggle back from), so a stray click there is already a no-op below.
    const backToFirstPerson = (): void => {
      if (this.current === 'isometric') options.isometric();
      else if (this.current === 'desk') options.desk();
    };
    const actions: Record<ViewMode, () => void> = { isometric: options.isometric, 'first-person': backToFirstPerson, desk: options.desk };
    const make = (mode: ViewMode): HTMLButtonElement => {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'view-switch-button';
      button.dataset.mode = mode;
      button.title = `${VIEW_NAMES[mode]} (${KEY_HINT[mode]})`;
      button.setAttribute('aria-label', VIEW_NAMES[mode]);
      button.appendChild(ICONS[mode](doc));
      button.addEventListener('click', () => {
        if (this.current !== mode) actions[mode]();
      });
      group.appendChild(button);
      return button;
    };

    this.buttons = { isometric: make('isometric'), 'first-person': make('first-person'), desk: make('desk') };
    this.current = current;
    this.setActive(current);
    this.root.appendChild(group);
  }

  /** Reflects the real mode after any change, however it happened: this button group, a key, a double-click into a room, or the idle timeout settling into desk mode. */
  setActive(mode: ViewMode): void {
    this.current = mode;
    for (const [candidate, button] of Object.entries(this.buttons) as Array<[ViewMode, HTMLButtonElement]>) {
      const active = candidate === mode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    }
  }
}
