import { officeSelection, type SelectionState } from '../scene/Selection.js';

/**
 * Mission issues card (issue #146): a click on a war room's issue board opens a
 * small card, the same look and dock spot as the agent and tombstone cards,
 * listing that mission's issues as real links: `owner/repo#N title`, each
 * opening `https://github.com/<repo>/issues/<N>` in a new tab. An issue with
 * no repository (a bare `#N` in the mission record) shows as plain text, no
 * link. Shares the same selection: an `issues:<room id>` id never matches an
 * agent or a tombstone, so only one of the cards ever shows.
 */

export const MISSION_ISSUES_CARD_GAP_PX = 8;
export const MISSION_ISSUES_CARD_WIDTH_PX = 360;

export interface MissionIssue {
  number: number;
  repo?: string;
  title: string;
  state: 'open' | 'closed';
}

export interface MissionIssuesRoom {
  /** The public room id `pickTargets()` reports as `issues:<id>` when its board is clicked. */
  id: string;
  title: string;
  issues: MissionIssue[];
}

export interface MissionIssuesCardOptions {
  /** The same anchor the agent card docks against, so the cards never overlap. */
  anchor: HTMLElement;
  selection?: SelectionState;
}

const ISSUES_PREFIX = 'issues:';

export class MissionIssuesCard {
  private readonly root: HTMLElement;
  private readonly name: HTMLElement;
  private readonly list: HTMLElement;
  private readonly selection: SelectionState;
  private rooms: MissionIssuesRoom[] = [];
  private shownKey = '';

  constructor(parent: HTMLElement, private readonly options: MissionIssuesCardOptions) {
    this.selection = options.selection ?? officeSelection();
    const doc = parent.ownerDocument;
    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) => {
      const node = doc.createElement(tag);
      node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };

    this.root = el('aside', 'agent-inspector');
    this.root.id = 'mission-issues-inspector';
    this.root.hidden = true;
    this.root.setAttribute('aria-label', 'Mission issues card');
    this.root.style.width = `${MISSION_ISSUES_CARD_WIDTH_PX}px`;

    const header = el('div', 'inspector-header');
    this.name = el('h3', 'inspector-name', 'Issues');
    const close = el('button', 'inspector-close', '×');
    close.type = 'button';
    close.title = 'Close (Esc)';
    close.setAttribute('aria-label', 'Close the mission issues card');
    close.addEventListener('click', () => this.selection.clear());
    header.append(this.name, close);

    this.list = el('ul', 'inspector-section');
    this.root.append(header, this.list);
    parent.appendChild(this.root);

    this.selection.onChange(() => this.refresh());
    const Observer = doc.defaultView?.ResizeObserver;
    if (Observer) new Observer(() => this.redock()).observe(options.anchor);
  }

  /** Call after each world poll: the latest known mission rooms and their issues. */
  render(rooms: MissionIssuesRoom[]): void {
    this.rooms = rooms;
    this.refresh();
  }

  redock(): void {
    if (!this.root.hidden) this.dock();
  }

  private refresh(): void {
    const id = this.selection.selected;
    const room = id?.startsWith(ISSUES_PREFIX) ? this.rooms.find((candidate) => candidate.id === id.slice(ISSUES_PREFIX.length)) : undefined;
    if (!room) {
      this.root.hidden = true;
      this.shownKey = '';
      return;
    }
    this.dock();
    const key = JSON.stringify([room.id, room.issues]);
    if (key !== this.shownKey) {
      this.shownKey = key;
      this.name.textContent = room.title;
      this.fillList(room.issues);
    }
    this.root.hidden = false;
  }

  private fillList(issues: MissionIssue[]): void {
    if (issues.length === 0) {
      this.list.replaceChildren(this.text('p', 'No linked issues'));
      return;
    }
    this.list.replaceChildren(...issues.map((issue) => this.issueItem(issue)));
  }

  private issueItem(issue: MissionIssue): HTMLElement {
    const item = this.text('li', '');
    const label = issue.repo ? `${issue.repo}#${issue.number} ${issue.title}` : `#${issue.number} ${issue.title}`;
    const url = issue.repo && isSafeRepo(issue.repo) ? `https://github.com/${issue.repo}/issues/${issue.number}` : null;
    if (!url) {
      item.textContent = label;
      return item;
    }
    const link = this.text('a', label) as HTMLAnchorElement;
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    item.appendChild(link);
    return item;
  }

  private text(tag: string, text: string): HTMLElement {
    const node = this.root.ownerDocument.createElement(tag);
    node.textContent = text;
    return node;
  }

  private dock(): void {
    const view = this.root.ownerDocument.defaultView;
    const rect = this.options.anchor.getBoundingClientRect();
    if (!view || rect.width === 0) return;
    this.root.style.right = `${Math.round(view.innerWidth - rect.left + MISSION_ISSUES_CARD_GAP_PX)}px`;
    this.root.style.top = `${Math.round(rect.top)}px`;
  }
}

const OWNER_REPO = /^[A-Za-z0-9_.-]{1,64}\/[A-Za-z0-9_.-]{1,100}$/;

/** A last check before building a URL from a server-cleaned field: still just `owner/name`. */
function isSafeRepo(repo: string): boolean {
  return OWNER_REPO.test(repo);
}
