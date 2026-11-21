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
const MAX_SECTIONS = 8;
const MAX_ENTRIES = 6;
const SEGMENT = /^[A-Za-z0-9_.-]+$/;

export interface LibraryEntry {
  title: string;
  archived: boolean;
}

export interface LibrarySection {
  name: string;
  entries: LibraryEntry[];
  truncated: boolean;
}

export interface Bibliotheque {
  sections: LibrarySection[];
}

/** A regular file under the byte cap, or undefined on any read failure (missing, too big, not
 * a plain file). Never throws: a malformed or oversized index is the same as no library. */
function readCapped(file: string): string | undefined {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_INDEX_BYTES) return undefined;
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return undefined;
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

/** Table-row entries of one section's own `INDEX.md`: `| [Title](link) | Description |`.
 * A row whose first column is not a markdown link (a header, a separator, a prose line)
 * contributes nothing. Capped at `MAX_ENTRIES`; `truncated` says whether more existed. */
export function parseSectionEntries(sectionIndexMarkdown: string): { entries: LibraryEntry[]; truncated: boolean } {
  const rows: LibraryEntry[] = [];
  let match: RegExpExecArray | null;
  TABLE_ROW.lastIndex = 0;
  while ((match = TABLE_ROW.exec(sectionIndexMarkdown))) {
    const [, title, link, description] = match;
    const archived = ARCHIVED_PATTERN.test(`${title} ${description} ${link}`);
    rows.push({ title: title.replace(/\*\*/g, '').trim(), archived });
  }
  return { entries: rows.slice(0, MAX_ENTRIES), truncated: rows.length > MAX_ENTRIES };
}

/**
 * A repo root's own library, or undefined when it has no `documentation/bibliotheque/INDEX.md`
 * (graceful degradation: no data, old behavior — here, no library room content at all). A
 * section whose own `INDEX.md` is missing, oversized, or carries no table-row entries is
 * dropped rather than shown empty.
 */
export function readBibliotheque(root: string): Bibliotheque | undefined {
  const base = path.join(root, BIBLIOTHEQUE_RELATIVE);
  const topIndex = readCapped(path.join(base, 'INDEX.md'));
  if (topIndex === undefined) return undefined;
  const sections: LibrarySection[] = [];
  for (const segment of topLevelSections(topIndex).slice(0, MAX_SECTIONS)) {
    const sectionIndex = readCapped(path.join(base, segment, 'INDEX.md'));
    if (sectionIndex === undefined) continue;
    const { entries, truncated } = parseSectionEntries(sectionIndex);
    if (entries.length === 0) continue;
    sections.push({ name: segment, entries, truncated });
  }
  return { sections };
}
