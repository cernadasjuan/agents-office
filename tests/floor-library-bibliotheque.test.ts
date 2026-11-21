import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { parseSectionEntries, readBibliotheque, topLevelSections } from '../plugins/floor-library/bibliotheque.js';

// Synthetic fixtures only (brief rule: never read Gabriel's real ~/.claude or his real
// project-management checkout in a test); a fresh temp dir per test file, removed after.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-office-floor-library-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

function write(relative: string, content: string): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

test('top-level sections come from the top INDEX.md own links, deduplicated, never a nested path', () => {
  const index = `
# Bibliothèque

| [vendors/INDEX.md](vendors/INDEX.md) | Vendors |
| [vendors/INDEX.md](vendors/INDEX.md) | duplicate link, same section |
| [domain/INDEX.md](domain/INDEX.md) | Domain |
| [vendors/placer/INDEX.md](vendors/placer/INDEX.md) | a nested section's own index, not top level |
| [GLOSSARY.md](GLOSSARY.md) | not a section index at all |
`;
  assert.deepEqual(topLevelSections(index), ['vendors', 'domain']);
});

test('section entries come from table rows with a markdown link in the first column, carrying the description as a summary and the raw link for resolution', () => {
  const sectionIndex = `
# Vendors

| File | Description |
|------|------|
| [Placer.ai](placer/INDEX.md) | Foot traffic vendor |
| [Old vendor (ARCHIVED)](old-vendor.md) | No longer in use |
| plain text row with no link | ignored |
`;
  const { entries, truncated } = parseSectionEntries(sectionIndex);
  assert.deepEqual(entries, [
    { title: 'Placer.ai', archived: false, summary: 'Foot traffic vendor', link: 'placer/INDEX.md' },
    { title: 'Old vendor (ARCHIVED)', archived: true, summary: 'No longer in use', link: 'old-vendor.md' },
  ]);
  assert.equal(truncated, false);
});

test('a superseded entry, or one filed under an archive/ path, is marked archived too', () => {
  const sectionIndex = `
| [Legacy approach](legacy.md) | Superseded by the new design |
| [Moved out](archive/2026/old.md) | Moved here after it closed |
`;
  const { entries } = parseSectionEntries(sectionIndex);
  assert.deepEqual(entries.map((e) => e.archived), [true, true]);
});

test('entries past the cap (100) are dropped, with truncated set', () => {
  const rows = Array.from({ length: 101 }, (_, i) => `| [Entry ${i}](e${i}.md) | d |`).join('\n');
  const { entries, truncated } = parseSectionEntries(rows);
  assert.equal(entries.length, 100);
  assert.equal(truncated, true);
});

test('a root with no documentation/bibliotheque/INDEX.md has no library (graceful degradation)', () => {
  assert.equal(readBibliotheque(path.join(root, 'no-such-repo')), undefined);
});

test('a real top index with real section indexes builds one section per section index present', () => {
  write('has-library/documentation/bibliotheque/INDEX.md', `
| [vendors/INDEX.md](vendors/INDEX.md) | Vendors |
| [domain/INDEX.md](domain/INDEX.md) | Domain, no section index written below |
`);
  write('has-library/documentation/bibliotheque/vendors/INDEX.md', `
| [Placer.ai](placer.md) | Foot traffic |
| [Old vendor (archived)](old.md) | gone |
`);
  // domain/INDEX.md deliberately not written: the section is linked but has no own index yet.
  const library = readBibliotheque(path.join(root, 'has-library'));
  assert.ok(library);
  // `placer.md`/`old.md` are not written on disk here, so neither entry resolves a
  // `lastChanged`/`repoPath` (graceful degradation, same as a dangling link today).
  assert.deepEqual(library!.sections, [
    { name: 'vendors', entries: [
      { title: 'Placer.ai', archived: false, summary: 'Foot traffic' },
      { title: 'Old vendor (archived)', archived: true, summary: 'gone' },
    ], truncated: false },
  ]);
});

test('a section whose own index has no table-row entries is dropped, not shown empty', () => {
  write('empty-section/documentation/bibliotheque/INDEX.md', '| [lab/INDEX.md](lab/INDEX.md) | Lab |');
  write('empty-section/documentation/bibliotheque/lab/INDEX.md', 'Nothing here yet, no table.');
  const library = readBibliotheque(path.join(root, 'empty-section'));
  assert.deepEqual(library, { sections: [] });
});

test('an oversized top INDEX.md reads as its own capped prefix, not as no library: the real Klever one is 287 KB with its section links around line 31', () => {
  // The same shape the real file has: a long prose preamble, section links early (within the
  // cap even once it is 300 KB), then another ~290 KB of per-vendor prose after them.
  const preambleLines = Array.from({ length: 30 }, (_, i) => `Preamble line ${i} about the wiki, long enough to look like real prose.`);
  const sectionLinks = [
    '| [vendors/INDEX.md](vendors/INDEX.md) | Vendors |',
    '| [domain/INDEX.md](domain/INDEX.md) | Domain |',
  ];
  const trailingBulk = 'x'.repeat(300_000);
  write('too-big/documentation/bibliotheque/INDEX.md', [...preambleLines, ...sectionLinks, trailingBulk].join('\n'));
  write('too-big/documentation/bibliotheque/vendors/INDEX.md', '| [Placer.ai](placer.md) | Foot traffic |');
  const library = readBibliotheque(path.join(root, 'too-big'));
  assert.deepEqual(library, {
    sections: [{ name: 'vendors', entries: [{ title: 'Placer.ai', archived: false, summary: 'Foot traffic' }], truncated: false }],
  }, 'the section link, well within the first 200,000 bytes, still parses even though the whole file does not fit');
});

test('readCapped never hands the parser a partial trailing line: the cut lands on the last full newline within the cap', () => {
  const line = 'y'.repeat(99);
  // 2021 full lines of 100 bytes (99 + \n) = 202,100 bytes, past MAX_INDEX_BYTES (200,000):
  // the 2001st line (byte offset 200,000) would start mid-line without the last-full-line cut.
  const lines = Array.from({ length: 2021 }, (_, i) => (i === 10 ? '| [vendors/INDEX.md](vendors/INDEX.md) | Vendors |'.padEnd(99) : line));
  write('cut-boundary/documentation/bibliotheque/INDEX.md', lines.join('\n'));
  write('cut-boundary/documentation/bibliotheque/vendors/INDEX.md', '| [Placer.ai](placer.md) | Foot traffic |');
  const library = readBibliotheque(path.join(root, 'cut-boundary'));
  assert.deepEqual(library?.sections.map((s) => s.name), ['vendors'], 'the link found near the top parses cleanly regardless of where the cap lands further down');
});

test('a section index cut by the byte cap is marked truncated even with only a few rows before the cut (review: row-count truncated alone missed a byte-cut section under MAX_ENTRIES)', () => {
  // 2 rows before the cap, well under MAX_ENTRIES (6), then ~290 KB of bulk hiding a 3rd row
  // past the cut: parseSectionEntries alone would say truncated=false since it only ever sees
  // 2 rows, but the shelf is incomplete and the UI needs to know that.
  const sectionIndex = [
    '| [Placer.ai](placer.md) | Foot traffic |',
    '| [Foursquare](foursquare.md) | POI |',
    'x'.repeat(300_000),
    '| [Hidden past the cap](hidden.md) | never read |',
  ].join('\n');
  write('section-byte-truncated/documentation/bibliotheque/INDEX.md', '| [vendors/INDEX.md](vendors/INDEX.md) | Vendors |');
  write('section-byte-truncated/documentation/bibliotheque/vendors/INDEX.md', sectionIndex);
  const library = readBibliotheque(path.join(root, 'section-byte-truncated'));
  assert.deepEqual(library, {
    sections: [{
      name: 'vendors',
      entries: [
        { title: 'Placer.ai', archived: false, summary: 'Foot traffic' },
        { title: 'Foursquare', archived: false, summary: 'POI' },
      ],
      truncated: true,
    }],
  }, 'the byte cap cut content the row count alone would not catch, so truncated must still be true');
});

test('a section directory symlinked outside the bibliotheque root contributes nothing (review: checking only the leaf INDEX.md\'s own lstat missed a symlinked parent directory escaping the root)', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-office-outside-bibliotheque-'));
  fs.writeFileSync(path.join(outside, 'INDEX.md'), '| [Private](private.md) | not meant to be read as a floor library |');
  write('escape/documentation/bibliotheque/INDEX.md', '| [vendors/INDEX.md](vendors/INDEX.md) | Vendors |');
  fs.mkdirSync(path.join(root, 'escape', 'documentation', 'bibliotheque'), { recursive: true });
  fs.symlinkSync(outside, path.join(root, 'escape', 'documentation', 'bibliotheque', 'vendors'));
  try {
    const library = readBibliotheque(path.join(root, 'escape'));
    assert.deepEqual(library, { sections: [] }, 'the symlinked section is dropped, not read through');
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

// --- Issue #221 AC2/AC3: an entry's own `lastChanged`/`repoPath`, resolved from its real file ---

test('an entry whose link target is a real file inside the tree resolves a last-changed date and a repo-relative path', () => {
  write('resolved/documentation/bibliotheque/INDEX.md', '| [vendors/INDEX.md](vendors/INDEX.md) | Vendors |');
  write('resolved/documentation/bibliotheque/vendors/INDEX.md', '| [Placer.ai](placer.md) | Foot traffic |');
  write('resolved/documentation/bibliotheque/vendors/placer.md', '# Placer.ai\n');
  const library = readBibliotheque(path.join(root, 'resolved'));
  const entry = library?.sections[0]?.entries[0];
  assert.ok(entry);
  assert.equal(entry!.repoPath, 'documentation/bibliotheque/vendors/placer.md');
  assert.match(entry!.lastChanged ?? '', /^\d{4}-\d{2}-\d{2}$/);
});

test('an entry linking to an external URL resolves no lastChanged/repoPath (never a filesystem lookup on a scheme)', () => {
  write('external-link/documentation/bibliotheque/INDEX.md', '| [vendors/INDEX.md](vendors/INDEX.md) | Vendors |');
  write('external-link/documentation/bibliotheque/vendors/INDEX.md', '| [Notion page](https://www.notion.so/some-page) | External |');
  const library = readBibliotheque(path.join(root, 'external-link'));
  const entry = library?.sections[0]?.entries[0];
  assert.ok(entry);
  assert.equal(entry!.repoPath, undefined);
  assert.equal(entry!.lastChanged, undefined);
});

test('an entry whose link target escapes the bibliotheque tree through a symlink resolves no lastChanged/repoPath (same escape rule as a symlinked section)', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-office-outside-entry-'));
  fs.writeFileSync(path.join(outside, 'secret.md'), 'not meant to be linked');
  write('escaping-entry/documentation/bibliotheque/INDEX.md', '| [vendors/INDEX.md](vendors/INDEX.md) | Vendors |');
  write('escaping-entry/documentation/bibliotheque/vendors/INDEX.md', '| [Escaping link](escape.md) | Points outside |');
  fs.symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'escaping-entry', 'documentation', 'bibliotheque', 'vendors', 'escape.md'));
  try {
    const library = readBibliotheque(path.join(root, 'escaping-entry'));
    const entry = library?.sections[0]?.entries[0];
    assert.ok(entry);
    assert.equal(entry!.repoPath, undefined);
    assert.equal(entry!.lastChanged, undefined);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
