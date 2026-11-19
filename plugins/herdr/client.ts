import type { AgentInfo } from '../../src/agents/AgentData.js';
import { registerExtension } from '../../src/extensions.js';
import { registerCardAction, type CardAction } from '../../src/ui/AgentCard.js';

/**
 * Browser part of the herdr focus action. It adds a "Focus in herdr" button to
 * the agent card (`src/ui/AgentCard.ts`) for an agent whose actions hold `focus`
 * (AGENTS_OFFICE_HERDR_FOCUS=1 and the agent has a herdr pane). The click sends
 * the public agent id with the per-server token. The card shows the result as text.
 */

export const TOKEN_URL = '/api/actions/token';
export const FOCUS_URL = '/api/actions/focus';

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

function canFocus(agent: AgentInfo): boolean {
  return Array.isArray(agent.extras?.actions) && agent.extras.actions.includes('focus');
}

/**
 * The "Focus in herdr" button of the agent card. It shows only when the server
 * lists `focus` for the agent (a subagent focuses its parent's pane). The
 * request goes out only on the click.
 */
export function focusCardAction(client: FocusClient): CardAction {
  return {
    id: 'herdr-focus',
    label: 'Focus in herdr',
    available: canFocus,
    run: (agent) => client.focus(agent.id),
  };
}

registerExtension({
  id: 'herdr-focus',
  plugin: 'herdr',
  start() {
    registerCardAction(focusCardAction(new FocusClient((url, init) => fetch(url, { ...init, credentials: 'same-origin' }))));
  },
});
