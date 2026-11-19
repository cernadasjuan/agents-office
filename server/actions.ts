/**
 * Opt-in write actions. This module exists for the routes that change
 * something on the machine. The server creates it only when a loaded plugin
 * offers an action, so a default office has no write route and no token.
 *
 * Controls on top of the GET checks (loopback, local Host, same Origin):
 * Origin required on POST, JSON only, a per-server-start token in a custom
 * header (constant-time compare), a 1 KB body cap, a closed body shape
 * (`{ "agent": "<public id>" }`), a rate limit and one audit line per attempt.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ActionName, ActionOutcome, Observation, OfficeAction } from './seam.js';

export const TOKEN_HEADER = 'x-agents-office-token';
export const MAX_BODY_BYTES = 1024;
export const RATE_LIMIT = { max: 10, windowMs: 60_000 };
const PUBLIC_ID = /^[a-f0-9]{64}$/;

const OUTCOME_REPLY: Record<ActionOutcome, { status: number; body: Record<string, unknown> }> = {
  done: { status: 200, body: { ok: true } },
  gone: { status: 409, body: { error: 'The agent target changed or is gone' } },
  failed: { status: 502, body: { error: 'The action failed' } },
};

/** `AGENTS_OFFICE_AUDIT_LOG`, else a file in the OS temp folder. */
export function defaultAuditLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENTS_OFFICE_AUDIT_LOG || path.join(os.tmpdir(), 'agents-office-audit.jsonl');
}

export interface WriteActionsOptions {
  actions: OfficeAction[];
  /** The observation behind a public id, from the last `/api/agents` answer. Raw ids stay on the server. */
  lookup(publicId: string): Observation | undefined;
  auditLogPath: string;
  now?: () => number;
}

type ReadResult = { kind: 'ok'; text: string } | { kind: 'too-large' };

function readBody(req: IncomingMessage, limit: number): Promise<ReadResult> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    req.resume();
    return Promise.resolve({ kind: 'too-large' });
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.off('data', onData);
        req.off('end', onEnd);
        req.resume();
        resolve({ kind: 'too-large' });
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => resolve({ kind: 'ok', text: Buffer.concat(chunks).toString('utf8') });
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', reject);
  });
}

/** The public id from a body of exactly `{ "agent": "<64 hex>" }`, else null. */
export function parseActionBody(text: string): string | null {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed);
  const agent = (parsed as Record<string, unknown>).agent;
  return keys.length === 1 && keys[0] === 'agent' && typeof agent === 'string' && PUBLIC_ID.test(agent) ? agent : null;
}

function isJson(req: IncomingMessage): boolean {
  return (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() === 'application/json';
}

export class WriteActions {
  /** New at every server start, so an old page or a stolen value stops working after a restart. */
  readonly token = randomBytes(32).toString('hex');
  readonly names: ReadonlySet<ActionName>;
  private readonly attempts: number[] = [];
  private readonly now: () => number;

  constructor(private readonly options: WriteActionsOptions) {
    this.names = new Set(options.actions.map((action) => action.name));
    this.now = options.now ?? Date.now;
  }

  get actions(): OfficeAction[] {
    return this.options.actions;
  }

  hasValidToken(req: IncomingMessage): boolean {
    const sent = req.headers[TOKEN_HEADER];
    if (typeof sent !== 'string') return false;
    // Hash both sides to equal lengths, then compare in constant time.
    const digest = (value: string) => createHash('sha256').update(value).digest();
    return timingSafeEqual(digest(sent), digest(this.token));
  }

  private withinRateLimit(): boolean {
    const now = this.now();
    while (this.attempts.length > 0 && now - this.attempts[0] >= RATE_LIMIT.windowMs) this.attempts.shift();
    if (this.attempts.length >= RATE_LIMIT.max) return false;
    this.attempts.push(now);
    return true;
  }

  /** One JSON line per attempt. Never the token, never a raw id or a request body. */
  async audit(action: ActionName, agent: string | undefined, result: string): Promise<void> {
    const line = JSON.stringify({ time: new Date(this.now()).toISOString(), action, ...(agent ? { agent } : {}), result });
    try {
      await appendFile(this.options.auditLogPath, `${line}\n`, { mode: 0o600 });
    } catch (error) {
      console.debug('agents-office: audit line not written', error);
    }
  }

  /** Handle one POST that already passed the loopback, Host, Origin and method checks. */
  async handle(action: OfficeAction, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reply = async (status: number, body: Record<string, unknown>, result: string, agent?: string) => {
      await this.audit(action.name, agent, result);
      res.statusCode = status;
      res.end(JSON.stringify(body));
    };

    if (!this.hasValidToken(req)) return reply(403, { error: 'Invalid token' }, 'refused-token');
    if (!isJson(req)) return reply(415, { error: 'JSON only' }, 'refused-content-type');
    if (!this.withinRateLimit()) return reply(429, { error: 'Too many requests' }, 'refused-rate-limit');

    const body = await readBody(req, MAX_BODY_BYTES);
    if (body.kind === 'too-large') {
      res.setHeader('Connection', 'close');
      return reply(413, { error: 'Body too large' }, 'refused-size');
    }
    const agentId = parseActionBody(body.text);
    if (!agentId) return reply(400, { error: 'Body must be {"agent": "<id>"}' }, 'refused-body');

    const agent = this.options.lookup(agentId);
    if (!agent || !Array.isArray(agent.display?.actions) || !agent.display.actions.includes(action.name)) {
      return reply(404, { error: 'Unknown agent' }, 'unknown-agent', agentId);
    }

    let outcome: ActionOutcome;
    try {
      outcome = await action.run(agent);
    } catch {
      outcome = 'failed';
    }
    const { status, body: payload } = OUTCOME_REPLY[outcome] ?? OUTCOME_REPLY.failed;
    return reply(status, payload, outcome, agentId);
  }
}
