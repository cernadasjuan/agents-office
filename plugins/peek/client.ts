import type { AgentInfo } from '../../src/agents/AgentData.js';
import { currentWorld } from '../../src/extensions.js';
import { registerCardPanel, type CardPanel } from '../../src/ui/AgentCard.js';

/**
 * Browser part of the peek plugin. It adds three sections to the agent card:
 * "Recent" (the last lines, with the last open question pinned on top),
 * "Assets" (links from tool calls) and "Equipment" (skills, personas, repos).
 * It asks `/api/views/peek` for the selected agent only, at most every 5 s while
 * the card stays open. All text goes through textContent. `setPeekTextHidden`
 * hides the transcript text (Recent and the question) for a private mode.
 */

export const PEEK_URL = '/api/views/peek';
export const PEEK_REFRESH_MS = 5000;

export interface PeekReply { ok: boolean; status: number; json(): Promise<unknown> }
export type PeekFetch = (url: string) => Promise<PeekReply>;

interface PeekData {
  lines: Array<{ kind: string; text: string }>;
  question?: string;
  assets: Array<{ kind: string; label: string; url: string }>;
  skills: string[];
  repos: string[];
}

export interface PeekPanelOptions {
  fetch: PeekFetch;
  /** True while the server plugin is loaded. */
  isOn: () => boolean;
  now?: () => number;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function parse(body: unknown): PeekData {
  const raw = (body ?? {}) as Record<string, unknown>;
  const objects = (value: unknown) => (Array.isArray(value) ? value : []).filter((item): item is Record<string, unknown> => !!item && typeof item === 'object');
  return {
    lines: objects(raw.lines).map((line) => ({ kind: String(line.kind ?? ''), text: String(line.text ?? '') })),
    ...(typeof raw.question === 'string' && raw.question ? { question: raw.question } : {}),
    assets: objects(raw.assets).map((asset) => ({ kind: String(asset.kind ?? ''), label: String(asset.label ?? ''), url: String(asset.url ?? '') })),
    skills: strings(raw.skills),
    repos: strings(raw.repos),
  };
}

function isSafeUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

export class PeekPanel implements CardPanel {
  readonly id = 'peek';
  private agentId: string | null = null;
  private agent: AgentInfo | null = null;
  private root: HTMLElement | null = null;
  private data: PeekData | null = null;
  private failed = false;
  private fetchedAt = -Infinity;
  private inFlightFor: string | null = null;
  private drawnKey = '';
  private textHidden = false;
  private readonly now: () => number;

  constructor(private readonly options: PeekPanelOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  available(): boolean {
    return this.options.isOn();
  }

  render(agent: AgentInfo, root: HTMLElement): void {
    this.root = root;
    this.agent = agent;
    if (agent.id !== this.agentId) {
      this.agentId = agent.id;
      this.data = null;
      this.failed = false;
      this.fetchedAt = -Infinity;
    }
    this.draw();
    if (this.inFlightFor !== agent.id && this.now() - this.fetchedAt >= PEEK_REFRESH_MS) void this.load(agent.id);
  }

  /** Hide or show the transcript text (Recent and the pinned question). Assets and Equipment stay. */
  setTextHidden(hidden: boolean): void {
    this.textHidden = hidden;
    this.applyTextHidden();
  }

  private async load(agentId: string): Promise<void> {
    this.inFlightFor = agentId;
    this.fetchedAt = this.now();
    let data: PeekData | null = null;
    try {
      const reply = await this.options.fetch(`${PEEK_URL}?agent=${encodeURIComponent(agentId)}`);
      if (reply.ok) data = parse(await reply.json());
    } catch (error) {
      console.debug('peek request failed', error);
    } finally {
      if (this.inFlightFor === agentId) this.inFlightFor = null;
    }
    if (agentId !== this.agentId) return;
    this.data = data;
    this.failed = data === null;
    this.draw();
  }

  private draw(): void {
    const root = this.root;
    const agent = this.agent;
    if (!root || !agent) return;
    const key = JSON.stringify([agent.id, agent.extras?.badges, this.data, this.failed]);
    if (key === this.drawnKey && root.childElementCount > 0) return;
    this.drawnKey = key;
    const doc = root.ownerDocument;
    const el = (tag: string, className = '', text?: string) => {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const section = (className: string, title: string) => {
      const node = el('section', `inspector-section ${className}`);
      node.appendChild(el('h4', '', title));
      return node;
    };
    const data = this.data;
    const wrapper = el('div', 'peek');

    const question = el('div', 'peek-question', data?.question ?? '');
    question.hidden = !data?.question;
    question.dataset.empty = data?.question ? 'false' : 'true';

    const recent = section('peek-recent', 'Recent');
    if (!data) {
      recent.appendChild(el('p', '', this.failed ? 'Recent lines are not available' : 'Loading recent lines…'));
    } else if (data.lines.length === 0) {
      recent.appendChild(el('p', '', 'No recent lines'));
    } else {
      const list = el('ul');
      for (const line of data.lines) list.appendChild(el('li', line.kind === 'tool' ? 'peek-tool' : 'peek-text', line.text));
      recent.appendChild(list);
    }

    const assets = section('peek-assets', 'Assets');
    if (!data || data.assets.length === 0) {
      assets.appendChild(el('p', '', 'No assets'));
    } else {
      const list = el('ul');
      for (const asset of data.assets) {
        const item = el('li');
        if (isSafeUrl(asset.url)) {
          const link = el('a', '', asset.label) as HTMLAnchorElement;
          link.href = asset.url;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          item.appendChild(link);
        } else {
          item.textContent = asset.label;
        }
        list.appendChild(item);
      }
      assets.appendChild(list);
    }

    const equipment = section('peek-equipment', 'Equipment');
    const facts = el('dl', 'inspector-facts');
    const fact = (title: string, items: string[], empty: string) => facts.append(el('dt', '', title), el('dd', '', items.length > 0 ? items.join(', ') : empty));
    fact('Skills', data?.skills ?? [], 'None');
    fact('Personas', agent.extras?.badges ?? [], 'None');
    fact('Repos', data?.repos ?? [], 'None');
    equipment.appendChild(facts);

    wrapper.append(question, recent, assets, equipment);
    root.replaceChildren(wrapper);
    this.applyTextHidden();
  }

  private applyTextHidden(): void {
    const root = this.root;
    if (!root) return;
    const recent = root.querySelector<HTMLElement>('.peek-recent');
    if (recent) recent.hidden = this.textHidden;
    const question = root.querySelector<HTMLElement>('.peek-question');
    if (question) question.hidden = this.textHidden || question.dataset.empty === 'true';
  }
}

const browserFetch: PeekFetch = (url) => fetch(url, { signal: AbortSignal.timeout(5000) });

/** The card panel of this page. On only while the server loads the peek plugin. */
export const peekPanel = new PeekPanel({ fetch: browserFetch, isOn: () => currentWorld().plugins.includes('peek') });
registerCardPanel(peekPanel);

/** Hide or show peek text on screen (for a private or presentation mode). */
export function setPeekTextHidden(hidden: boolean): void {
  peekPanel.setTextHidden(hidden);
}
