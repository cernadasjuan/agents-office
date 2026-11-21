import fs from 'node:fs';
import path from 'node:path';

/**
 * Reads a floor's own documentation library (issue #191 AC1, #119): Gabriel's round 5
 * decision is "a project-management folder is a floor; each project-management floor has a
 * library = its documentation folder". This module reads exactly one relative path,
 * `documentation/bibliotheque/INDEX.md`, under a repo root. A repo without that structure
 * (today: every floor except Klever's `project-management`) gets no library at all — this is
 * the graceful-degradation rule, not a folder-structure adapter: the code does not walk a repo
 * looking for "a" documentation folder under any other name or location. Other floors
 * (harness, personal) are expected to grow their own matching structure later, at which point
 * they pick this same path up for free; nothing here needs to change for that.
 */
export const BIBLIOTHEQUE_RELATIVE = 'documentation/bibliotheque';

const MAX_INDEX_BYTES = 200_000;
// Gabriel's own call (round 7 part 3): "there's no max sections and max... I wanted to be able
// to navigate and plus a possibility of an infinite one... you can have like a big cap here".
// 100 of each, up from 8/6 — a cap at the data layer, not the room's own physical display limit
// (`plugins/floor-library/client.ts`'s `MAX_SECTIONS_SHOWN`/`MAX_ENTRY_LINES`, a separate,
// much smaller number: one shared library room cannot seat 100 shelves at once; see that
// module's own doc comment). 100 rows of a section table run well under MAX_INDEX_BYTES
// (a real row is well under 200 bytes; 100 of them is ~20 KB against a 200 KB cap), and the
// top INDEX.md needs only one link line per section to list 100 of them, so the existing byte
// cap needs no change to carry the new row cap.
const MAX_SECTIONS = 100;
const MAX_ENTRIES = 100;
const SEGMENT = /^[A-Za-z0-9_.-]+$/;

export interface LibraryEntry {
  title: string;
  archived: boolean;
  /** The row's own description column (issue #221 AC2), trimmed. Already parsed and
   * discarded before this PR; surfacing it costs nothing new to read. */
  summary?: string;
  /** The link target's own last-modified date (`YYYY-MM-DD`), when it resolved to a real file
   * inside the bibliothèque tree. Absent for an external link, a missing file, or one a
   * symlink would have to escape the tree to reach — never fabricated. */
  lastChanged?: string;
  /** The link target's path relative to the repo root (never the bibliothèque subtree alone),
   * for building a GitHub blob URL one layer up (`plugins/floor-library/index.ts`). Never sent
   * to the browser itself (`server/seam.ts` builds the URL from it and drops the path);
   * absent under the same conditions as `lastChanged`. */
  repoPath?: string;
}

export interface LibrarySection {
  name: string;
  entries: LibraryEntry[];
  truncated: boolean;
}

export interface Bibliotheque {
  sections: LibrarySection[];
}

/** True when `real` is `root` itself or genuinely inside it (never a `..`-escaped sibling).
 * Duplicated from `plugins/missions/sessionStoryReader.ts`'s own `withinRoot` — the same small
 * boundary check, not cross-imported between sibling plugins. */
function withinRoot(real: string, root: string): boolean {
  const relative = path.relative(root, real);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** `readCapped`'s own result: the readable prefix, and whether the file ran past
 * `MAX_INDEX_BYTES` so content past the cap was never read at all (review: a section whose
 * table has entries before the cap and more rows after it still fits under `MAX_ENTRIES`, so
 * `parseSectionEntries`'s own row-count `truncated` stayed false — the byte cut has to carry
 * its own truncation signal forward, not be inferred from entry count alone). */
interface CappedRead {
  text: string;
  truncated: boolean;
}

/**
 * A regular file inside `allowedRoot` once every symlink resolves, read up to `MAX_INDEX_BYTES`
 * (issue: a real top `INDEX.md` can run well past a round number once a wiki grows — reading a
 * capped prefix of it is still useful data, not the same as no library). An oversized file is
 * cut at its last full line within the cap, never a byte count that could split a link or a
 * multi-byte UTF-8 sequence mid-character: `topLevelSections`/`parseSectionEntries` only ever
 * see whole lines. Undefined on any read failure (missing, not a plain file, or a symlinked
 * section directory that resolves outside the bibliothèque root — review: checking only the
 * leaf file's own `lstat` let a symlinked *directory* earlier in the path redirect the read
 * anywhere on disk, the same escape `findStoryFile` already guards against for a session
 * record). Never throws: a malformed or escaping index is the same as no library.
 */
function readCapped(file: string, allowedRoot: string): CappedRead | undefined {
  let fd: number | undefined;
  try {
    const real = fs.realpathSync(file);
    if (!withinRoot(real, allowedRoot)) return undefined;
    const stat = fs.lstatSync(real);
    if (!stat.isFile()) return undefined;
    const readBytes = Math.min(stat.size, MAX_INDEX_BYTES);
    const buffer = Buffer.alloc(readBytes);
    fd = fs.openSync(real, 'r');
    fs.readSync(fd, buffer, 0, readBytes, 0);
    const text = buffer.toString('utf-8');
    if (stat.size <= MAX_INDEX_BYTES) return { text, truncated: false };
    const lastNewline = text.lastIndexOf('\n');
    return { text: lastNewline >= 0 ? text.slice(0, lastNewline) : '', truncated: true };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Top-level section segments the top `INDEX.md` links to as `<segment>/INDEX.md` (never a
 * deeper path: "top level sections only in this PR"), in first-seen order, deduplicated.
 * Prospero's rule (#119 comment): sections come from each section's own `INDEX.md` link, not
 * a raw folder walk of `documentation/bibliotheque/` — a section the top index does not yet
 * link gets no shelf, even if its directory exists on disk.
 */
export function topLevelSections(indexMarkdown: string): string[] {
  const seen: string[] = [];
  const linkPattern = /\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = linkPattern.exec(indexMarkdown))) {
    const target = match[1].split(/[#?]/)[0];
    const segment = /^([^/]+)\/INDEX\.md$/.exec(target)?.[1];
    if (segment && SEGMENT.test(segment) && segment !== '.' && segment !== '..' && !seen.includes(segment)) {
      seen.push(segment);
    }
  }
  return seen;
}

/** A row's own archived mark (Prospero's rule): "archived" or "superseded" anywhere in its
 * title, description or link path, case-insensitive. A later section's own convention (a
 * status column, a strikethrough) can extend this; it never needs a second folder-structure
 * rule to keep working. */
const ARCHIVED_PATTERN = /\barchiv(?:ed?)?\b|\bsuperseded\b/i;

const TABLE_ROW = /^\|\s*\[([^\]]+)\]\(([^)]+)\)\s*\|(.*)\|?\s*$/gm;

/** A row parsed straight from markdown, before `readBibliotheque` resolves its link target
 * against the filesystem: `link` is the raw table-row target, never shown to the browser
 * itself (`LibraryEntry.repoPath`/`lastChanged`, resolved and sanitized, replace it). */
interface ParsedEntry {
  title: string;
  archived: boolean;
  summary?: string;
  link: string;
}

/** Table-row entries of one section's own `INDEX.md`: `| [Title](link) | Description |`.
 * A row whose first column is not a markdown link (a header, a separator, a prose line)
 * contributes nothing. Capped at `MAX_ENTRIES`; `truncated` says whether more existed. */
export function parseSectionEntries(sectionIndexMarkdown: string): { entries: ParsedEntry[]; truncated: boolean } {
  const rows: ParsedEntry[] = [];
  let match: RegExpExecArray | null;
  TABLE_ROW.lastIndex = 0;
  while ((match = TABLE_ROW.exec(sectionIndexMarkdown))) {
    const [, title, link, description] = match;
    const archived = ARCHIVED_PATTERN.test(`${title} ${description} ${link}`);
    // `TABLE_ROW`'s own `description` group (`(.*)\|?\s*$`, kept exactly as-is since `title`'s
    // own match depends on the same expression) is greedy: for a normal `| Title | Description |`
    // row it keeps the real trailing `|` inside the match rather than backtrack onto the
    // optional one after it. Never surfaced before this PR (the group was parsed and
    // discarded); stripped here, once, same as the `**` bold markers title already loses.
    const summary = description.replace(/\*\*/g, '').replace(/\|\s*$/, '').trim();
    rows.push({ title: title.replace(/\*\*/g, '').trim(), archived, ...(summary ? { summary } : {}), link });
  }
  return { entries: rows.slice(0, MAX_ENTRIES), truncated: rows.length > MAX_ENTRIES };
}

/** A link target with its own URI scheme (`https:`, `mailto:`, ...): never a local file, so
 * never worth a filesystem lookup. */
const EXTERNAL_LINK = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * An entry's own `lastChanged`/`repoPath`, resolved from its row's raw link against the
 * section's own directory (the same base a relative markdown link already resolves against).
 * `{}` for an external link, an absolute path, a missing file, a non-file, or a target a
 * symlink would have to escape `realBase` (the bibliothèque tree) to reach, or `realRoot` (the
 * repo root) to express as a relative path — never a guess, never a path sent further than
 * this module (the caller drops `link` and keeps only these two sanitized fields).
 */
function resolveEntryTarget(sectionDir: string, link: string, realBase: string, realRoot: string): Pick<LibraryEntry, 'lastChanged' | 'repoPath'> {
  const target = link.split(/[#?]/)[0].trim();
  if (!target || EXTERNAL_LINK.test(target) || path.isAbsolute(target)) return {};
  try {
    const real = fs.realpathSync(path.join(sectionDir, target));
    if (!withinRoot(real, realBase)) return {};
    const stat = fs.lstatSync(real);
    if (!stat.isFile()) return {};
    const repoPath = path.relative(realRoot, real).split(path.sep).join('/');
    if (repoPath === '' || repoPath.startsWith('..') || path.isAbsolute(repoPath)) return {};
    return { lastChanged: stat.mtime.toISOString().slice(0, 10), repoPath };
  } catch {
    return {};
  }
}

/**
 * A repo root's own library, or undefined when it has no `documentation/bibliotheque/INDEX.md`
 * (graceful degradation: no data, old behavior — here, no library room content at all). A
 * section whose own `INDEX.md` is missing, or carries no table-row entries (within the capped
 * prefix `readCapped` reads for an oversized one), is dropped rather than shown empty.
 */
export function readBibliotheque(root: string): Bibliotheque | undefined {
  const base = path.join(root, BIBLIOTHEQUE_RELATIVE);
  let realBase: string;
  let realRoot: string;
  try {
    realBase = fs.realpathSync(base);
    realRoot = fs.realpathSync(root);
  } catch {
    return undefined;
  }
  const topRead = readCapped(path.join(base, 'INDEX.md'), realBase);
  if (topRead === undefined) return undefined;
  const sections: LibrarySection[] = [];
  for (const segment of topLevelSections(topRead.text).slice(0, MAX_SECTIONS)) {
    const sectionDir = path.join(base, segment);
    const sectionRead = readCapped(path.join(sectionDir, 'INDEX.md'), realBase);
    if (sectionRead === undefined) continue;
    const { entries: parsed, truncated } = parseSectionEntries(sectionRead.text);
    if (parsed.length === 0) continue;
    const entries: LibraryEntry[] = parsed.map(({ title, archived, summary, link }) => ({
      title,
      archived,
      ...(summary ? { summary } : {}),
      ...resolveEntryTarget(sectionDir, link, realBase, realRoot),
    }));
    sections.push({ name: segment, entries, truncated: truncated || sectionRead.truncated });
  }
  return { sections };
}
