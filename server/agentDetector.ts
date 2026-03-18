import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import os from 'node:os';

export interface DetectedAgent {
  id: string;
  name: string;
  pid: number;
  cwd: string;
  startedAt: number;
  alive: boolean;
  activity: string;
  lastCommand?: string;
}

interface SessionFile {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
}

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

function isPidAlive(pid: number): boolean {
  try {
    execSync(`kill -0 ${pid}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Tool names → activity mapping (language-agnostic, based on what Claude is actually doing)
const TOOL_ACTIVITY_MAP: Record<string, string> = {
  // Reading/exploring code
  Read: 'researching',
  Grep: 'researching',
  Glob: 'researching',
  Agent: 'researching',
  WebSearch: 'researching',
  WebFetch: 'researching',

  // Writing code
  Edit: 'implementing',
  Write: 'implementing',
  NotebookEdit: 'implementing',

  // Running commands (refined by command content)
  Bash: 'implementing',

  // Planning
  EnterPlanMode: 'planning',
  ExitPlanMode: 'planning',
  TaskCreate: 'planning',
  TaskUpdate: 'planning',
};

// Bash command patterns to refine activity
function inferBashActivity(bashInput: string): string {
  const lower = bashInput.toLowerCase();
  if (/\b(test|spec|jest|vitest|pytest|cargo\s+test|go\s+test|npm\s+test|pnpm\s+test)\b/.test(lower)) return 'testing';
  if (/\b(git\s+(commit|push)|deploy|docker\s+push)\b/.test(lower)) return 'deploying';
  if (/\b(git\s+(diff|log|blame|show))\b/.test(lower)) return 'reviewing';
  if (/\b(npm\s+run\s+build|pnpm\s+build|cargo\s+build|make)\b/.test(lower)) return 'implementing';
  if (/\b(curl|wget|nc|ping)\b/.test(lower)) return 'debugging';
  return 'implementing';
}

/**
 * Reads the last N lines of a transcript JSONL to find recent tool_use calls.
 * Returns the inferred activity based on what tools the agent is actually using.
 */
function inferActivityFromTranscript(cwd: string, sessionId: string): string {
  // Find the transcript file: ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
  const encodedCwd = cwd.replace(/\//g, '-');
  const transcriptPath = path.join(PROJECTS_DIR, encodedCwd, `${sessionId}.jsonl`);

  if (!fs.existsSync(transcriptPath)) return 'implementing';

  try {
    // Read last ~20KB to find recent tool calls without reading the whole file
    const stat = fs.statSync(transcriptPath);
    const readSize = Math.min(stat.size, 20_000);
    const fd = fs.openSync(transcriptPath, 'r');
    const buffer = Buffer.alloc(readSize);
    fs.readSync(fd, buffer, 0, readSize, Math.max(0, stat.size - readSize));
    fs.closeSync(fd);

    const tail = buffer.toString('utf-8');
    const lines = tail.split('\n');

    // Scan backwards to find: is the agent idle (waiting for input) or actively working?
    // If the last assistant message has no tool_use, the agent finished and is waiting → idle
    let foundAssistantResponse = false;
    const recentTools: string[] = [];

    for (let i = lines.length - 1; i >= 0 && recentTools.length < 5; i--) {
      const line = lines[i].trim();
      if (!line) continue;

      try {
        const entry = JSON.parse(line);
        const message = entry.message;
        if (!message) continue;

        // If the most recent assistant message has only text (no tool_use), agent is idle
        if (message.role === 'assistant' && !foundAssistantResponse) {
          foundAssistantResponse = true;
          const content = message.content;
          if (!Array.isArray(content)) continue;

          const hasToolUse = content.some((b: { type: string }) => b.type === 'tool_use');
          const hasText = content.some((b: { type: string }) => b.type === 'text');

          if (hasText && !hasToolUse) {
            // Agent responded with text only → finished, waiting for user input
            return 'idle';
          }
        }

        if (message.role !== 'assistant') continue;

        const content = message.content;
        if (!Array.isArray(content)) continue;

        for (const block of content) {
          if (block.type === 'tool_use' && block.name) {
            if (block.name === 'Bash' && block.input?.command) {
              recentTools.push(`Bash:${block.input.command}`);
            } else {
              recentTools.push(block.name);
            }
          }
        }
      } catch {
        // skip malformed lines
      }
    }

    if (recentTools.length === 0) return 'idle';

    // Use the most recent tool to determine activity
    const latest = recentTools[0];

    if (latest.startsWith('Bash:')) {
      return inferBashActivity(latest.slice(5));
    }

    return TOOL_ACTIVITY_MAP[latest] ?? 'implementing';
  } catch {
    return 'implementing';
  }
}

export function detectAgents(): DetectedAgent[] {
  if (!fs.existsSync(SESSIONS_DIR)) return [];

  const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
  const agents: DetectedAgent[] = [];

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf-8');
      const session: SessionFile = JSON.parse(content);

      const alive = isPidAlive(session.pid);
      if (!alive) continue;

      const activity = inferActivityFromTranscript(session.cwd, session.sessionId);
      const name = path.basename(session.cwd);

      agents.push({
        id: session.sessionId,
        name,
        pid: session.pid,
        cwd: session.cwd,
        startedAt: session.startedAt,
        alive,
        activity,
      });
    } catch {
      // skip malformed session files
    }
  }

  return agents;
}
