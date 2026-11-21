import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { SESSION_PERSONAS, type SessionStoryInput } from '../../server/seam.js';

/**
 * Tombstone story reader (issue #160). Resolves a mission journey entry's session slug to its
 * archived `sessions/archive[/done|/abandoned]/<slug>/intent-tree.md` (written once at session
 * close, per `sessions/schema.yaml`'s `intent_tree_format`) under the same roots
 * `AGENTS_OFFICE_MISSION_ROOTS` already names for mission records. Never reads the live ledger,
 * a transcript, a prompt or a tool call: only this one static file, and only the display fields
 * `server/seam.ts`'s `projectStory` goes on to whitelist and cap. A missing or oversized record
 * reads as no story (S6); the card then says so plainly rather than guessing.
 */

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_RECORD_BYTES = 200_000;
const STORY_CACHE_MS = 30_000;
const MAX_DONE_ITEMS = 12;
const MAX_HANDOFFS = 10;
const MAX_ISSUES = 15;
const ARCHIVE_SUBDIRS = ['', 'done', 'abandoned'];

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : [];
}

// A box-drawing run (the tree's connectors) or plain whitespace, stripped from a line's start
// so `◉`-marked lines are found regardless of their nesting depth in the Intent Tree.
const LEADING_TREE_CHARS = /^[\s│├└┌┐┘─╰╭]+/;

/** One line of display text per `◉`-marked tree node (done or branch-complete), nesting dropped. */
export function extractDoneList(body: string): string[] {
  const items: string[] = [];
  for (const raw of body.split('\n')) {
    const stripped = raw.replace(LEADING_TREE_CHARS, '');
    if (!stripped.startsWith('◉')) continue;
    const item = stripped.slice('◉'.length).trim();
    if (item) items.push(item);
  }
  return items.slice(0, MAX_DONE_ITEMS);
}

/** Every known BMAD persona name (`SESSION_PERSONAS`, the closed set) mentioned anywhere in the body. */
export function extractPersonas(body: string): string[] {
  return SESSION_PERSONAS.filter((name) => new RegExp(`\\b${name}\\b`).test(body));
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

/** Parse one `intent-tree.md` file's contents. `null` when it is not a valid record (S6). */
export function parseIntentTree(raw: string): SessionStoryInput | null {
  const match = FRONTMATTER.exec(raw);
  if (!match) return null;
  let front: unknown;
  try {
    front = parse(match[1]);
  } catch {
    return null;
  }
  if (typeof front !== 'object' || front === null) return null;
  const record = front as Record<string, unknown>;
  const intent = text(record.intent);
  if (!intent) return null;
  const body = match[2] ?? '';
  const rawCounts = record.node_counts;
  const counts = rawCounts && typeof rawCounts === 'object'
    ? {
        done: Number((rawCounts as Record<string, unknown>).done) || 0,
        open: Number((rawCounts as Record<string, unknown>).open) || 0,
        abandoned: Number((rawCounts as Record<string, unknown>).abandoned) || 0,
      }
    : undefined;
  return {
    intent,
    personas: extractPersonas(body),
    ...(counts ? { counts } : {}),
    doneList: extractDoneList(body),
    handoffs: stringList(record.handoffs_generated).slice(0, MAX_HANDOFFS),
    issues: stringList(record.gh_issues_referenced).slice(0, MAX_ISSUES),
  };
}

/** The archived record's path for a slug, or undefined: not a slug, not found, or too large. */
export function findStoryFile(roots: string[], slug: string): string | undefined {
  if (!SLUG.test(slug)) return undefined;
  for (const root of roots) {
    for (const sub of ARCHIVE_SUBDIRS) {
      const file = path.join(root, 'sessions', 'archive', sub, slug, 'intent-tree.md');
      try {
        const stat = fs.lstatSync(file);
        if (stat.isFile() && stat.size <= MAX_RECORD_BYTES) return file;
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

const cache = new Map<string, { at: number; story: SessionStoryInput | null }>();

/** Tests only: forget every cached read. */
export function resetSessionStoryCache(): void {
  cache.clear();
}

/** A session's story, or null when no archived record exists or it does not parse. Cached per slug. */
export function readSessionStory(roots: string[], slug: string, now: () => number = Date.now): SessionStoryInput | null {
  const key = `${roots.join('|')}::${slug}`;
  const cached = cache.get(key);
  if (cached && now() - cached.at < STORY_CACHE_MS) return cached.story;
  const file = findStoryFile(roots, slug);
  let story: SessionStoryInput | null = null;
  if (file) {
    try {
      story = parseIntentTree(fs.readFileSync(file, 'utf-8'));
    } catch {
      story = null;
    }
  }
  cache.set(key, { at: now(), story });
  return story;
}
