import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isRepoName } from './gh.js';

/**
 * Issues an agent works on, from its own tool calls only (never from prompt text):
 * `gh issue view|comment|edit N`, a git branch that starts with `N-`, and `#N` or
 * `owner/repo#N` in a commit message.
 */

export interface IssueRef { number: number; repo?: string }

const MAX_TAIL = 2_000_000;
const MAX_COMMAND = 20_000;
const MAX_REFS = 5;
const MAX_CACHED_FILES = 200;
const MAX_ISSUE_NUMBER = 10_000_000;

const GH_ISSUE = /\bgh\s+issue\s+(?:view|comment|edit)\b([^\n;&|]*)/g;
const ISSUE_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/(\d+)\b/;
const REPO_FLAG = /(?:^|\s)(?:-R|--repo)(?:\s+|=)["']?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/;
const BRANCH = /(?:\s-[bB]|\bswitch\s+(?:-[cC]|--create))\s+["']?(\d+)-[A-Za-z0-9]/;
const COMMIT = /(?:^|[\s;&|(])git\b[^\n]*?\scommit\b/;
const COMMIT_REF = /(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#(\d+)\b/g;

function issueNumber(text: string): number | undefined {
  const value = Number(text);
  return Number.isInteger(value) && value > 0 && value <= MAX_ISSUE_NUMBER ? value : undefined;
}

function ref(numberText: string, repo: string | undefined): IssueRef | undefined {
  const number = issueNumber(numberText);
  if (number === undefined) return undefined;
  return repo && isRepoName(repo) ? { number, repo } : { number };
}

interface Hit { at: number; ref: IssueRef }

function ghIssueHits(command: string): Hit[] {
  const hits: Hit[] = [];
  for (const match of command.matchAll(GH_ISSUE)) {
    const args = match[1];
    const repo = REPO_FLAG.exec(args)?.[1];
    for (const token of args.trim().split(/\s+/)) {
      const bare = token.replace(/^["']|["']$/g, '');
      const url = ISSUE_URL.exec(bare);
      const found = url ? ref(url[2], url[1]) : /^#?\d+$/.test(bare) ? ref(bare.replace('#', ''), repo) : undefined;
      if (found) {
        hits.push({ at: match.index ?? 0, ref: found });
        break;
      }
    }
  }
  return hits;
}

function branchHits(command: string): Hit[] {
  const hits: Hit[] = [];
  let offset = 0;
  for (const segment of command.split(/(&&|\|\||;|\||\n)/)) {
    if (/^\s*git\s/.test(segment)) {
      const match = BRANCH.exec(segment);
      const found = match ? ref(match[1], undefined) : undefined;
      if (found) hits.push({ at: offset + (match!.index ?? 0), ref: found });
    }
    offset += segment.length;
  }
  return hits;
}

function commitHits(command: string): Hit[] {
  const commit = COMMIT.exec(command);
  if (!commit) return [];
  const start = commit.index + commit[0].length;
  const hits: Hit[] = [];
  for (const match of command.slice(start).matchAll(COMMIT_REF)) {
    const found = ref(match[2], match[1]);
    if (found) hits.push({ at: start + (match.index ?? 0), ref: found });
  }
  return hits;
}

/** Issue references in one Bash command, in the order they appear. */
export function issueRefsFromCommand(command: string): IssueRef[] {
  const text = command.slice(0, MAX_COMMAND);
  return [...ghIssueHits(text), ...branchHits(text), ...commitHits(text)]
    .sort((a, b) => a.at - b.at)
    .map((hit) => hit.ref);
}

function bashCommands(line: string): string[] {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return [];
  }
  const message = (entry as { message?: { role?: unknown; content?: unknown } } | null)?.message;
  if (message?.role !== 'assistant' || !Array.isArray(message.content)) return [];
  return message.content
    .filter((block): block is { type: string; name: string; input: { command: string } } =>
      block?.type === 'tool_use' && block.name === 'Bash' && typeof block.input?.command === 'string')
    .map((block) => block.input.command);
}

/** Up to 5 distinct issues, most recent first, from the tool calls in a transcript text. */
export function issueRefsFromTranscript(text: string): IssueRef[] {
  const all = text.split('\n').flatMap(bashCommands).flatMap(issueRefsFromCommand);
  const seen = new Set<number>();
  const recent: IssueRef[] = [];
  for (let i = all.length - 1; i >= 0 && recent.length < MAX_REFS; i--) {
    if (seen.has(all[i].number)) continue;
    seen.add(all[i].number);
    recent.push(all[i]);
  }
  return recent;
}

function isTranscriptPath(file: string): boolean {
  const projects = path.join(os.homedir(), '.claude', 'projects') + path.sep;
  const resolved = path.resolve(file);
  return resolved === file && resolved.startsWith(projects) && resolved.endsWith('.jsonl');
}

function readTail(file: string, size: number): string {
  const fd = fs.openSync(file, 'r');
  try {
    const length = Math.min(size, MAX_TAIL);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    const text = buffer.toString('utf8');
    // A cut first line is not valid JSON; drop it.
    return length < size ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    fs.closeSync(fd);
  }
}

interface CacheEntry { size: number; mtimeMs: number; refs: IssueRef[] }

/** Reads transcripts under ~/.claude/projects, with a cache keyed by size and modification time. */
export class TranscriptIssues {
  private cache = new Map<string, CacheEntry>();

  refs(file: string): IssueRef[] {
    if (!isTranscriptPath(file)) return [];
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(file);
    } catch {
      return [];
    }
    if (!stat.isFile()) return [];
    const cached = this.cache.get(file);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.refs;
    let refs: IssueRef[];
    try {
      refs = issueRefsFromTranscript(readTail(file, stat.size));
    } catch {
      return [];
    }
    if (this.cache.size >= MAX_CACHED_FILES) this.cache.clear();
    this.cache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, refs });
    return refs;
  }
}
