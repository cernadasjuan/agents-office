import type { AgentInfo } from '../../src/agents/AgentData.js';
import { currentWorld } from '../../src/extensions.js';
import { registerCardPanel, type CardPanel } from '../../src/ui/AgentCard.js';

/**
 * Browser part of the peek plugin. It adds two sections to the agent card:
 * "Recent" (the last lines, with the last open question pinned on top) and
 * "Links" (links from tool calls — named and styled distinctly from the card's
 * own "Issues" section, Sally's round 7 review AC5, so neither list reads as a
 * continuation of the other while scanning). The old "Equipment" section
 * (skills, personas, repos as a `<dl>` fact list) is gone (AC4): that data now
 * lives only in the card's own Persona/Skills/Repos table, which renders at
 * the same instant as the rest of the card instead of behind this plugin's
 * async per-agent fetch (issue #216). It asks `/api/views/peek` for the
 * selected agent only, at most every 5 s while the card stays open (a timer
 * that stops when the card closes). All text goes through textContent.
 * `setPeekTextHidden` hides all peek text for a private mode.
 */

export const PEEK_URL = '/api/views/peek';
export const PEEK_REFRESH_MS = 5000;

export interface PeekReply { ok: boolean; status: number; json(): Promise<unknown> }
export type PeekFetch = (url: string) => Promise<PeekReply>;

interface PeekData {
  lines: Array<{ kind: string; text: string }>;
  question?: string;
  assets: Array<{ kind: string; label: string; url: string }>;
}

export interface PeekPanelOptions {
  fetch: PeekFetch;
  /** True while the server plugin is loaded. */
  isOn: () => boolean;
  now?: () => number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

function parse(body: unknown): PeekData {
  const raw = (body ?? {}) as Record<string, unknown>;
  const objects = (value: unknown) => (Array.isArray(value) ? value : []).filter((item): item is Record<string, unknown> => !!item && typeof item === 'object');
  return {
    lines: objects(raw.lines).map((line) => ({ kind: String(line.kind ?? ''), text: String(line.text ?? '') })),
    ...(typeof raw.question === 'string' && raw.question ? { question: raw.question } : {}),
    assets: objects(raw.assets).map((asset) => ({ kind: String(asset.kind ?? ''), label: String(asset.label ?? ''), url: String(asset.url ?? '') })),
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
  private timer: unknown = null;
  private readonly now: () => number;
  private readonly setTimer: (run: () => void, ms: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;

  constructor(private readonly options: PeekPanelOptions) {
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimer ?? ((run, ms) => {
      const timer = setTimeout(run, ms) as unknown as { unref?: () => void };
      // Node only (tests): an open card timer must not keep the process alive.
      timer.unref?.();
      return timer;
    });
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
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
    if (this.inFlightFor === agent.id) return;
    const wait = PEEK_REFRESH_MS - (this.now() - this.fetchedAt);
    if (wait <= 0) void this.load(agent.id);
    // Throttled: one trailing load when the throttle ends, so a change is never dropped.
    else if (this.timer === null) this.schedule(wait);
  }

  /** The card closed or the plugin went off: stop the refresh, load at once on the next show. */
  hide(): void {
    this.stopTimer();
    this.agentId = null;
    this.agent = null;
    this.root = null;
    this.drawnKey = '';
  }

  private schedule(ms: number): void {
    this.stopTimer();
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (this.agentId !== null && this.inFlightFor !== this.agentId) void this.load(this.agentId);
    }, ms);
  }

  private stopTimer(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  /** Hide or show all peek text: Recent, the pinned question and Links. */
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
    // While the card shows this agent, refresh every PEEK_REFRESH_MS.
    this.schedule(PEEK_REFRESH_MS);
  }

  private draw(): void {
    const root = this.root;
    const agent = this.agent;
    if (!root || !agent) return;
    const key = JSON.stringify([agent.id, this.data, this.failed]);
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

    // "Links" (was "Assets"), relabeled and distinctly styled from the card's own "Issues"
    // section (Sally's round 7 review, AC5): identical markup used to make the two lists read
    // as one continuous link dump while scanning top to bottom. `.peek-links` carries its own
    // accent color so this list is visually, not just textually, a different thing.
    const links = section('peek-links', 'Links');
    if (!data || data.assets.length === 0) {
      links.appendChild(el('p', '', 'No links'));
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
      links.appendChild(list);
    }

    wrapper.append(question, recent, links);
    root.replaceChildren(wrapper);
    this.applyTextHidden();
  }

  private applyTextHidden(): void {
    const root = this.root;
    if (!root) return;
    for (const section of root.querySelectorAll<HTMLElement>('.peek-recent, .peek-links')) section.hidden = this.textHidden;
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
