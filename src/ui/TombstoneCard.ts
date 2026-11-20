import { officeSelection, type SelectionState } from '../scene/Selection.js';

/**
 * Tombstone card (issue #127): a click on a tombstone opens a small card docked
 * at the same spot as the agent card, reusing its look (the same CSS classes)
 * without reusing its code — a tombstone is not an agent, so it does not carry
 * the agent card's activity, wait, actions or panels. Shares the agent card's
 * selection: a tombstone id that is not a known agent id simply never matches
 * an agent, so only one of the two cards ever shows. Shows which session a
 * tombstone was, and when it ended; no 3D label, click or hover on the shape.
 */

export const TOMBSTONE_CARD_GAP_PX = 8;
export const TOMBSTONE_CARD_WIDTH_PX = 360;

export interface TombstoneInfo {
  /** The public id `pickTargets()` reports for this tombstone (same as the selected id). */
  id: string;
  endedAt?: string;
}

export interface TombstoneCardOptions {
  /** The same anchor the agent card docks against, so the two cards never overlap. */
  anchor: HTMLElement;
  selection?: SelectionState;
}

export class TombstoneCard {
  private readonly root: HTMLElement;
  private readonly endedAt: HTMLElement;
  private readonly selection: SelectionState;
  private tombstones: TombstoneInfo[] = [];
  private shownKey = '';

  constructor(parent: HTMLElement, private readonly options: TombstoneCardOptions) {
    this.selection = options.selection ?? officeSelection();
    const doc = parent.ownerDocument;
    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) => {
      const node = doc.createElement(tag);
      node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };

    this.root = el('aside', 'agent-inspector');
    this.root.id = 'tombstone-inspector';
    this.root.hidden = true;
    this.root.setAttribute('aria-label', 'Tombstone card');
    this.root.style.width = `${TOMBSTONE_CARD_WIDTH_PX}px`;

    const header = el('div', 'inspector-header');
    const name = el('h3', 'inspector-name', 'Ended session');
    const close = el('button', 'inspector-close', '×');
    close.type = 'button';
    close.title = 'Close (Esc)';
    close.setAttribute('aria-label', 'Close the tombstone card');
    close.addEventListener('click', () => this.selection.clear());
    header.append(name, close);

    const facts = el('dl', 'inspector-facts');
    this.endedAt = el('dd', '');
    facts.append(el('dt', '', 'Ended'), this.endedAt);

    this.root.append(header, facts);
    parent.appendChild(this.root);

    this.selection.onChange(() => this.refresh());
    const Observer = doc.defaultView?.ResizeObserver;
    if (Observer) new Observer(() => this.redock()).observe(options.anchor);
  }

  /** Call after each poll: the latest known tombstones, so an open card updates if its data changes. */
  render(tombstones: TombstoneInfo[]): void {
    this.tombstones = tombstones;
    this.refresh();
  }

  redock(): void {
    if (!this.root.hidden) this.dock();
  }

  private refresh(): void {
    const id = this.selection.selected;
    const tombstone = id === null ? undefined : this.tombstones.find((candidate) => candidate.id === id);
    if (!tombstone) {
      this.root.hidden = true;
      this.shownKey = '';
      return;
    }
    this.dock();
    const key = `${tombstone.id}|${tombstone.endedAt ?? ''}`;
    if (key !== this.shownKey) {
      this.shownKey = key;
      this.endedAt.textContent = tombstone.endedAt ?? 'unknown';
    }
    this.root.hidden = false;
  }

  private dock(): void {
    const view = this.root.ownerDocument.defaultView;
    const rect = this.options.anchor.getBoundingClientRect();
    if (!view || rect.width === 0) return;
    this.root.style.right = `${Math.round(view.innerWidth - rect.left + TOMBSTONE_CARD_GAP_PX)}px`;
    this.root.style.top = `${Math.round(rect.top)}px`;
  }
}
