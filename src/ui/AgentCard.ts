import { activityLabel, shortAgentId, type AgentExtras, type AgentInfo } from '../agents/AgentData.js';
import { officeSelection, type SelectionState } from '../scene/Selection.js';
import { attentionBand, attentionLine, BEACON_HINT, callsForYou } from './attention.js';

/**
 * Agent card (inspector, phase 1): a click on a figure or a triage row opens a
 * card docked left of the triage panel. It shows who the agent is, its state
 * and wait, where it runs, its persona/skills/repos equipment table, subagents
 * and linked issues. Plugins
 * add buttons (`registerCardAction`), issue links (`registerIssueLinker`) and
 * sections at the end (`registerCardPanel`);
 * the card itself knows no plugin. All text goes through textContent.
 */

export const CARD_WIDTH_PX = 360;
export const CARD_MAX_ISSUES = 10;
/** Max visible rows per equipment column before a final "+N more" row (Sally's round 7 review,
 * column rule 2): a long list must never grow the card past its fixed per-column height. */
export const CARD_EQUIP_MAX = 4;
const CARD_GAP_PX = 8;
const MIN_FREE_AREA_PX = 240;
const STATUS_MS = 3000;
const PULSE_MS = 1500;
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * A small provider mark (issue #171): simple geometry, not a downloaded brand asset, so it
 * carries no license to track. A rounded square for Claude Code, a hexagon for Codex — two
 * different shapes, not just two colors, so the distinction still reads for a colorblind
 * viewer. Always a sibling of the provider's text name, never a replacement for it (AC3: text
 * never disappears, since this SVG never fails to load the way an external image could).
 */
function createProviderMark(doc: Document, provider: 'codex' | undefined): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '12');
  svg.setAttribute('viewBox', '0 0 14 14');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('provider-mark');
  const shape = doc.createElementNS(SVG_NS, provider === 'codex' ? 'polygon' : 'rect');
  if (provider === 'codex') {
    shape.setAttribute('points', '7,0.5 13,4 13,10 7,13.5 1,10 1,4');
    shape.setAttribute('fill', '#a8b8ff');
  } else {
    shape.setAttribute('x', '1');
    shape.setAttribute('y', '1');
    shape.setAttribute('width', '12');
    shape.setAttribute('height', '12');
    shape.setAttribute('rx', '3');
    shape.setAttribute('fill', '#9fe0c0');
  }
  svg.appendChild(shape);
  return svg;
}

/**
 * A geometric header mark for an equipment column (Sally's round 7 review): a hat for Persona,
 * a bucket for Repos — the same "simple geometry, not a downloaded brand asset" rule as
 * `createProviderMark`. Skills reuses the existing gear glyph (the same mark `li.skill::before`
 * already draws), not a new SVG, per the review's own instruction to reuse it rather than add a
 * fourth shape.
 */
function createPersonaMark(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '12');
  svg.setAttribute('viewBox', '0 0 14 14');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('persona-mark');
  const crown = doc.createElementNS(SVG_NS, 'path');
  crown.setAttribute('d', 'M2 9 L7 2 L12 9 Z');
  crown.setAttribute('fill', '#ffb199');
  const brim = doc.createElementNS(SVG_NS, 'rect');
  brim.setAttribute('x', '1');
  brim.setAttribute('y', '9');
  brim.setAttribute('width', '12');
  brim.setAttribute('height', '2.5');
  brim.setAttribute('rx', '1');
  brim.setAttribute('fill', '#ffb199');
  svg.append(crown, brim);
  return svg;
}

function createRepoMark(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '12');
  svg.setAttribute('viewBox', '0 0 14 14');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('repo-mark');
  const body = doc.createElementNS(SVG_NS, 'path');
  body.setAttribute('d', 'M2.5 4 L11.5 4 L10.5 12 L3.5 12 Z');
  body.setAttribute('fill', '#a8b8ff');
  const handle = doc.createElementNS(SVG_NS, 'path');
  handle.setAttribute('d', 'M4 4 C4 1.5 10 1.5 10 4');
  handle.setAttribute('fill', 'none');
  handle.setAttribute('stroke', '#a8b8ff');
  handle.setAttribute('stroke-width', '1.2');
  svg.append(body, handle);
  return svg;
}

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

/**
 * A section a plugin adds at the end of the card. `render` runs after each
 * selection change and poll while `available` is true; it fills its own element
 * (created once) and must use textContent for text.
 */
export interface CardPanel {
  id: string;
  available(agent: AgentInfo): boolean;
  render(agent: AgentInfo, root: HTMLElement): void;
  /** Called when the card closes or the panel stops being available: stop timers here. */
  hide?(): void;
}

const actions: CardAction[] = [];
const linkers: IssueLinker[] = [];
const panels: CardPanel[] = [];

export function registerCardAction(action: CardAction): void {
  if (!actions.some((known) => known.id === action.id)) actions.push(action);
}

export function registerIssueLinker(linker: IssueLinker): void {
  linkers.push(linker);
}

export function registerCardPanel(panel: CardPanel): void {
  if (!panels.some((known) => known.id === panel.id)) panels.push(panel);
}

/** Tests only: forget registered actions, linkers and panels. */
export function resetCardRegistry(): void {
  actions.length = 0;
  linkers.length = 0;
  panels.length = 0;
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
  private readonly idTag: HTMLElement;
  private readonly activity: HTMLElement;
  private readonly wait: HTMLElement;
  private readonly beaconHint: HTMLElement;
  private readonly band: HTMLElement;
  private readonly provider: HTMLElement;
  private readonly workspace: HTMLElement;
  private readonly parentRow: HTMLElement;
  private readonly actionRow: HTMLElement;
  private readonly status: HTMLElement;
  private readonly equipPersona: Section;
  private readonly equipSkills: Section;
  private readonly equipRepos: Section;
  private readonly subagents: Section;
  private readonly issues: Section;
  private readonly selection: SelectionState;
  private readonly panelRoots = new Map<string, HTMLElement>();
  private agents: AgentInfo[] = [];
  private current: AgentInfo | null = null;
  private renderedKey = '';
  private shownId: string | null = null;
  private statusTimer: ReturnType<typeof setTimeout> | undefined;
  private pulseTimer: ReturnType<typeof setTimeout> | undefined;

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
    const titleGroup = el('div', 'inspector-title');
    this.name = el('h3', 'inspector-name');
    this.idTag = el('span', 'inspector-id');
    this.idTag.title = 'Agent id';
    titleGroup.append(this.name, this.idTag);
    const close = el('button', 'inspector-close', '×');
    close.type = 'button';
    close.title = 'Close (Esc)';
    close.setAttribute('aria-label', 'Close the agent card');
    close.addEventListener('click', () => this.selection.clear());
    header.append(titleGroup, close);

    const state = el('div', 'inspector-state');
    this.activity = el('span', 'inspector-activity');
    this.band = el('span', 'inspector-band');
    state.append(this.activity, this.band);
    this.wait = el('div', 'inspector-wait');
    // The beacon's meaning, reachable without opening the legend (issue #170 review): labels
    // have `pointer-events: none`, so a hover title there never shows. This line is the
    // always-reachable fallback; present only while the beacon itself shows.
    this.beaconHint = el('div', 'inspector-beacon-hint');
    this.beaconHint.hidden = true;

    const facts = el('dl', 'inspector-facts');
    this.provider = el('dd', 'inspector-provider');
    this.workspace = el('dd', 'inspector-workspace');
    facts.append(el('dt', '', 'Provider'), this.provider, el('dt', '', 'Workspace'), this.workspace);
    // The mark is a sibling of the text, never a replacement (AC3): the text node always
    // exists even before the first `fill()` call fills in the real provider.
    this.provider.append(createProviderMark(doc, undefined), this.text('span', 'Claude Code'));

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
    // Equipment: a 3-column table (Persona, Skills, Repos), one icon per column header,
    // replacing the old mixed "Persona / Skills" list (Sally's round 7 review, AC1/AC4).
    // Each column grows independently top to bottom (no shared row grid, `align-items:
    // flex-start` in CSS so one empty column never stretches to another's height).
    const equipColumn = (kind: string, mark: Element, label: string): Section => {
      const root = el('div', `equip-col equip-col-${kind}`);
      const heading = el('h4', '', label);
      heading.prepend(mark);
      const body = el('div', 'equip-body');
      root.append(heading, body);
      return { root, body };
    };
    this.equipPersona = equipColumn('persona', createPersonaMark(doc), 'Persona');
    this.equipSkills = equipColumn('skills', el('span', 'skill-mark', '⚙'), 'Skills');
    this.equipRepos = equipColumn('repos', createRepoMark(doc), 'Repos');
    const equipment = el('section', 'inspector-section inspector-equipment');
    const equipColumns = el('div', 'equip-columns');
    equipColumns.append(this.equipPersona.root, this.equipSkills.root, this.equipRepos.root);
    equipment.appendChild(equipColumns);

    this.subagents = section('inspector-subagents', 'Subagents');
    this.issues = section('inspector-issues', 'Issues');

    this.root.append(header, state, this.wait, this.beaconHint, facts, this.parentRow, this.actionRow, this.status,
      equipment, this.subagents.root, this.issues.root);
    parent.appendChild(this.root);

    this.selection.onChange(() => this.refresh());
    // The panel grows, shrinks or collapses between polls: follow it at once.
    const Observer = doc.defaultView?.ResizeObserver;
    if (Observer) new Observer(() => this.redock()).observe(options.anchor);
  }

  /** Dock the open card again next to the panel. */
  redock(): void {
    if (!this.root.hidden) this.dock();
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

  /**
   * Key F (issue #85, fixed under the decision on #85): highlight the shown
   * agent's ready action button (today only "Focus in herdr") for `PULSE_MS`,
   * so the keystroke has a visible effect. Never moves DOM focus onto the
   * button (Enter would then send the request) and never calls `runAction`:
   * S7 keeps a write action behind a click. A silent no-op without a ready
   * action (no selection, or no action available for the shown agent).
   */
  pulseFocus(): void {
    const button = this.actionRow.querySelector<HTMLButtonElement>('button');
    if (!button) return;
    button.classList.add('pulse');
    clearTimeout(this.pulseTimer);
    this.pulseTimer = setTimeout(() => button.classList.remove('pulse'), PULSE_MS);
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
      this.hidePanels();
      return;
    }
    this.current = agent;
    this.dock();
    this.fill(agent);
    this.renderPanels(agent);
    this.root.hidden = false;
  }

  private renderPanels(agent: AgentInfo): void {
    for (const panel of panels) {
      let root = this.panelRoots.get(panel.id);
      if (!root) {
        root = this.text('div', '');
        root.className = 'inspector-panel';
        root.dataset.panel = panel.id;
        this.root.appendChild(root);
        this.panelRoots.set(panel.id, root);
      }
      try {
        if (panel.available(agent)) {
          root.hidden = false;
          panel.render(agent, root);
          continue;
        }
      } catch (error) {
        console.debug('card panel failed', error);
      }
      this.hidePanel(panel, root);
    }
  }

  private hidePanels(): void {
    for (const panel of panels) {
      const root = this.panelRoots.get(panel.id);
      if (root) this.hidePanel(panel, root);
    }
  }

  private hidePanel(panel: CardPanel, root: HTMLElement): void {
    root.hidden = true;
    root.replaceChildren();
    try {
      panel.hide?.();
    } catch (error) {
      console.debug('card panel hide failed', error);
    }
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
    // Issue #168: the header line reads the same words as the panel row and the floating
    // label for the same agent at the same time — attention overrides the raw activity text
    // here too. It also carries the elapsed time now (see the #216 follow-up fix below), so it
    // is the one complete rendering of this agent's attention state on the card.
    const activityText = activityLabel(agent);
    this.name.textContent = agent.name;
    // P7/AC6 fix, widened per Sally's issue #216 follow-up: the duplicate was never specific to
    // 'your-turn' with no waitMinutes — every attention state built the same sentence twice,
    // once bare in the header and once again (plus a time suffix) in the separate wait line
    // below it, so the two lines always shared an identical leading phrase ("Waiting for you",
    // "Your turn"). The header now carries the complete sentence itself, elapsed time included
    // (the same single-line shape `StickFigure.ts`'s floating label already uses), so there is
    // only ever one place on the card this text can appear. The wait line adds nothing it could
    // ever say that the header does not already say, so it stays hidden for every state.
    this.activity.textContent = attentionLine(activityText, extras.attention, extras.waitMinutes);
    this.wait.textContent = '';
    this.wait.hidden = true;
    const beaconOn = callsForYou({ attention: extras.attention, waitMinutes: extras.waitMinutes, orchestrating: extras.orchestrating });
    this.beaconHint.textContent = beaconOn ? BEACON_HINT : '';
    this.beaconHint.hidden = !beaconOn;
    const band = attentionBand(extras);
    this.band.textContent = band ?? '';
    this.band.hidden = band === undefined;
    if (band) this.band.dataset.band = band;
    this.idTag.textContent = `#${shortAgentId(agent.id)}`;
    const providerName = extras.provider === 'codex' ? 'codex' : undefined;
    this.provider.replaceChildren(createProviderMark(this.provider.ownerDocument, providerName), this.text('span', providerName === 'codex' ? 'Codex' : 'Claude Code'));
    this.workspace.textContent = extras.group?.label || 'No workspace';

    // Lists are rebuilt only when their content changes, so a focused button survives a poll.
    const children = this.agents.filter((candidate) => candidate.extras?.parentId === agent.id && candidate.id !== agent.id);
    const parent = extras.parentId ? this.agents.find((candidate) => candidate.id === extras.parentId) : undefined;
    const available = actions.filter((action) => action.available(agent));
    const key = JSON.stringify([agent.id, extras.provider, extras.badges, extras.skills, extras.repos, extras.issues?.slice(0, CARD_MAX_ISSUES),
      children.map((child) => [child.id, child.name, activityLabel(child)]), parent?.id, parent?.name, available.map((a) => a.id)]);
    if (agent.id !== this.shownId) {
      this.shownId = agent.id;
      this.clearStatus();
    }
    if (key === this.renderedKey) return;
    this.renderedKey = key;

    // Equipment table (Sally's round 7 review, AC1-AC3): Persona, Skills and Repos each grow
    // independently in their own column, capped at CARD_EQUIP_MAX rows with a final "+N more"
    // row, never a shared list. Without the skills or peek-promoted-repos data, a column shows
    // its own empty state (AC2/AC6/AC7) — graceful degradation, the same pattern every other
    // optional extras field already follows.
    this.fillEquipColumn(this.equipPersona.body, extras.badges ?? [], 'No persona');
    this.fillEquipColumn(this.equipSkills.body, extras.skills ?? [], 'No skills', true);
    this.fillEquipColumn(this.equipRepos.body, extras.repos ?? [], 'No repos');
    this.fillList(this.subagents.body, children, 'No subagents', (child) => {
      const item = this.text('li', '');
      item.appendChild(this.selectButton(child.id, `${child.name} · ${activityLabel(child)}`));
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

  /**
   * One equipment column's rows (Sally's round 7 review, column rules): at most
   * `CARD_EQUIP_MAX` items, a trailing "+N more" row past that (muted, never a link or badge),
   * no wrapping (CSS truncates with ellipsis), the full label still reachable on hover through
   * the native `title` attribute. `isSkill` marks each row with the same gear-dot style
   * `li.skill::before` already draws, so a skill reads the same here as it used to in the old
   * merged list.
   */
  private fillEquipColumn(body: HTMLElement, items: string[], empty: string, isSkill = false): void {
    if (items.length === 0) {
      const p = this.text('p', empty);
      p.classList.add('equip-empty');
      body.replaceChildren(p);
      return;
    }
    const visible = items.slice(0, CARD_EQUIP_MAX);
    const list = this.text('ul', '');
    list.append(...visible.map((label) => {
      const li = this.text('li', label);
      li.title = label;
      if (isSkill) li.classList.add('skill');
      return li;
    }));
    const hiddenCount = items.length - visible.length;
    if (hiddenCount > 0) {
      const more = this.text('li', `+${hiddenCount} more`);
      more.classList.add('equip-more');
      list.appendChild(more);
    }
    body.replaceChildren(list);
  }

  private issueItem(issue: CardIssue): HTMLElement {
    const item = this.text('li', '');
    const id = `${issue.repo ?? ''}#${issue.number}`;
    const label = issue.title ? `${id} ${issue.title}` : id;
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
