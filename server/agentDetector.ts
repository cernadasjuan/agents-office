import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface DetectedAgent {
  id: string;
  name: string;
  pid: number;
  cwd: string;
  startedAt: number;
  alive: boolean;
  activity: string;
  parentId?: string;
  /** Session file status (busy, idle, waiting, shell). Server only. */
  status?: string;
  /** When the session file status last changed, in ms. Server only. */
  statusSince?: number;
}

interface SessionFile {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
}

function isSessionFile(value: unknown): value is SessionFile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const session = value as Record<string, unknown>;
  return typeof session.pid === 'number'
    && Number.isSafeInteger(session.pid) && session.pid > 0
    && typeof session.sessionId === 'string' && session.sessionId.trim().length > 0
    && typeof session.cwd === 'string' && path.isAbsolute(session.cwd) && !session.cwd.includes('\0')
    && typeof session.startedAt === 'number' && Number.isFinite(session.startedAt) && session.startedAt >= 0;
}

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Permission denial still proves the process exists; no signal is sent.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// Docs file patterns
const DOCS_FILE_PATTERN = /\.(md|rst|txt|adoc)$|readme|changelog|license|contributing|docs\//i;

/**
 * Infer activity from a tool_use block (name + input).
 * Language-agnostic: based on what Claude is actually doing, not what the user asked.
 */
function inferActivityFromTool(name: string, input?: Record<string, unknown>): string {
  switch (name) {
    // Reading/exploring
    case 'Read':
    case 'Grep':
    case 'Glob':
    case 'Agent':
    case 'WebSearch':
    case 'WebFetch':
      return 'researching';

    // Writing — check if it's docs or code
    case 'Edit':
    case 'Write': {
      const filePath = (input?.file_path as string) ?? '';
      return DOCS_FILE_PATTERN.test(filePath) ? 'writing_docs' : 'implementing';
    }
    case 'NotebookEdit':
      return 'implementing';

    // Shell commands — refined by content
    case 'Bash':
      return inferBashActivity((input?.command as string) ?? '');

    // Planning
    case 'EnterPlanMode':
    case 'ExitPlanMode':
    case 'TaskCreate':
    case 'TaskUpdate':
      return 'planning';

    // Asking the user a question: the agent waits in a meeting with the user
    case 'AskUserQuestion':
      return 'meeting';

    // Loading instructions or tool definitions is reading
    case 'Skill':
    case 'ToolSearch':
      return 'researching';

    default:
      return name.startsWith('mcp__') ? inferMcpActivity(name) : 'implementing';
  }
}

const MCP_READ_WORDS = /(^|_)(get|list|search|read|fetch|query|find|view|lookup|describe)(_|$)/;

function inferMcpActivity(name: string): string {
  const operation = name.split('__').pop() ?? '';
  return MCP_READ_WORDS.test(operation.toLowerCase()) ? 'researching' : 'implementing';
}

const READ_ONLY_PROGRAMS = new Set([
  'cd', 'ls', 'cat', 'head', 'tail', 'less', 'wc', 'rg', 'grep', 'find', 'fd', 'tree',
  'file', 'stat', 'which', 'pwd', 'echo', 'jq', 'du', 'df', 'sort', 'uniq', 'cut', 'diff',
]);
const READ_ONLY_GIT = new Set(['status', 'branch', 'remote', 'rev-parse', 'ls-files', 'config']);
const TEST_RUNNERS = new Set(['pytest', 'jest', 'vitest', 'mocha', 'phpunit', 'rspec']);
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const DEBUG_PROGRAMS = new Set(['lsof', 'gdb', 'lldb', 'strace', 'dmesg', 'curl', 'wget', 'nc', 'ping']);

/** Split a shell command into its simple commands, each as words without leading env assignments or npx/sudo. */
function commandSegments(command: string): string[][] {
  return command
    .split(/&&|\|\||;|\||\n/)
    .map((segment) => segment.trim().split(/\s+/).filter(Boolean))
    .map((words) => {
      while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
      if (['npx', 'sudo', 'exec', 'time'].includes(words[0])) words.shift();
      return words;
    })
    .filter((words) => words.length > 0);
}

function programName(words: string[]): string {
  return words[0].split('/').pop() ?? words[0];
}

function runsPackageScript(words: string[], script: string): boolean {
  if (!PACKAGE_MANAGERS.has(programName(words))) return false;
  const scriptName = words[1] === 'run' ? words[2] : words[1];
  return scriptName !== undefined && scriptName.startsWith(script);
}

function isTestRun(words: string[]): boolean {
  const program = programName(words);
  return TEST_RUNNERS.has(program)
    || runsPackageScript(words, 'test')
    || (['cargo', 'go'].includes(program) && words[1] === 'test')
    || (['mvn', 'gradle', 'gradlew'].includes(program) && words.includes('test'))
    || (['node', 'tsx'].includes(program) && words.includes('--test'))
    || (program === 'playwright' && words[1] === 'test');
}

function isDeployStep(words: string[]): boolean {
  const program = programName(words);
  return (program === 'git' && ['commit', 'push'].includes(words[1]))
    || (program === 'docker' && words[1] === 'push')
    || (program === 'kubectl' && words[1] === 'apply')
    || (program === 'terraform' && words[1] === 'apply')
    || runsPackageScript(words, 'deploy')
    || /^deploy(\.sh)?$/.test(program);
}

function isReviewStep(words: string[]): boolean {
  const program = programName(words);
  return (program === 'git' && ['diff', 'log', 'show', 'blame'].includes(words[1]))
    || (program === 'gh' && words[1] === 'pr' && ['view', 'review', 'diff', 'checks'].includes(words[2]));
}

function isDebugStep(words: string[]): boolean {
  const program = programName(words);
  return DEBUG_PROGRAMS.has(program) || (program === 'node' && words.some((w) => w.startsWith('--inspect')));
}

function isReadOnlyStep(words: string[]): boolean {
  const program = programName(words);
  return READ_ONLY_PROGRAMS.has(program) || (program === 'git' && READ_ONLY_GIT.has(words[1]));
}

// Classify a shell command by the programs it runs, not by words in its arguments
function inferBashActivity(command: string): string {
  const segments = commandSegments(command);
  if (segments.some(isTestRun)) return 'testing';
  if (segments.some(isDeployStep)) return 'deploying';
  if (segments.some(isReviewStep)) return 'reviewing';
  if (segments.some(isDebugStep)) return 'debugging';
  if (segments.length > 0 && segments.every(isReadOnlyStep)) return 'researching';
  return 'implementing';
}

const CHUNK_SIZE = 50_000;
const MAX_READ = 4_000_000;
const NEWLINE = 0x0a;

/**
 * Yield complete transcript lines, newest first. A line that crosses a chunk
 * edge, or is longer than one chunk, is joined before it is yielded.
 */
function* completeLinesFromEnd(fd: number, size: number): Generator<string> {
  let position = size;
  let pending = Buffer.alloc(0);

  while (position > 0 && size - position < MAX_READ) {
    const readSize = Math.min(CHUNK_SIZE, position);
    position -= readSize;
    const chunk = Buffer.alloc(readSize);
    fs.readSync(fd, chunk, 0, readSize, position);

    const buffer = Buffer.concat([chunk, pending]);
    let lineEnd = buffer.length;
    for (let i = buffer.length - 1; i >= 0; i--) {
      if (buffer[i] !== NEWLINE) continue;
      const line = buffer.subarray(i + 1, lineEnd).toString('utf-8').trim();
      if (line) yield line;
      lineEnd = i;
    }
    pending = buffer.subarray(0, lineEnd);
  }

  if (position === 0) {
    const firstLine = pending.toString('utf-8').trim();
    if (firstLine) yield firstLine;
  }
}

/**
 * Infer activity from a transcript JSONL file by scanning recent tool_use calls.
 */
function inferActivityFromFile(transcriptPath: string): string {
  if (!fs.existsSync(transcriptPath)) return 'implementing';

  let fd: number | undefined;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    const size = fs.fstatSync(fd).size;
    let foundAssistantResponse = false;

    for (const line of completeLinesFromEnd(fd, size)) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }

      const message = entry.message;
      if (!message || message.role !== 'assistant') continue;
      const content = message.content;
      if (!Array.isArray(content)) continue;

      if (!foundAssistantResponse) {
        foundAssistantResponse = true;
        const hasToolUse = content.some((b: { type: string }) => b.type === 'tool_use');
        const hasText = content.some((b: { type: string }) => b.type === 'text');
        if (hasText && !hasToolUse) return 'idle';
      }

      for (const block of content) {
        if (block.type === 'tool_use' && block.name) {
          return inferActivityFromTool(block.name, block.input);
        }
      }
    }

    return 'idle';
  } catch {
    return 'implementing';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

const PENDING_TOOL_CALL_LIMIT = 10 * 60_000;

/** True when the newest message in a transcript is a tool call that has no result yet. */
function endsWithPendingToolCall(transcriptPath: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    for (const line of completeLinesFromEnd(fd, fs.fstatSync(fd).size)) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      const message = entry.message;
      if (!message) continue;
      return message.role === 'assistant'
        && Array.isArray(message.content)
        && message.content.some((block: { type: string }) => block.type === 'tool_use');
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

const PLAIN_SESSION_ID = /^[A-Za-z0-9_-]+$/;

function isPlainSessionId(sessionId: string): boolean {
  return PLAIN_SESSION_ID.test(sessionId);
}

/**
 * Claude Code names a project folder after its cwd with every character that is
 * not a letter or digit replaced by "-". Older versions kept the dot.
 */
function projectDirFor(cwd: string): string {
  const current = path.join(PROJECTS_DIR, cwd.replace(/[^A-Za-z0-9]/g, '-'));
  const legacy = path.join(PROJECTS_DIR, cwd.replace(/\//g, '-'));
  return !fs.existsSync(current) && fs.existsSync(legacy) ? legacy : current;
}

/**
 * Infer activity from the session's own transcript. Sessions that share a
 * folder share a project directory, so the newest file there may belong to
 * another session.
 */
function inferSessionActivity(cwd: string, sessionId: string): string {
  if (!isPlainSessionId(sessionId)) return 'idle';
  const transcriptPath = path.join(projectDirFor(cwd), `${sessionId}.jsonl`);
  if (!fs.existsSync(transcriptPath)) return 'idle';
  return inferActivityFromFile(transcriptPath);
}

/**
 * Detect active subagents started by one session.
 * A subagent is "active" if its transcript was modified within the last 30 seconds.
 */
function detectSubagents(cwd: string, parentId: string, parentPid: number): DetectedAgent[] {
  if (!isPlainSessionId(parentId)) return [];
  const subagentsDir = path.join(projectDirFor(cwd), parentId, 'subagents');
  if (!fs.existsSync(subagentsDir)) return [];

  const subagents: DetectedAgent[] = [];
  const now = Date.now();
  const ACTIVE_THRESHOLD = 30_000; // 30 seconds

  const metaFiles = fs.readdirSync(subagentsDir).filter((f) => f.endsWith('.meta.json'));

  for (const metaFile of metaFiles) {
    try {
      const agentId = metaFile.replace('.meta.json', '');
      const transcriptPath = path.join(subagentsDir, `${agentId}.jsonl`);

      // Check if transcript exists and was recently modified
      if (!fs.existsSync(transcriptPath)) continue;
      const transcriptStat = fs.statSync(transcriptPath);
      const quietFor = now - transcriptStat.mtimeMs;
      const inLongToolCall = quietFor <= PENDING_TOOL_CALL_LIMIT && endsWithPendingToolCall(transcriptPath);
      if (quietFor > ACTIVE_THRESHOLD && !inLongToolCall) continue;

      // Read meta
      const meta = JSON.parse(fs.readFileSync(path.join(subagentsDir, metaFile), 'utf-8'));
      const description = meta.description || meta.agentType || 'subagent';

      const activity = inferActivityFromFile(transcriptPath);

      subagents.push({
        id: agentId,
        name: `${description}`,
        pid: parentPid,
        cwd,
        startedAt: transcriptStat.birthtimeMs,
        alive: true,
        activity,
        parentId,
      });
    } catch {
      // skip malformed subagent files
    }
  }

  return subagents;
}

/**
 * Combine the status that Claude Code writes in the session file with the
 * transcript activity. The status knows when a session waits for the user or
 * thinks; the transcript knows what kind of work it does. Without a known
 * status, the transcript decides alone.
 */
function combineWithSessionStatus(status: unknown, transcriptActivity: string): string {
  switch (status) {
    case 'waiting': return 'meeting';
    case 'idle': return 'idle';
    case 'busy': return transcriptActivity === 'idle' ? 'planning' : transcriptActivity;
    default: return transcriptActivity;
  }
}

export function detectAgents(): DetectedAgent[] {
  if (!fs.existsSync(SESSIONS_DIR)) return [];

  const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
  const agents: DetectedAgent[] = [];

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf-8');
      const session: unknown = JSON.parse(content);
      if (!isSessionFile(session)) continue;

      const alive = isPidAlive(session.pid);
      if (!alive) continue;

      const activity = combineWithSessionStatus(
        (session as SessionFile & { status?: unknown }).status,
        inferSessionActivity(session.cwd, session.sessionId),
      );
      const name = path.basename(session.cwd);

      const { status, statusUpdatedAt } = session as SessionFile & { status?: unknown; statusUpdatedAt?: unknown };
      agents.push({
        id: session.sessionId,
        name,
        pid: session.pid,
        cwd: session.cwd,
        startedAt: session.startedAt,
        alive,
        activity,
        ...(typeof status === 'string' ? { status } : {}),
        ...(typeof statusUpdatedAt === 'number' && Number.isFinite(statusUpdatedAt) ? { statusSince: statusUpdatedAt } : {}),
      });

      // Detect active subagents
      const subs = detectSubagents(session.cwd, session.sessionId, session.pid);
      agents.push(...subs);
    } catch {
      // skip malformed session files
    }
  }

  return agents;
}
