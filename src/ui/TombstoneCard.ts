import type { WorldSessionStory } from '../extensions.js';
import { officeSelection, type SelectionState } from '../scene/Selection.js';

/**
 * Tombstone card (issue #127, #160): a click on a tombstone opens a small card
 * docked at the same spot as the agent card, reusing its look (the same CSS
 * classes) without reusing its code — a tombstone is not an agent, so it does
 * not carry the agent card's activity, wait, actions or panels. Shares the
 * agent card's selection: a tombstone id that is not a known agent id simply
 * never matches an agent, so only one of the two cards ever shows. Shows which
 * session a tombstone was, when it ended, and (issue #160) its story: the
 * intent, the personas it wore, its done list and handoff and issue links.
 * No 3D label, click or hover on the shape itself drives any of this.
 */

export const TOMBSTONE_CARD_GAP_PX = 8;
export const TOMBSTONE_CARD_WIDTH_PX = 360;
export const TOMBSTONE_CARD_MAX_ISSUES = 8;

export interface TombstoneInfo {
  /** The public id `pickTargets()` reports for this tombstone (same as the selected id). */
  id: string;
  endedAt?: string;
  /** The engraved session name (issue #159), shown as the card's own title in place of the
   * generic "Ended session" heading once a session slug is known. */
  name?: string;
  /** Issue #160's story. Absent means no archived record was found for this session. */
  story?: WorldSessionStory;
}

interface Section {
  root: HTMLElement;
  body: HTMLElement;
}

export interface TombstoneCardOptions {
  /** The same anchor the agent card docks against, so the two cards never overlap. */
  anchor: HTMLElement;
  selection?: SelectionState;
}

export class TombstoneCard {
  private readonly root: HTMLElement;
  private readonly name: HTMLElement;
  private readonly endedAt: HTMLElement;
  private readonly personas: HTMLElement;
  private readonly intent: HTMLElement;
  private readonly noRecord: HTMLElement;
  private readonly story: Section;
  private readonly doneList: Section;
  private readonly handoffs: Section;
  private readonly issues: Section;
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
    const section = (className: string, title: string): Section => {
      const root = el('section', `inspector-section ${className}`);
      const body = el('div', className);
      root.append(el('h4', '', title), body);
      return { root, body };
    };

    this.root = el('aside', 'agent-inspector');
    this.root.id = 'tombstone-inspector';
    this.root.hidden = true;
    this.root.setAttribute('aria-label', 'Tombstone card');
    this.root.style.width = `${TOMBSTONE_CARD_WIDTH_PX}px`;

    const header = el('div', 'inspector-header');
    this.name = el('h3', 'inspector-name', 'Ended session');
    const close = el('button', 'inspector-close', '×');
    close.type = 'button';
    close.title = 'Close (Esc)';
    close.setAttribute('aria-label', 'Close the tombstone card');
    close.addEventListener('click', () => this.selection.clear());
    header.append(this.name, close);

    const facts = el('dl', 'inspector-facts');
    this.endedAt = el('dd', '');
    this.personas = el('dd', '');
    facts.append(el('dt', '', 'Ended'), this.endedAt, el('dt', '', 'Persona'), this.personas);

    // Issue #160: without an archived record, the card says so plainly rather than showing
    // blank sections (a missing record is not the same thing as a session with nothing to show).
    this.noRecord = el('p', 'inspector-no-record', 'No session record found.');
    this.intent = el('p', 'inspector-intent');
    this.story = section('inspector-story', 'Story');
    this.story.body.appendChild(this.intent);
    this.doneList = section('inspector-done', 'Done');
    this.handoffs = section('inspector-handoffs', 'Handoffs');
    this.issues = section('inspector-issues', 'Issues');

    this.root.append(header, facts, this.noRecord, this.story.root, this.doneList.root, this.handoffs.root, this.issues.root);
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
    const key = JSON.stringify([tombstone.id, tombstone.endedAt, tombstone.name, tombstone.story]);
    if (key !== this.shownKey) {
      this.shownKey = key;
      this.fill(tombstone);
    }
    this.root.hidden = false;
  }

  private fill(tombstone: TombstoneInfo): void {
    this.name.textContent = tombstone.name ?? 'Ended session';
    this.endedAt.textContent = tombstone.endedAt ?? 'unknown';
    const story = tombstone.story;
    this.personas.textContent = story?.personas && story.personas.length > 0 ? story.personas.join(', ') : '—';

    this.noRecord.hidden = story !== undefined;
    for (const section of [this.story, this.doneList, this.handoffs, this.issues]) section.root.hidden = story === undefined;
    if (!story) return;

    this.intent.textContent = story.intent || 'No intent recorded.';
    this.fillList(this.doneList.body, this.doneItems(story), 'Nothing recorded as done.', (item) => this.textItem(item));
    this.fillList(this.handoffs.body, story.handoffs ?? [], 'No handoffs.', (file) => this.textItem(file));
    // Issue #160, Sally's review: zero issues reads as "no issue yet", never a blank section.
    this.fillList(this.issues.body, (story.issues ?? []).slice(0, TOMBSTONE_CARD_MAX_ISSUES), 'No issue yet.', (issue) => this.issueItem(issue));
  }

  /** The counts line first (always present once a story exists), then each done item's own text. */
  private doneItems(story: WorldSessionStory): string[] {
    const counts = story.counts;
    const summary = counts ? [`${counts.done} done · ${counts.open} open · ${counts.abandoned} abandoned`] : [];
    return [...summary, ...(story.doneList ?? [])];
  }

  private fillList<T>(body: HTMLElement, items: T[], empty: string, make: (item: T) => HTMLElement): void {
    const doc = body.ownerDocument;
    if (items.length === 0) {
      body.replaceChildren(this.text(doc, 'p', empty));
      return;
    }
    const list = doc.createElement('ul');
    list.append(...items.map(make));
    body.replaceChildren(list);
  }

  private textItem(label: string): HTMLElement {
    return this.text(this.root.ownerDocument, 'li', label);
  }

  private issueItem(issue: NonNullable<WorldSessionStory['issues']>[number]): HTMLElement {
    const doc = this.root.ownerDocument;
    const item = doc.createElement('li');
    const link = doc.createElement('a');
    link.href = issue.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = `${issue.repo}#${issue.number}`;
    item.appendChild(link);
    return item;
  }

  private text(doc: Document, tag: string, text: string): HTMLElement {
    const node = doc.createElement(tag);
    node.textContent = text;
    return node;
  }

  private dock(): void {
    const view = this.root.ownerDocument.defaultView;
    const rect = this.options.anchor.getBoundingClientRect();
    if (!view || rect.width === 0) return;
    this.root.style.right = `${Math.round(view.innerWidth - rect.left + TOMBSTONE_CARD_GAP_PX)}px`;
    this.root.style.top = `${Math.round(rect.top)}px`;
  }
}
