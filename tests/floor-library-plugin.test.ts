import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { floorLibraryPlugin, parseRoots, readLibraries } from '../plugins/floor-library/index.js';
import { GENERAL_FLOOR } from '../server/floor.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-office-floor-library-plugin-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

function write(relative: string, content: string): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

test('roots parse the same comma-list shape AGENTS_OFFICE_MISSION_ROOTS already uses', () => {
  assert.deepEqual(parseRoots(undefined), []);
  assert.deepEqual(parseRoots(`${root}, relative/path, ${root}/sub`), [root, `${root}/sub`]);
});

test('a root with no bibliotheque contributes nothing; its own floor is never guessed at', () => {
  const resolver = { resolve: () => 'pm-floor' };
  assert.deepEqual(readLibraries([path.join(root, 'no-library')], resolver), []);
});

test('a root with a bibliotheque becomes one library, tagged with its own floor', () => {
  write('pm/documentation/bibliotheque/INDEX.md', '| [vendors/INDEX.md](vendors/INDEX.md) | Vendors |');
  write('pm/documentation/bibliotheque/vendors/INDEX.md', '| [Placer.ai](placer.md) | Foot traffic |');
  const pmRoot = path.join(root, 'pm');
  const resolver = { resolve: (cwd: string | undefined) => (cwd === pmRoot ? 'org/project-management' : GENERAL_FLOOR) };
  const libraries = readLibraries([pmRoot], resolver);
  assert.deepEqual(libraries, [{
    key: pmRoot,
    sections: [{ name: 'vendors', entries: [{ title: 'Placer.ai', archived: false, summary: 'Foot traffic' }], truncated: false }],
    repo: 'org/project-management',
  }]);
});

test('a root that resolves to the general floor gets no repo tag (it is itself a selectable floor, never a guess)', () => {
  write('general-root/documentation/bibliotheque/INDEX.md', '| [vendors/INDEX.md](vendors/INDEX.md) | Vendors |');
  write('general-root/documentation/bibliotheque/vendors/INDEX.md', '| [x](x.md) | y |');
  const generalRoot = path.join(root, 'general-root');
  const libraries = readLibraries([generalRoot], { resolve: () => GENERAL_FLOOR });
  assert.equal(libraries[0].repo, undefined);
});

test('without AGENTS_OFFICE_LIBRARY_ROOTS set, the plugin world provider adds nothing', async () => {
  const plugin = floorLibraryPlugin([]);
  const provider = plugin.world![0];
  assert.deepEqual(await provider.world([]), {});
});

test('the plugin caches its read for 30 s, the same window plugins/missions already uses', async () => {
  write('cached/documentation/bibliotheque/INDEX.md', '| [vendors/INDEX.md](vendors/INDEX.md) | Vendors |');
  write('cached/documentation/bibliotheque/vendors/INDEX.md', '| [x](x.md) | y |');
  const cachedRoot = path.join(root, 'cached');
  let now = 0;
  const plugin = floorLibraryPlugin([cachedRoot], () => now);
  const provider = plugin.world![0];
  const first = await provider.world([]);
  assert.equal((first.libraries ?? []).length, 1);
  fs.rmSync(path.join(cachedRoot, 'documentation'), { recursive: true, force: true });
  const stillCached = await provider.world([]);
  assert.deepEqual(stillCached, first, 'still within the cache window');
  now = 30_001;
  const refreshed = await provider.world([]);
  assert.deepEqual(refreshed, {}, 'cache expired, the directory is gone now');
});
