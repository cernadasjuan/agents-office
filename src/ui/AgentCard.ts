import { ACTIVITY_LABELS, type AgentExtras, type AgentInfo } from '../agents/AgentData.js';
import { officeSelection, type SelectionState } from '../scene/Selection.js';
import { attentionBand, attentionLine } from './attention.js';

/**
 * Agent card (inspector, phase 1): a click on a figure or a triage row opens a
 * card docked left of the triage panel. It shows who the agent is, its state
 * and wait, where it runs, its personas, subagents and linked issues. Plugins
 * add buttons (`registerCardAction`) and issue links (`registerIssueLinker`);
 * the card itself knows no plugin. All text goes through textContent.
 */

export const CARD_WIDTH_PX = 360;
export const CARD_MAX_ISSUES = 10;
const CARD_GAP_PX = 8;
const MIN_FREE_AREA_PX = 240;
const STATUS_MS = 3000;

export type CardIssue = NonNullable<AgentExtras['issues']>[number];

/** A button a plugin adds to the card. It runs only on a click. */
export interface CardAction {
  id: string;
  label: string;
  available(agent: AgentInfo): boolean;
  /** Returns a short result text for the card status line. */
  run(agent: AgentInfo): Promise<string>;
}

/** Returns a URL for an issue, or null when the plugin does not know the issue. */
export type IssueLinker = (issue: CardIssue) => string | null;

const actions: CardAction[] = [];
const linkers: IssueLinker[] = [];

export function registerCardAction(action: CardAction): void {
  if (!actions.some((known) => known.id === action.id)) actions.push(action);
}

export function registerIssueLinker(linker: IssueLinker): void {
  linkers.push(linker);
}

/** Tests only: forget registered actions and linkers. */
export function resetCardRegistry(): void {
  actions.length = 0;
  linkers.length = 0;
}

function issueUrl(issue: CardIssue): string | null {
  for (const linker of linkers) {
    try {
      const url = linker(issue);
      if (url && isSafeUrl(url)) return url;
    } catch (error) {
      console.debug('issue linker failed', error);
    }
  }
  return null;
}

function isSafeUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * How far left of the canvas center the camera should put a selected figure, so
 * it sits in the middle of the free area left of the card. 0 when the card is
 * off screen or leaves too little room for a shift to help.
 */
export function figureShiftPx(viewportWidth: number, cardLeftPx: number): number {
  if (cardLeftPx >= viewportWidth || cardLeftPx < MIN_FREE_AREA_PX) return 0;
  return Math.max(0, Math.round(viewportWidth / 2 - cardLeftPx / 2));
}

export interface AgentCardOptions {
  /** The triage panel. The card docks to its left, top aligned. */
  anchor: HTMLElement;
  selection?: SelectionState;
}

interface Section {
  root: HTMLElement;
  body: HTMLElement;
}

export class AgentCard {
  private readonly root: HTMLElement;
  private readonly name: HTMLElement;
  private readonly activity: HTMLElement;
  private readonly wait: HTMLElement;
  private readonly band: HTMLElement;
  private readonly provider: HTMLElement;
  private readonly workspace: HTMLElement;
  private readonly parentRow: HTMLElement;
  private readonly actionRow: HTMLElement;
  private readonly status: HTMLElement;
  private readonly personas: Section;
  private readonly subagents: Section;
  private readonly issues: Section;
  private readonly selection: SelectionState;
  private agents: AgentInfo[] = [];
  private current: AgentInfo | null = null;
  private renderedKey = '';
  private shownId: string | null = null;
  private statusTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(parent: HTMLElement, private readonly options: AgentCardOptions) {
    this.selection = options.selection ?? officeSelection();
    const doc = parent.ownerDocument;
    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) => {
      const node = doc.createElement(tag);
      node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };

    this.root = el('aside', 'agent-inspector');
    this.root.id = 'agent-inspector';
    this.root.hidden = true;
    this.root.setAttribute('aria-label', 'Agent card');
    this.root.style.width = `${CARD_WIDTH_PX}px`;

    const header = el('div', 'inspector-header');
    this.name = el('h3', 'inspector-name');
    const close = el('button', 'inspector-close', '×');
    close.type = 'button';
    close.title = 'Close (Esc)';
    close.setAttribute('aria-label', 'Close the agent card');
    close.addEventListener('click', () => this.selection.clear());
    header.append(this.name, close);

    const state = el('div', 'inspector-state');
    this.activity = el('span', 'inspector-activity');
    this.band = el('span', 'inspector-band');
    state.append(this.activity, this.band);
    this.wait = el('div', 'inspector-wait');

    const facts = el('dl', 'inspector-facts');
    this.provider = el('dd', 'inspector-provider');
    this.workspace = el('dd', 'inspector-workspace');
    facts.append(el('dt', '', 'Provider'), this.provider, el('dt', '', 'Workspace'), this.workspace);

    this.parentRow = el('div', 'inspector-parent');
    this.actionRow = el('div', 'inspector-actions');
    this.status = el('div', 'inspector-status');
    this.status.setAttribute('role', 'status');
    this.status.hidden = true;

    const section = (className: string, title: string): Section => {
      const root = el('section', 'inspector-section');
      const body = el('div', className);
      root.append(el('h4', '', title), body);
      return { root, body };
    };
    this.personas = section('inspector-personas', 'Personas');
    this.subagents = section('inspector-subagents', 'Subagents');
    this.issues = section('inspector-issues', 'Issues');

    this.root.append(header, state, this.wait, facts, this.parentRow, this.actionRow, this.status,
      this.personas.root, this.subagents.root, this.issues.root);
    parent.appendChild(this.root);

    this.selection.onChange(() => this.refresh());
  }

  /** Call after each poll. The open card updates in place. */
  render(agents: AgentInfo[]): void {
    this.agents = agents;
    this.refresh();
  }

  /** Pixels the camera should move a selected figure left, so the card does not hide it. */
  cameraShiftPx(): number {
    const viewportWidth = this.root.ownerDocument.defaultView?.innerWidth ?? 0;
    return figureShiftPx(viewportWidth, this.cardLeftPx());
  }

  /** Run a card action on the shown agent (the button click). */
  async runAction(actionId: string): Promise<void> {
    const agent = this.current;
    const action = actions.find((candidate) => candidate.id === actionId);
    if (!agent || !action || !action.available(agent)) return;
    const button = [...this.actionRow.querySelectorAll('button')].find((candidate) => candidate.dataset.action === actionId);
    if (button) button.disabled = true;
    try {
      this.showStatus(await action.run(agent));
    } catch {
      this.showStatus('Action failed');
    } finally {
      if (button) button.disabled = false;
    }
  }

  private refresh(): void {
    const id = this.selection.selected;
    const agent = id === null ? undefined : this.agents.find((candidate) => candidate.id === id);
    if (!agent) {
      this.current = null;
      this.root.hidden = true;
      this.renderedKey = '';
      this.shownId = null;
      this.clearStatus();
      return;
    }
    this.current = agent;
    this.dock();
    this.fill(agent);
    this.root.hidden = false;
  }

  private cardLeftPx(): number {
    return this.options.anchor.getBoundingClientRect().left - CARD_GAP_PX - CARD_WIDTH_PX;
  }

  private dock(): void {
    const view = this.root.ownerDocument.defaultView;
    const rect = this.options.anchor.getBoundingClientRect();
    if (!view || rect.width === 0) return;
    this.root.style.right = `${Math.round(view.innerWidth - rect.left + CARD_GAP_PX)}px`;
    this.root.style.top = `${Math.round(rect.top)}px`;
  }

  private fill(agent: AgentInfo): void {
    const extras = agent.extras ?? {};
    const activityLabel = ACTIVITY_LABELS[agent.activity] ?? agent.activity;
    this.name.textContent = agent.name;
    this.activity.textContent = activityLabel;
    const waits = extras.attention !== undefined;
    this.wait.textContent = waits ? attentionLine(activityLabel, extras.attention, extras.waitMinutes) : '';
    this.wait.hidden = !waits;
    const band = attentionBand(extras);
    this.band.textContent = band ?? '';
    this.band.hidden = band === undefined;
    if (band) this.band.dataset.band = band;
    this.provider.textContent = extras.provider === 'codex' ? 'Codex' : 'Claude Code';
    this.workspace.textContent = extras.group?.label || 'No workspace';

    // Lists are rebuilt only when their content changes, so a focused button survives a poll.
    const children = this.agents.filter((candidate) => candidate.extras?.parentId === agent.id && candidate.id !== agent.id);
    const parent = extras.parentId ? this.agents.find((candidate) => candidate.id === extras.parentId) : undefined;
    const available = actions.filter((action) => action.available(agent));
    const key = JSON.stringify([agent.id, extras.badges, extras.issues?.slice(0, CARD_MAX_ISSUES),
      children.map((child) => [child.id, child.name, child.activity]), parent?.id, parent?.name, available.map((a) => a.id)]);
    if (agent.id !== this.shownId) {
      this.shownId = agent.id;
      this.clearStatus();
    }
    if (key === this.renderedKey) return;
    this.renderedKey = key;

    this.fillList(this.personas.body, extras.badges ?? [], 'No personas', (badge) => this.text('li', badge));
    this.fillList(this.subagents.body, children, 'No subagents', (child) => {
      const item = this.text('li', '');
      item.appendChild(this.selectButton(child.id, `${child.name} · ${ACTIVITY_LABELS[child.activity] ?? child.activity}`));
      return item;
    });
    this.fillList(this.issues.body, (extras.issues ?? []).slice(0, CARD_MAX_ISSUES), 'No linked issues', (issue) => this.issueItem(issue));

    this.parentRow.replaceChildren();
    this.parentRow.hidden = parent === undefined;
    if (parent) this.parentRow.append(this.text('span', 'Parent: '), this.selectButton(parent.id, parent.name));

    this.actionRow.replaceChildren(...available.map((action) => {
      const button = this.text('button', action.label) as HTMLButtonElement;
      button.type = 'button';
      button.dataset.action = action.id;
      button.addEventListener('click', () => void this.runAction(action.id));
      return button;
    }));
    this.actionRow.hidden = available.length === 0;
  }

  private fillList<T>(body: HTMLElement, items: T[], empty: string, make: (item: T) => HTMLElement): void {
    if (items.length === 0) {
      body.replaceChildren(this.text('p', empty));
      return;
    }
    const list = this.text('ul', '');
    list.append(...items.map(make));
    body.replaceChildren(list);
  }

  private issueItem(issue: CardIssue): HTMLElement {
    const item = this.text('li', '');
    const label = issue.title ? `#${issue.number} ${issue.title}` : `#${issue.number}`;
    const url = issueUrl(issue);
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

  private selectButton(agentId: string, label: string): HTMLButtonElement {
    const button = this.text('button', label) as HTMLButtonElement;
    button.type = 'button';
    button.className = 'inspector-link';
    button.addEventListener('click', () => this.selection.select(agentId));
    return button;
  }

  private text(tag: string, text: string): HTMLElement {
    const node = this.root.ownerDocument.createElement(tag);
    node.textContent = text;
    return node;
  }

  private showStatus(text: string): void {
    this.status.textContent = text;
    this.status.hidden = false;
    clearTimeout(this.statusTimer);
    this.statusTimer = setTimeout(() => this.clearStatus(), STATUS_MS);
  }

  private clearStatus(): void {
    clearTimeout(this.statusTimer);
    this.status.textContent = '';
    this.status.hidden = true;
  }
}
