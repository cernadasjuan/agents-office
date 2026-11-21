import type { AgentInfo } from '../../src/agents/AgentData.js';
import { currentWorld } from '../../src/extensions.js';
import { registerCardPanel, type CardPanel } from '../../src/ui/AgentCard.js';
// Speech bubbles and the live tail's scene part (issue #81): a separate module, registered as
// its own extension, but bundled here since the plugin loader only globs `client.ts`.
import './bubbles.js';

/**
 * Browser part of the peek plugin. It adds three sections to the agent card:
 * "Recent" (the last lines, with the last open question pinned on top),
 * "Assets" (links from tool calls) and "Equipment" (skills, personas, repos).
 * It asks `/api/views/peek` for the selected agent only, at most every 5 s while
 * the card stays open (a timer that stops when the card closes). All text goes
 * through textContent. `setPeekTextHidden` hides all peek text for a private mode.
 */

export const PEEK_URL = '/api/views/peek';
export const PEEK_REFRESH_MS = 5000;
/** AC5's tail: "Show 100 lines" asks for this many instead of the default 10. */
export const PEEK_TAIL_LINES = 100;

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
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
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
  /** AC5: "Show 100 lines" was pressed for the agent currently shown. Resets on agent switch. */
  private tailMode = false;
  /** Review: `showTail()` fires a load without waiting for an in-flight one to finish (the
   * normal throttle is for "nothing changed yet", not for a request the user just asked for),
   * so two requests for the same agent can race. Each `load()` call tags itself with the next
   * number; a reply only applies if it is still the newest one asked for, so an older,
   * slower reply (for example the short view's own scheduled poll) never overwrites a newer
   * one still in flight (for example "Show 100 lines"). */
  private requestSeq = 0;
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
      this.tailMode = false;
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

  /** Hide or show all peek text: Recent, the pinned question, Assets and Equipment. */
  setTextHidden(hidden: boolean): void {
    this.textHidden = hidden;
    this.applyTextHidden();
  }

  /** AC5: "Show 100 lines" was pressed. Loads at once (the normal throttle is for "nothing
   * changed yet", not for a request the user just asked for) and stays in tail mode for this
   * agent until the card switches to another one. */
  private showTail(): void {
    if (this.tailMode) return;
    this.tailMode = true;
    this.fetchedAt = -Infinity;
    if (this.agentId !== null) void this.load(this.agentId);
  }

  private async load(agentId: string): Promise<void> {
    const seq = ++this.requestSeq;
    this.inFlightFor = agentId;
    this.fetchedAt = this.now();
    const lines = this.tailMode ? `&lines=${PEEK_TAIL_LINES}` : '';
    let data: PeekData | null = null;
    try {
      const reply = await this.options.fetch(`${PEEK_URL}?agent=${encodeURIComponent(agentId)}${lines}`);
      if (reply.ok) data = parse(await reply.json());
    } catch (error) {
      console.debug('peek request failed', error);
    } finally {
      if (this.inFlightFor === agentId) this.inFlightFor = null;
    }
    if (agentId !== this.agentId) return;
    // A newer request for this agent (for example "Show 100 lines") already started: this
    // reply is stale, whatever it answers, and must never overwrite what the newer one finds.
    if (seq !== this.requestSeq) return;
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
    const key = JSON.stringify([agent.id, agent.extras?.badges, this.data, this.failed, this.tailMode]);
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

    const recent = section('peek-recent', this.tailMode ? 'Recent (last 100)' : 'Recent');
    if (!data) {
      recent.appendChild(el('p', '', this.failed ? 'Recent lines are not available' : 'Loading recent lines…'));
    } else if (data.lines.length === 0) {
      recent.appendChild(el('p', '', 'No recent lines'));
    } else {
      const list = el('ul', 'peek-tail-list');
      for (const line of data.lines) list.appendChild(el('li', line.kind === 'tool' ? 'peek-tool' : 'peek-text', line.text));
      recent.appendChild(list);
    }
    // AC5: the live 100-line tail, one button, never on while already in tail mode.
    if (!this.tailMode) {
      const button = el('button', 'peek-tail-button', 'Show 100 lines') as HTMLButtonElement;
      button.type = 'button';
      button.addEventListener('click', () => this.showTail());
      recent.appendChild(button);
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
    for (const section of root.querySelectorAll<HTMLElement>('.peek-recent, .peek-assets, .peek-equipment')) section.hidden = this.textHidden;
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
