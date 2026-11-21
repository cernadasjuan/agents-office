import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import type { ManagedAgent } from '../../src/agents/AgentManager.js';
import { registerExtension, type OfficeExtension } from '../../src/extensions.js';
import { officeSelection } from '../../src/scene/Selection.js';
import { callsForYou } from '../../src/ui/attention.js';
import { BUBBLE_CAP, BubbleScheduler, type BubbleEvent } from './bubbleFeed.js';

/**
 * The scene part of the peek plugin's bubbles (issue #81, SBE-2): a fixed pool of `BUBBLE_CAP`
 * CSS2D elements (no mesh, no draw calls — the same renderer the agent labels use), reparented
 * each refresh onto whichever agent `BubbleScheduler.winners` picks. A pool, not one element per
 * agent, keeps the cost fixed regardless of how many agents are in the office; nothing here
 * allocates per frame, only per refresh (throttled below), and only up to `BUBBLE_CAP` DOM writes.
 */

/** Between the label (y=2.1, `characters/Label.ts`) and the beacon (y=2.55, `StickFigure.ts`):
 * "never covers the beacon" (AC4) — the bubble's own box only grows downward from this anchor
 * (see the CSS: `.agent-bubble-box` is `position: absolute; top: ...`, never centered on it),
 * so it never reaches up toward the beacon regardless of the office's zoom level.
 *
 * Review (issue #81): this keeps a bubble off its OWN owner's beacon only, by construction (one
 * is always above the other in world Y). A bubble can still land on a neighboring agent's
 * beacon in a crowded room, in screen space, from some camera angles — the same kind of check
 * `LabelDeclutter.ts`'s desk-mode obstruction rects already do for the triage monitors.
 * Follow-up, not fixed here: cheap only with that same per-frame screen-space obstruction
 * pass, which this module does not have. */
const BUBBLE_Y = 2.32;
const REFRESH_INTERVAL_MS = 150;
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 5000;
const BUBBLES_URL = '/api/bubbles';

interface BubbleSlot {
  readonly object: CSS2DObject;
  agentId: string | null;
}

function createSlot(): BubbleSlot {
  const outer = document.createElement('div');
  outer.className = 'agent-bubble';
  const box = document.createElement('div');
  box.className = 'agent-bubble-box';
  outer.appendChild(box);
  const object = new CSS2DObject(outer);
  object.position.set(0, BUBBLE_Y, 0);
  return { object, agentId: null };
}

function textOf(slot: BubbleSlot): HTMLElement {
  return slot.object.element.firstElementChild as HTMLElement;
}

/** Parses `/api/bubbles`' answer (a plain object keyed by public agent id) into the map
 * `BubbleScheduler.ingest` expects. Anything not shaped like a bubble is dropped, never thrown:
 * a malformed or missing answer (AC6: the plugin off) is just "nothing new this poll". */
function parseBubbles(body: unknown): Map<string, BubbleEvent> {
  const events = new Map<string, BubbleEvent>();
  if (!body || typeof body !== 'object') return events;
  for (const [id, value] of Object.entries(body as Record<string, unknown>)) {
    const entry = value as { kind?: unknown; text?: unknown } | null;
    if (!entry || typeof entry.text !== 'string' || entry.text.length === 0) continue;
    events.set(id, { kind: entry.kind === 'tool' ? 'tool' : 'text', text: entry.text });
  }
  return events;
}

export class BubblesExtension implements OfficeExtension {
  readonly id = 'peek-bubbles';
  readonly plugin = 'peek';
  private readonly scheduler = new BubbleScheduler();
  private slots: BubbleSlot[] = [];
  private agents: ManagedAgent[] = [];
  private pollInFlight = false;
  private lastRefresh = Number.NEGATIVE_INFINITY;

  constructor(private readonly cap: number, private readonly fetchJson: (url: string) => Promise<unknown>, private readonly now: () => number = () => Date.now()) {}

  /** Builds the pool only once the plugin is actually active (issue #81 review: a module-level
   * `registerExtension` call must never touch `document` at import time — this plugin's own
   * card-panel tests import `client.ts`, and so this file, outside a browser). */
  start(): void {
    this.slots = Array.from({ length: this.cap }, createSlot);
    void this.poll();
    window.setInterval(() => void this.poll(), POLL_INTERVAL_MS);
  }

  agentsChanged(agents: ManagedAgent[]): void {
    this.agents = agents;
    this.scheduler.forget(new Set(agents.map((agent) => agent.info.id)));
  }

  update(): void {
    const now = this.now();
    if (now - this.lastRefresh < REFRESH_INTERVAL_MS) return;
    this.lastRefresh = now;
    this.refresh(now);
  }

  private async poll(): Promise<void> {
    if (this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      const body = await this.fetchJson(BUBBLES_URL);
      this.scheduler.ingest(parseBubbles(body), this.now());
    } catch (error) {
      console.debug('bubbles poll failed', error);
    } finally {
      this.pollInFlight = false;
    }
  }

  private refresh(now: number): void {
    const selectedId = officeSelection().selected;
    const hotIds = new Set(this.agents.filter((agent) => callsForYou(agent.info.extras)).map((agent) => agent.info.id));
    const winners = this.scheduler.winners({ now, selectedId, hotIds });
    const byId = new Map(this.agents.map((agent) => [agent.info.id, agent]));
    const keep = new Set(winners.map((winner) => winner.agentId));

    for (const slot of this.slots) {
      if (slot.agentId !== null && !keep.has(slot.agentId)) this.release(slot);
    }
    for (const winner of winners) {
      const agent = byId.get(winner.agentId);
      if (!agent) continue;
      let slot = this.slots.find((candidate) => candidate.agentId === winner.agentId);
      slot ??= this.slots.find((candidate) => candidate.agentId === null);
      if (!slot) continue; // every slot in use: winners is already capped to `cap`, so this never triggers
      if (slot.agentId !== winner.agentId) {
        slot.object.removeFromParent();
        agent.figure.joints.root.add(slot.object);
        slot.agentId = winner.agentId;
      }
      const box = textOf(slot);
      box.textContent = winner.text;
      box.classList.toggle('tool', winner.kind === 'tool');
      slot.object.element.style.opacity = winner.opacity.toFixed(2);
    }
  }

  private release(slot: BubbleSlot): void {
    slot.object.removeFromParent();
    slot.agentId = null;
    textOf(slot).textContent = '';
  }
}

const bubblesFetch = (url: string): Promise<unknown> =>
  fetch(url, { signal: AbortSignal.timeout(POLL_TIMEOUT_MS) }).then((res) => (res.ok ? res.json() : {}));

registerExtension(new BubblesExtension(BUBBLE_CAP, bubblesFetch));
