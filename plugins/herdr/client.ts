import type { AgentInfo } from '../../src/agents/AgentData.js';
import type { ManagedAgent } from '../../src/agents/AgentManager.js';
import { registerExtension } from '../../src/extensions.js';
import { onSelectionChange, selectedAgentId } from '../../src/scene/Selection.js';

/**
 * Browser part of the herdr focus action. A small card shows a "Focus in herdr"
 * button for the selected agent, only when the server lists `focus` in its
 * actions (AGENTS_OFFICE_HERDR_FOCUS=1 and the agent has a herdr pane). The
 * click sends the public agent id with the per-server token. All text goes
 * through textContent.
 */

export const TOKEN_URL = '/api/actions/token';
export const FOCUS_URL = '/api/actions/focus';
const TOAST_MS = 3000;

export interface FetchReply { ok: boolean; status: number; json(): Promise<unknown> }
export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<FetchReply>;

const RESULT_TEXT: Record<number, string> = {
  404: 'Agent not found in herdr',
  409: 'The herdr pane is gone',
  429: 'Too many focus requests, wait a minute',
};

export class FocusClient {
  private token: string | null = null;

  constructor(private readonly fetchFn: FetchLike) {}

  private async loadToken(): Promise<string | null> {
    const reply = await this.fetchFn(TOKEN_URL);
    if (!reply.ok) return null;
    const body = await reply.json() as { token?: unknown };
    return typeof body?.token === 'string' ? body.token : null;
  }

  private post(agentId: string, token: string): Promise<FetchReply> {
    return this.fetchFn(FOCUS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agents-Office-Token': token },
      body: JSON.stringify({ agent: agentId }),
    });
  }

  /** Ask the server to focus the agent's herdr pane. Returns a short result text. */
  async focus(agentId: string): Promise<string> {
    try {
      this.token ??= await this.loadToken();
      if (!this.token) return 'Focus is not enabled';
      let reply = await this.post(agentId, this.token);
      if (reply.status === 403) {
        // The server may have restarted with a new token: fetch it once and retry once.
        this.token = await this.loadToken();
        if (!this.token) return 'Focus is not enabled';
        reply = await this.post(agentId, this.token);
      }
      if (reply.ok) return 'Focused in herdr';
      return RESULT_TEXT[reply.status] ?? 'Focus failed';
    } catch {
      return 'Focus failed';
    }
  }
}

function canFocus(agent: AgentInfo | undefined): agent is AgentInfo {
  return Array.isArray(agent?.extras?.actions) && agent.extras.actions.includes('focus');
}

export class HerdrFocusCard {
  private readonly root: HTMLElement;
  private readonly label: HTMLElement;
  private readonly button: HTMLButtonElement;
  private readonly toast: HTMLElement;
  private target: AgentInfo | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(parent: HTMLElement, private readonly client: FocusClient) {
    this.root = document.createElement('div');
    this.root.id = 'herdr-focus-card';
    this.root.hidden = true;
    Object.assign(this.root.style, {
      position: 'fixed', bottom: '16px', left: '50%', transform: 'translateX(-50%)', zIndex: '20',
      display: 'flex', gap: '8px', alignItems: 'center', padding: '6px 10px', borderRadius: '6px',
      background: 'rgba(20, 22, 30, 0.85)', color: '#fff', font: '12px system-ui, sans-serif',
    });
    this.label = document.createElement('span');
    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.textContent = 'Focus in herdr';
    this.button.addEventListener('click', () => void this.click());
    this.root.append(this.label, this.button);

    this.toast = document.createElement('div');
    this.toast.id = 'herdr-focus-toast';
    this.toast.hidden = true;
    this.toast.setAttribute('role', 'status');
    Object.assign(this.toast.style, {
      position: 'fixed', bottom: '56px', left: '50%', transform: 'translateX(-50%)', zIndex: '20',
      padding: '4px 10px', borderRadius: '6px', background: 'rgba(20, 22, 30, 0.85)', color: '#fff',
      font: '12px system-ui, sans-serif',
    });
    parent.append(this.root, this.toast);
  }

  /** Show the card for the selected agent when it advertises focus, else hide it. */
  update(agents: AgentInfo[], selectedId: string | null): void {
    const agent = selectedId === null ? undefined : agents.find((candidate) => candidate.id === selectedId);
    this.target = canFocus(agent) ? agent : null;
    this.root.hidden = this.target === null;
    this.label.textContent = this.target?.name ?? '';
  }

  async click(): Promise<void> {
    if (!this.target) return;
    this.button.disabled = true;
    try {
      this.showToast(await this.client.focus(this.target.id));
    } finally {
      this.button.disabled = false;
    }
  }

  private showToast(text: string): void {
    this.toast.textContent = text;
    this.toast.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { this.toast.hidden = true; }, TOAST_MS);
  }
}

let card: HerdrFocusCard | null = null;
let latest: AgentInfo[] = [];

registerExtension({
  id: 'herdr-focus',
  plugin: 'herdr',
  start() {
    card = new HerdrFocusCard(document.body, new FocusClient((url, init) => fetch(url, { ...init, credentials: 'same-origin' })));
    onSelectionChange((agentId) => card?.update(latest, agentId));
  },
  agentsChanged(agents: ManagedAgent[]) {
    latest = agents.map((managed) => managed.info);
    card?.update(latest, selectedAgentId());
  },
});
