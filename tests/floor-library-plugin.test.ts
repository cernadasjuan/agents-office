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
  const resolver = { resolve: () => 'pm-floor', resolveRemoteOwnerRepo: () => undefined };
  assert.deepEqual(readLibraries([path.join(root, 'no-library')], resolver), []);
});

test('a root with a bibliotheque and a real git remote becomes one library, carrying both its floor and its remote owner/repo', () => {
  write('pm/documentation/bibliotheque/INDEX.md', '| [vendors/INDEX.md](vendors/INDEX.md) | Vendors |');
  write('pm/documentation/bibliotheque/vendors/INDEX.md', '| [Placer.ai](placer.md) | Foot traffic |');
  const pmRoot = path.join(root, 'pm');
  const resolver = {
    resolve: (cwd: string | undefined) => (cwd === pmRoot ? 'org/project-management' : GENERAL_FLOOR),
    resolveRemoteOwnerRepo: (cwd: string | undefined) => (cwd === pmRoot ? 'gabriel-amyot/klever-project-management' : undefined),
  };
  const libraries = readLibraries([pmRoot], resolver);
  assert.deepEqual(libraries, [{
    key: pmRoot,
    sections: [{ name: 'vendors', entries: [{ title: 'Placer.ai', archived: false, summary: 'Foot traffic' }], truncated: false }],
    repo: 'org/project-management',
    remoteRepo: 'gabriel-amyot/klever-project-management',
  }]);
});

test('a root that resolves to the general floor gets no repo tag (it is itself a selectable floor, never a guess)', () => {
  write('general-root/documentation/bibliotheque/INDEX.md', '| [vendors/INDEX.md](vendors/INDEX.md) | Vendors |');
  write('general-root/documentation/bibliotheque/vendors/INDEX.md', '| [x](x.md) | y |');
  const generalRoot = path.join(root, 'general-root');
  const libraries = readLibraries([generalRoot], { resolve: () => GENERAL_FLOOR, resolveRemoteOwnerRepo: () => undefined });
  assert.equal(libraries[0].repo, undefined);
});

test('issue #221 review: a floor resolved only through the directory-name fallback (no git remote at all) carries repo but never remoteRepo', () => {
  write('fallback-floor/documentation/bibliotheque/INDEX.md', '| [vendors/INDEX.md](vendors/INDEX.md) | Vendors |');
  write('fallback-floor/documentation/bibliotheque/vendors/INDEX.md', '| [x](x.md) | y |');
  const fallbackRoot = path.join(root, 'fallback-floor');
  // `resolve()` still answers with the directory-pair fallback (`qualifiedFloorName`'s own
  // behavior with no remote); `resolveRemoteOwnerRepo()` correctly answers undefined for the
  // exact same root, since there is no real git remote to report.
  const resolver = {
    resolve: () => 'some-parent-dir/fallback-floor',
    resolveRemoteOwnerRepo: () => undefined,
  };
  const libraries = readLibraries([fallbackRoot], resolver);
  assert.equal(libraries[0].repo, 'some-parent-dir/fallback-floor');
  assert.equal('remoteRepo' in libraries[0], false);
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
