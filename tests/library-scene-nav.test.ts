import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isLibrarySceneSearch, libraryEntryUrl, libraryFloorFromSearch, officeReturnUrl } from '../src/library/sceneNav.js';

test('isLibrarySceneSearch is true only for ?scene=library', () => {
  assert.equal(isLibrarySceneSearch('?scene=library'), true);
  assert.equal(isLibrarySceneSearch('?scene=office'), false);
  assert.equal(isLibrarySceneSearch(''), false);
  assert.equal(isLibrarySceneSearch('?layout=building'), false);
});

test('libraryEntryUrl adds ?scene=library and drops the hash, keeping every other param', () => {
  const url = libraryEntryUrl({ href: 'http://localhost:5173/?layout=building#view=iso&room=office' });
  assert.equal(url, 'http://localhost:5173/?layout=building&scene=library');
});

test('issue #245 review: libraryEntryUrl carries the active floor as a query param, never the hash', () => {
  const url = libraryEntryUrl({ href: 'http://localhost:5173/?layout=building' }, 'org/project-management');
  assert.equal(url, 'http://localhost:5173/?layout=building&scene=library&floor=org%2Fproject-management');
  assert.equal(libraryFloorFromSearch(new URL(url).search), 'org/project-management');
});

test('libraryEntryUrl without a floor omits the param entirely (the library scene\'s own "no floor" default applies)', () => {
  const url = libraryEntryUrl({ href: 'http://localhost:5173/' });
  assert.equal(libraryFloorFromSearch(new URL(url).search), undefined);
});

test('officeReturnUrl removes ?scene=library and ?floor=, and lands on #room=library (a shared arrival pose, not a dropped one)', () => {
  const url = officeReturnUrl({ href: 'http://localhost:5173/?layout=building&scene=library&floor=org%2Fpm#view=iso' });
  assert.equal(url, 'http://localhost:5173/?layout=building#room=library');
});

test('entering then returning round-trips back to the original params, landing back on the library room', () => {
  const office = { href: 'http://localhost:5173/?layout=building' };
  const entered = libraryEntryUrl(office, 'org/project-management');
  const returned = officeReturnUrl({ href: entered });
  assert.equal(returned, 'http://localhost:5173/?layout=building#room=library');
});
