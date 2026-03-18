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
  parentId?: string;
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

    default:
      return 'implementing';
  }
}

// Bash command patterns to refine activity
function inferBashActivity(bashInput: string): string {
  const lower = bashInput.toLowerCase();
  if (/\b(test|spec|jest|vitest|pytest|cargo\s+test|go\s+test|npm\s+test|pnpm\s+test)\b/.test(lower)) return 'testing';
  if (/\b(git\s+(commit|push)|deploy|docker\s+push|kubectl\s+apply|terraform\s+apply)\b/.test(lower)) return 'deploying';
  if (/\b(gh\s+pr\s+(view|review|diff|checks)|git\s+(diff|log|blame|show))\b/.test(lower)) return 'reviewing';
  if (/\b(node\s+--inspect|strace|lldb|gdb|lsof|dmesg)\b/.test(lower)) return 'debugging';
  if (/\b(npm\s+run\s+build|pnpm\s+build|cargo\s+build|make)\b/.test(lower)) return 'implementing';
  if (/\b(curl|wget|nc|ping)\b/.test(lower)) return 'debugging';
  return 'implementing';
}

/**
 * Infer activity from a transcript JSONL file by scanning recent tool_use calls.
 */
function inferActivityFromFile(transcriptPath: string): string {
  if (!fs.existsSync(transcriptPath)) return 'implementing';

  try {
    const stat = fs.statSync(transcriptPath);
    const fd = fs.openSync(transcriptPath, 'r');

    const CHUNK_SIZE = 50_000;
    const MAX_READ = 500_000;
    let foundAssistantResponse = false;

    for (let offset = 0; offset < Math.min(stat.size, MAX_READ); offset += CHUNK_SIZE) {
      const readSize = Math.min(CHUNK_SIZE, stat.size - offset);
      const startPos = Math.max(0, stat.size - offset - readSize);
      const buffer = Buffer.alloc(readSize);
      fs.readSync(fd, buffer, 0, readSize, startPos);

      const chunk = buffer.toString('utf-8');
      const lines = chunk.split('\n');

      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;

        let entry;
        try { entry = JSON.parse(line); } catch { continue; }

        const message = entry.message;
        if (!message) continue;

        if (message.role === 'assistant' && !foundAssistantResponse) {
          foundAssistantResponse = true;
          const content = message.content;
          if (!Array.isArray(content)) continue;

          const hasToolUse = content.some((b: { type: string }) => b.type === 'tool_use');
          const hasText = content.some((b: { type: string }) => b.type === 'text');

          if (hasText && !hasToolUse) {
            fs.closeSync(fd);
            return 'idle';
          }
        }

        if (message.role !== 'assistant') continue;
        const content = message.content;
        if (!Array.isArray(content)) continue;

        for (const block of content) {
          if (block.type === 'tool_use' && block.name) {
            fs.closeSync(fd);
            return inferActivityFromTool(block.name, block.input);
          }
        }
      }
    }

    fs.closeSync(fd);
    return 'idle';
  } catch {
    return 'implementing';
  }
}

/**
 * Find the most recent transcript for a project and infer activity.
 */
function inferActivityFromTranscript(cwd: string): string {
  const encodedCwd = cwd.replace(/\//g, '-');
  const projectDir = path.join(PROJECTS_DIR, encodedCwd);

  if (!fs.existsSync(projectDir)) return 'implementing';

  const jsonlFiles = fs.readdirSync(projectDir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ name: f, mtime: fs.statSync(path.join(projectDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  if (jsonlFiles.length === 0) return 'implementing';
  return inferActivityFromFile(path.join(projectDir, jsonlFiles[0].name));
}

/**
 * Detect active subagents for a given project.
 * A subagent is "active" if its transcript was modified within the last 30 seconds.
 */
function detectSubagents(cwd: string, parentId: string, parentPid: number): DetectedAgent[] {
  const encodedCwd = cwd.replace(/\//g, '-');
  const projectDir = path.join(PROJECTS_DIR, encodedCwd);

  if (!fs.existsSync(projectDir)) return [];

  const subagents: DetectedAgent[] = [];
  const now = Date.now();
  const ACTIVE_THRESHOLD = 30_000; // 30 seconds

  // Scan all session dirs for subagents
  const sessionDirs = fs.readdirSync(projectDir, { withFileTypes: true })
    .filter((d) => d.isDirectory());

  for (const sessionDir of sessionDirs) {
    const subagentsDir = path.join(projectDir, sessionDir.name, 'subagents');
    if (!fs.existsSync(subagentsDir)) continue;

    const metaFiles = fs.readdirSync(subagentsDir).filter((f) => f.endsWith('.meta.json'));

    for (const metaFile of metaFiles) {
      try {
        const agentId = metaFile.replace('.meta.json', '');
        const transcriptPath = path.join(subagentsDir, `${agentId}.jsonl`);

        // Check if transcript exists and was recently modified
        if (!fs.existsSync(transcriptPath)) continue;
        const transcriptStat = fs.statSync(transcriptPath);
        if (now - transcriptStat.mtimeMs > ACTIVE_THRESHOLD) continue;

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
  }

  return subagents;
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

      const activity = inferActivityFromTranscript(session.cwd);
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

      // Detect active subagents
      const subs = detectSubagents(session.cwd, session.sessionId, session.pid);
      agents.push(...subs);
    } catch {
      // skip malformed session files
    }
  }

  return agents;
}
