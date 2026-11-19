/**
 * herdr plugin. Names each Claude session after its herdr tab and groups the
 * session and its subagents by herdr workspace.
 *
 * The join: every process started in a herdr pane has HERDR_PANE_ID,
 * HERDR_TAB_ID and HERDR_WORKSPACE_ID in its environment. The plugin reads
 * only those three variables (one `ps eww` for all new session PIDs), then
 * the tab and workspace labels (`herdr tab list`, `herdr workspace list`).
 * All commands are read-only,
 * run through execFile with fixed arguments and a timeout. Any failure
 * leaves the observations unchanged. Raw herdr IDs stay on the server: the
 * projection hashes groupKey and names never hold an ID.
 *
 * Opt-in write action (AGENTS_OFFICE_HERDR_FOCUS=1): focus the herdr pane of
 * an agent. The enricher keeps a server-side map from observation to pane and
 * tab id and advertises `actions: ['focus']`. Before it acts, the action
 * re-reads the process environment and `herdr pane get`, then runs
 * `herdr agent focus <pane>` (fallback `herdr tab focus <tab>`). Nothing else:
 * no text, no keys.
 */
import { execFile } from 'node:child_process';
import type { ActionOutcome, Observation, OfficeAction, OfficePlugin } from '../../server/seam.js';

export type Runner = (file: string, args: string[], options: { timeout: number }) => Promise<string>;

export interface HerdrEnv { paneId: string; tabId: string; workspaceId: string }

/** Where the focus action points for one observation. Stays on the server. */
interface FocusTarget { pid: number; paneId: string; tabId: string }

interface HerdrNames {
  tabs: Map<string, { label: string; workspaceId: string }>;
  workspaces: Map<string, string>;
}

const COMMAND_TIMEOUT_MS = 1500;
const REFRESH_MS = 10_000;
/** The seam drops an enricher after 2 s. Results that arrive later are not applied. */
const APPLY_DEADLINE_MS = 1800;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const HERDR_ID = /^[A-Za-z0-9:_-]{1,64}$/;

export const defaultRunner: Runner = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: options.timeout, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8', windowsHide: true },
    (error, stdout) => (error ? reject(error) : resolve(stdout)));
});

function lastValue(text: string, name: string): string | undefined {
  const pattern = new RegExp(`(?:^|\\s)${name}=(\\S*)`, 'g');
  let value: string | undefined;
  for (const match of text.matchAll(pattern)) value = match[1];
  return value;
}

/**
 * The three herdr variables from `ps eww` output, or null. The environment
 * follows the arguments, so the last match wins. Nothing else is kept.
 */
export function parseHerdrEnv(psOutput: string): HerdrEnv | null {
  const paneId = lastValue(psOutput, 'HERDR_PANE_ID');
  const tabId = lastValue(psOutput, 'HERDR_TAB_ID');
  const workspaceId = lastValue(psOutput, 'HERDR_WORKSPACE_ID');
  if (!paneId || !tabId || !workspaceId) return null;
  if (![paneId, tabId, workspaceId].every((id) => HERDR_ID.test(id))) return null;
  return { paneId, tabId, workspaceId };
}

/**
 * Split `ps -o pid=,command=` output into one text per requested PID. A line
 * that does not start with a requested, not yet seen PID continues the
 * previous process (an environment value may hold a newline).
 */
export function splitByPid(output: string, requested: Set<number>): Map<number, string> {
  const byPid = new Map<number, string>();
  let current: number | undefined;
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s(.*)$/.exec(line);
    const pid = match ? Number(match[1]) : undefined;
    if (pid !== undefined && requested.has(pid) && !byPid.has(pid)) {
      current = pid;
      byPid.set(pid, match![2]);
    } else if (current !== undefined) {
      byPid.set(current, `${byPid.get(current)} ${line}`);
    }
  }
  return byPid;
}

function resultList(output: string, key: 'tabs' | 'workspaces'): Array<Record<string, unknown>> | null {
  let parsed: unknown;
  try { parsed = JSON.parse(output); } catch { return null; }
  const list = (parsed as { result?: Record<string, unknown> } | null)?.result?.[key];
  return Array.isArray(list) ? list.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null) : null;
}

function isHerdrId(value: unknown): value is string {
  return typeof value === 'string' && HERDR_ID.test(value);
}

function parseNames(tabsOutput: string, workspacesOutput: string): HerdrNames | null {
  const tabList = resultList(tabsOutput, 'tabs');
  const workspaceList = resultList(workspacesOutput, 'workspaces');
  if (!tabList || !workspaceList) return null;
  const tabs = new Map<string, { label: string; workspaceId: string }>();
  for (const tab of tabList) {
    if (isHerdrId(tab.tab_id) && isHerdrId(tab.workspace_id) && typeof tab.label === 'string') {
      tabs.set(tab.tab_id, { label: tab.label, workspaceId: tab.workspace_id });
    }
  }
  const workspaces = new Map<string, string>();
  for (const workspace of workspaceList) {
    if (isHerdrId(workspace.workspace_id) && typeof workspace.label === 'string') {
      workspaces.set(workspace.workspace_id, workspace.label);
    }
  }
  return { tabs, workspaces };
}

/** The pane from `herdr pane get` output, or null. */
function parsePane(output: string): { paneId: string; tabId: string; hasAgent: boolean } | null {
  let parsed: unknown;
  try { parsed = JSON.parse(output); } catch { return null; }
  const pane = (parsed as { result?: { pane?: Record<string, unknown> } } | null)?.result?.pane;
  if (typeof pane !== 'object' || pane === null || !isHerdrId(pane.pane_id) || !isHerdrId(pane.tab_id)) return null;
  return { paneId: pane.pane_id, tabId: pane.tab_id, hasAgent: typeof pane.agent === 'string' && pane.agent.length > 0 };
}

export interface HerdrPluginOptions {
  run?: Runner;
  now?: () => number;
  /** The focus write action. Default: AGENTS_OFFICE_HERDR_FOCUS=1. */
  focus?: boolean;
}

export function createHerdrPlugin(options: HerdrPluginOptions = {}): OfficePlugin {
  const run = options.run ?? defaultRunner;
  const now = options.now ?? Date.now;
  const focusEnabled = options.focus ?? process.env.AGENTS_OFFICE_HERDR_FOCUS === '1';
  /** Observation id → pane and tab, from the last enrich. Only filled when focus is on. */
  let focusTargets = new Map<string, FocusTarget>();
  /** PID → herdr env (null: the process is not in herdr). A process environment does not change. */
  const envByPid = new Map<number, HerdrEnv | null>();
  /** PID → time of the last failed `ps`, so a failing PID is retried only after REFRESH_MS. */
  const failedPids = new Map<number, number>();
  let names: { value: HerdrNames | null; at: number } | undefined;
  let namesInFlight: Promise<HerdrNames | null> | undefined;

  /** One `ps` for every PID not seen yet. Parallel `ps eww` calls are slow, one batch is not. */
  async function loadEnvs(pids: number[]): Promise<void> {
    const pending = pids.filter((pid) => !envByPid.has(pid)
      && !(failedPids.has(pid) && now() - (failedPids.get(pid) as number) < REFRESH_MS));
    if (pending.length === 0) return;
    try {
      const output = await run('ps', ['eww', '-o', 'pid=,command=', '-p', pending.join(',')], { timeout: COMMAND_TIMEOUT_MS });
      const byPid = splitByPid(output, new Set(pending));
      for (const pid of pending) {
        envByPid.set(pid, parseHerdrEnv(byPid.get(pid) ?? ''));
        failedPids.delete(pid);
      }
    } catch {
      for (const pid of pending) failedPids.set(pid, now());
    }
  }

  async function fetchNames(): Promise<HerdrNames | null> {
    try {
      const [tabs, workspaces] = await Promise.all([
        run('herdr', ['tab', 'list'], { timeout: COMMAND_TIMEOUT_MS }),
        run('herdr', ['workspace', 'list'], { timeout: COMMAND_TIMEOUT_MS }),
      ]);
      return parseNames(tabs, workspaces);
    } catch {
      return null;
    }
  }

  async function currentNames(): Promise<HerdrNames | null> {
    if (names && now() - names.at < REFRESH_MS) return names.value;
    namesInFlight ??= fetchNames().then((value) => {
      names = { value, at: now() };
      namesInFlight = undefined;
      return value;
    });
    return namesInFlight;
  }

  function forgetGonePids(livePids: Set<number>): void {
    for (const pid of envByPid.keys()) if (!livePids.has(pid)) envByPid.delete(pid);
    for (const pid of failedPids.keys()) if (!livePids.has(pid)) failedPids.delete(pid);
  }

  async function enrich(observations: Observation[]): Promise<void> {
    const startedAt = now();
    const mains = observations.filter((agent) => agent.provider === 'claude' && !agent.parentId
      && typeof agent.internal?.pid === 'number' && Number.isInteger(agent.internal.pid) && agent.internal.pid > 0);
    if (mains.length === 0) return;
    const pids = new Set(mains.map((agent) => agent.internal.pid as number));
    forgetGonePids(pids);

    const [, herdrNames] = await Promise.all([loadEnvs([...pids]), currentNames()]);
    if (!herdrNames || now() - startedAt > APPLY_DEADLINE_MS) return;
    const envs = mains.map((agent) => envByPid.get(agent.internal.pid as number) ?? null);
    if (focusEnabled) advertiseFocus(observations, mains, envs);

    const groupByParent = new Map<string, { key: string; label: string }>();
    mains.forEach((agent, index) => {
      const env = envs[index];
      const tab = env ? herdrNames.tabs.get(env.tabId) : undefined;
      if (!tab) return;
      if (tab.label.trim()) agent.name = tab.label;
      const workspaceLabel = herdrNames.workspaces.get(tab.workspaceId);
      if (workspaceLabel === undefined) return;
      agent.display.groupKey = tab.workspaceId;
      agent.display.groupLabel = workspaceLabel;
      groupByParent.set(agent.id, { key: tab.workspaceId, label: workspaceLabel });
    });
    for (const agent of observations) {
      const group = agent.parentId ? groupByParent.get(agent.parentId) : undefined;
      if (!group) continue;
      agent.display.groupKey = group.key;
      agent.display.groupLabel = group.label;
    }
  }

  function advertiseFocus(observations: Observation[], mains: Observation[], envs: Array<HerdrEnv | null>): void {
    const targets = new Map<string, FocusTarget>();
    mains.forEach((agent, index) => {
      const env = envs[index];
      if (env) targets.set(agent.id, { pid: agent.internal.pid as number, paneId: env.paneId, tabId: env.tabId });
    });
    // A subagent runs inside its parent's pane.
    for (const agent of observations) {
      const target = agent.parentId ? targets.get(agent.parentId) : undefined;
      if (target && !targets.has(agent.id)) targets.set(agent.id, target);
    }
    for (const agent of observations) if (targets.has(agent.id)) agent.display.actions = ['focus'];
    focusTargets = targets;
  }

  /** The pane of the target, if the process still runs in it and herdr still has it in the same tab. */
  async function recheck(target: FocusTarget): Promise<{ hasAgent: boolean } | null> {
    try {
      const output = await run('ps', ['eww', '-o', 'pid=,command=', '-p', String(target.pid)], { timeout: COMMAND_TIMEOUT_MS });
      const env = parseHerdrEnv(splitByPid(output, new Set([target.pid])).get(target.pid) ?? '');
      if (!env || env.paneId !== target.paneId || env.tabId !== target.tabId) return null;
      const pane = parsePane(await run('herdr', ['pane', 'get', target.paneId], { timeout: COMMAND_TIMEOUT_MS }));
      if (!pane || pane.paneId !== target.paneId || pane.tabId !== target.tabId) return null;
      return { hasAgent: pane.hasAgent };
    } catch {
      return null;
    }
  }

  async function focus(agent: Observation): Promise<ActionOutcome> {
    const target = focusTargets.get(agent.id);
    if (!target || !Number.isInteger(target.pid) || target.pid <= 0
      || !HERDR_ID.test(target.paneId) || !HERDR_ID.test(target.tabId)) return 'gone';
    const pane = await recheck(target);
    if (!pane) return 'gone';
    if (pane.hasAgent) {
      try {
        await run('herdr', ['agent', 'focus', target.paneId], { timeout: COMMAND_TIMEOUT_MS });
        return 'done';
      } catch {
        // herdr lost the agent detection: focus the tab instead.
      }
    }
    try {
      await run('herdr', ['tab', 'focus', target.tabId], { timeout: COMMAND_TIMEOUT_MS });
      return 'done';
    } catch {
      return 'failed';
    }
  }

  const actions: OfficeAction[] = [{ name: 'focus', run: focus }];
  return { name: 'herdr', enrichers: [{ id: 'herdr-names', enrich }], ...(focusEnabled ? { actions } : {}) };
}

export default createHerdrPlugin();
