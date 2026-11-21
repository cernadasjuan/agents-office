import { ALL_FLOORS, knownFloors } from '../floors/FloorRegistry.js';

export interface FloorSwitchOptions {
  onSelect(floor: string): void;
}

/**
 * The floor-switch menu (issue #118 AC3): a plain `<select>` in the panel header. `ALL_FLOORS`
 * ("All floors", review: the default, no-filter state) always lists first, then every floor
 * with a tracked session right now, plus the focused floor itself (so a floor with zero
 * sessions right after a switch still shows as the chosen option), general always last
 * (`knownFloors`, `src/floors/FloorRegistry.ts`). All text through `textContent` (S5); a
 * floor name is already the whitelisted short token `server/seam.ts` projects, never raw.
 *
 * A physical lobby control (an elevator panel, a directory sign) is Sally's own vote in the
 * floors design document, deferred by Gabriel for later refinement. This is the "support
 * both" interim: a HUD menu today: switching reloads the page (`reloadForFloorSwitch`), the
 * same pattern Shift+L already uses for a layout switch, so a later physical control can
 * drive the exact same reload with no change to the data model.
 */
export class FloorSwitch {
  private select: HTMLSelectElement;

  constructor(private root: HTMLElement, private focused: string, private options: FloorSwitchOptions) {
    const doc = this.root.ownerDocument;
    this.select = doc.createElement('select');
    this.select.className = 'floor-switch';
    this.select.setAttribute('aria-label', 'Floor');
    this.select.addEventListener('change', () => {
      const value = this.select.value;
      if (value && value !== this.focused) this.options.onSelect(value);
    });
    this.root.appendChild(this.select);
    this.render([]);
  }

  /** Rebuilds the option list from every floor known right now (after each poll). `ALL_FLOORS` is never a real agent floor, so it is prepended here, not derived from `knownFloors`. */
  render(agents: ReadonlyArray<{ floor?: string }>): void {
    const doc = this.root.ownerDocument;
    const known = knownFloors([...agents, { floor: this.focused }]).filter((floor) => floor !== ALL_FLOORS);
    const floors = [ALL_FLOORS, ...known];
    this.select.textContent = '';
    for (const floor of floors) {
      const option = doc.createElement('option');
      option.value = floor;
      option.textContent = floor;
      option.selected = floor === this.focused;
      this.select.appendChild(option);
    }
  }
}
