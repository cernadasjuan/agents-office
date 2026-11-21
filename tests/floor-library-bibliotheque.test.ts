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

test('section entries come from table rows with a markdown link in the first column', () => {
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
    { title: 'Placer.ai', archived: false },
    { title: 'Old vendor (ARCHIVED)', archived: true },
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

test('entries past the cap are dropped, with truncated set', () => {
  const rows = Array.from({ length: 9 }, (_, i) => `| [Entry ${i}](e${i}.md) | d |`).join('\n');
  const { entries, truncated } = parseSectionEntries(rows);
  assert.equal(entries.length, 6);
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
  assert.deepEqual(library!.sections, [
    { name: 'vendors', entries: [{ title: 'Placer.ai', archived: false }, { title: 'Old vendor (archived)', archived: true }], truncated: false },
  ]);
});

test('a section whose own index has no table-row entries is dropped, not shown empty', () => {
  write('empty-section/documentation/bibliotheque/INDEX.md', '| [lab/INDEX.md](lab/INDEX.md) | Lab |');
  write('empty-section/documentation/bibliotheque/lab/INDEX.md', 'Nothing here yet, no table.');
  const library = readBibliotheque(path.join(root, 'empty-section'));
  assert.deepEqual(library, { sections: [] });
});

test('an oversized top INDEX.md reads as no library, not a crash', () => {
  write('too-big/documentation/bibliotheque/INDEX.md', 'x'.repeat(200_001));
  assert.equal(readBibliotheque(path.join(root, 'too-big')), undefined);
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
