import { ACTIVITIES, ACTIVITY_LABELS, AgentInfo, activityLabel } from '../agents/AgentData.js';
import type { Activity } from '../agents/ActivityAnimations.js';
import { attentionBand, compareWaits, formatWait } from './attention.js';

export type TriageGroupId = 'needs-you' | 'your-turn' | 'working' | 'idle' | 'cold';

interface GroupSpec {
  id: TriageGroupId;
  title: string;
  chip: (count: number) => string;
  openByDefault: (count: number) => boolean;
}

const YOUR_TURN_OPEN_MAX = 5;

const GROUPS: GroupSpec[] = [
  { id: 'needs-you', title: 'Needs you', chip: (n) => `${n} ${n === 1 ? 'needs' : 'need'} you`, openByDefault: () => true },
  { id: 'your-turn', title: 'Your turn', chip: (n) => `${n} your turn`, openByDefault: (n) => n <= YOUR_TURN_OPEN_MAX },
  { id: 'working', title: 'Working', chip: (n) => `${n} working`, openByDefault: () => true },
  { id: 'idle', title: 'Idle', chip: (n) => `${n} idle`, openByDefault: () => false },
  { id: 'cold', title: 'Cold', chip: (n) => `${n} cold`, openByDefault: () => false },
];

export interface AgentPanelOptions {
  /** A click on a row selects the agent. Without it, rows are not clickable. */
  onSelect?: (agentId: string) => void;
  /** Demo mode only: the activity menu reports the agent and the chosen activity. */
  onPick?: (agentId: string, activity: Activity) => void;
  /** Show the prototype activity menu on each row (`?demo=1`). */
  demo?: boolean;
}

interface Row {
  card: HTMLElement;
  name: HTMLElement;
  wait: HTMLElement;
  activity: HTMLElement;
  tags: HTMLElement;
  tagKey: string;
  menu: HTMLSelectElement | null;
}

interface Group {
  spec: GroupSpec;
  section: HTMLElement;
  header: HTMLElement;
  rows: HTMLElement;
  chip: HTMLElement;
  userOpen: boolean | undefined;
  count: number;
}

/** `?demo=1` shows the prototype activity menu. Live polls still overwrite a choice. */
export function isDemoMode(search: string): boolean {
  return new URLSearchParams(search).get('demo') === '1';
}

export function triageGroup(agent: AgentInfo): TriageGroupId {
  const attention = agent.extras?.attention;
  if (attentionBand(agent.extras) === 'cold') return 'cold';
  if (attention === 'waiting') return 'needs-you';
  if (attention === 'your-turn') return 'your-turn';
  return agent.activity === 'idle' ? 'idle' : 'working';
}

/**
 * Triage list: agents grouped by what the user must do. Rows are created when
 * agents arrive and removed when they leave. An update moves and edits rows in
 * place, so the scroll position, the open groups and an open menu survive a poll.
 */
export class AgentPanel {
  private rows = new Map<string, Row>();
  private groups = new Map<TriageGroupId, Group>();
  private selectedId: string | null = null;
  private chipBar: HTMLElement;
  private loading: HTMLElement;

  constructor(
    private list: HTMLElement,
    private options: AgentPanelOptions = {},
  ) {
    this.loading = document.createElement('div');
    this.loading.className = 'triage-loading';
    this.loading.textContent = 'Loading agents…';
    this.chipBar = document.createElement('div');
    this.chipBar.className = 'triage-chips';
    const body = document.createElement('div');
    body.className = 'triage-groups';
    for (const spec of GROUPS) {
      const group = this.createGroup(spec);
      this.groups.set(spec.id, group);
      this.chipBar.appendChild(group.chip);
      body.appendChild(group.section);
    }
    this.list.replaceChildren(this.loading, this.chipBar, body);
  }

  /** Mark the row of the selected agent, or none. */
  setSelected(agentId: string | null): void {
    this.selectedId = agentId;
    for (const [id, row] of this.rows) row.card.classList.toggle('selected', id === agentId);
  }

  /** The first render follows the first answer of the server, so the loading text goes. */
  render(agents: AgentInfo[]): void {
    this.loading.hidden = true;
    const present = new Set(agents.map((agent) => agent.id));
    for (const [id, row] of this.rows) {
      if (present.has(id)) continue;
      row.card.remove();
      this.rows.delete(id);
    }

    const members = new Map<TriageGroupId, AgentInfo[]>(GROUPS.map((spec) => [spec.id, []]));
    for (const agent of agents) {
      this.updateRow(this.rows.get(agent.id) ?? this.addRow(agent), agent);
      members.get(triageGroup(agent))!.push(agent);
    }

    for (const [id, group] of this.groups) {
      const ordered = orderGroup(id, members.get(id)!);
      this.placeRows(group, ordered);
      group.count = ordered.length;
      this.refreshGroup(group);
    }
  }

  private createGroup(spec: GroupSpec): Group {
    const section = document.createElement('section');
    section.className = 'triage-group';
    section.dataset.group = spec.id;

    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'triage-group-header';

    const rows = document.createElement('div');
    rows.className = 'triage-rows';
    section.append(header, rows);

    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'triage-chip';
    chip.dataset.group = spec.id;

    const group: Group = { spec, section, header, rows, chip, userOpen: undefined, count: 0 };
    header.addEventListener('click', () => {
      group.userOpen = !this.isOpen(group);
      this.refreshGroup(group);
    });
    chip.addEventListener('click', () => {
      group.userOpen = true;
      this.refreshGroup(group);
      if (typeof section.scrollIntoView === 'function') section.scrollIntoView({ block: 'nearest' });
    });
    this.refreshGroup(group);
    return group;
  }

  private isOpen(group: Group): boolean {
    return group.userOpen ?? group.spec.openByDefault(group.count);
  }

  private refreshGroup(group: Group): void {
    const open = this.isOpen(group);
    const empty = group.count === 0;
    group.section.hidden = empty;
    group.chip.hidden = empty;
    group.chip.textContent = group.spec.chip(group.count);
    group.section.classList.toggle('collapsed', !open);
    group.header.setAttribute('aria-expanded', String(open));
    group.header.textContent = `${open ? '▾' : '▸'} ${group.spec.title} · ${group.count}`;
    group.header.title = open ? 'Collapse' : `Show ${group.count}`;
  }

  private placeRows(group: Group, ordered: AgentInfo[]): void {
    ordered.forEach((agent, index) => {
      const card = this.rows.get(agent.id)!.card;
      const current = group.rows.children[index] ?? null;
      if (current !== card) group.rows.insertBefore(card, current);
    });
    const nested = nestedIds(ordered);
    for (const agent of ordered) this.rows.get(agent.id)!.card.classList.toggle('subagent', nested.has(agent.id));
  }

  private updateRow(row: Row, agent: AgentInfo): void {
    row.name.textContent = agent.name;
    const minutes = agent.extras?.waitMinutes;
    const waits = agent.extras?.attention !== undefined && minutes !== undefined;
    row.wait.textContent = waits ? formatWait(minutes) : '';
    row.wait.hidden = !waits;
    row.activity.textContent = activityLabel(agent);
    this.updateTags(row, agent);
    if (row.menu && row.menu !== document.activeElement) row.menu.value = agent.activity;
  }

  private updateTags(row: Row, agent: AgentInfo): void {
    const provider = agent.extras?.provider;
    const badges = agent.extras?.badges ?? [];
    const key = JSON.stringify([provider ?? null, badges]);
    if (key === row.tagKey) return;
    row.tagKey = key;
    const chips: HTMLElement[] = [];
    if (provider) chips.push(textChip('agent-provider', provider));
    for (const badge of badges) chips.push(textChip('agent-badge', badge));
    row.tags.replaceChildren(...chips);
    row.tags.hidden = chips.length === 0;
  }

  private addRow(agent: AgentInfo): Row {
    const card = document.createElement('div');
    card.className = 'agent-card';
    card.dataset.agentId = agent.id;
    card.classList.toggle('selected', agent.id === this.selectedId);

    const top = document.createElement('div');
    top.className = 'agent-top';
    const name = document.createElement('span');
    name.className = 'agent-name';
    const wait = document.createElement('span');
    wait.className = 'agent-wait';
    top.append(name, wait);

    const activity = document.createElement('div');
    activity.className = 'agent-activity';
    const tags = document.createElement('div');
    tags.className = 'agent-tags';
    card.append(top, activity, tags);

    const onSelect = this.options.onSelect;
    if (onSelect) {
      card.classList.add('selectable');
      card.title = 'Select and fly to this agent';
      card.tabIndex = 0;
      card.setAttribute('role', 'button');
      card.addEventListener('click', () => onSelect(agent.id));
      card.addEventListener('keydown', (event) => {
        if (event.target !== card || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        onSelect(agent.id);
      });
    }

    const menu = this.options.demo ? this.createMenu(agent.id) : null;
    if (menu) card.appendChild(menu);

    const row: Row = { card, name, wait, activity, tags, tagKey: '', menu };
    this.rows.set(agent.id, row);
    return row;
  }

  private createMenu(agentId: string): HTMLSelectElement {
    const menu = document.createElement('select');
    for (const activity of ACTIVITIES) {
      const option = document.createElement('option');
      option.value = activity;
      option.textContent = ACTIVITY_LABELS[activity];
      menu.appendChild(option);
    }
    menu.addEventListener('click', (event) => event.stopPropagation());
    menu.addEventListener('keydown', (event) => event.stopPropagation());
    menu.addEventListener('change', () => this.options.onPick?.(agentId, menu.value as Activity));
    return menu;
  }
}

function textChip(className: string, text: string): HTMLElement {
  const chip = document.createElement('span');
  chip.className = className;
  chip.textContent = text;
  return chip;
}

function byName(a: AgentInfo, b: AgentInfo): number {
  return a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function byWait(a: AgentInfo, b: AgentInfo): number {
  return compareWaits(a.extras, b.extras) || byName(a, b);
}

/** Subagents whose parent is in the same list. */
function nestedIds(agents: AgentInfo[]): Set<string> {
  const ids = new Set(agents.map((agent) => agent.id));
  const nested = new Set<string>();
  for (const agent of agents) {
    const parent = agent.extras?.parentId;
    if (parent !== undefined && parent !== agent.id && ids.has(parent)) nested.add(agent.id);
  }
  return nested;
}

function orderGroup(id: TriageGroupId, agents: AgentInfo[]): AgentInfo[] {
  if (id === 'needs-you' || id === 'your-turn' || id === 'cold') return [...agents].sort(byWait);
  if (id === 'idle') return [...agents].sort(byName);

  const nested = nestedIds(agents);
  const children = new Map<string, AgentInfo[]>();
  for (const agent of agents) {
    if (!nested.has(agent.id)) continue;
    const parent = agent.extras!.parentId!;
    children.set(parent, [...(children.get(parent) ?? []), agent]);
  }
  const ordered: AgentInfo[] = [];
  for (const agent of agents.filter((a) => !nested.has(a.id)).sort(byName)) {
    ordered.push(agent, ...(children.get(agent.id) ?? []).sort(byName));
  }
  return ordered;
}

const COLLAPSED_KEY = 'agents-office.panel-collapsed';

/** The header button hides the panel body so the room stays visible. The choice survives a reload. */
export function setupPanelCollapse(
  root: HTMLElement,
  button: HTMLElement,
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined,
): void {
  const apply = (collapsed: boolean) => {
    root.classList.toggle('collapsed', collapsed);
    button.setAttribute('aria-expanded', String(!collapsed));
    button.textContent = collapsed ? '▸' : '▾';
    button.title = collapsed ? 'Show the agent list' : 'Hide the agent list';
  };
  apply(readCollapsed(storage));
  button.addEventListener('click', () => {
    const collapsed = !root.classList.contains('collapsed');
    apply(collapsed);
    try {
      storage?.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
    } catch (error) {
      console.debug('panel state not saved', error);
    }
  });
}

function readCollapsed(storage: Pick<Storage, 'getItem'> | undefined): boolean {
  try {
    return storage?.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}
