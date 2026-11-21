import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isLibrarySceneSearch, libraryEntryUrl, officeReturnUrl } from '../src/library/sceneNav.js';

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

test('officeReturnUrl removes ?scene=library and drops the hash, keeping every other param', () => {
  const url = officeReturnUrl({ href: 'http://localhost:5173/?layout=building&scene=library#view=iso' });
  assert.equal(url, 'http://localhost:5173/?layout=building');
});

test('entering then returning round-trips back to the original params (minus any hash)', () => {
  const office = { href: 'http://localhost:5173/?layout=building' };
  const entered = libraryEntryUrl(office);
  const returned = officeReturnUrl({ href: entered });
  assert.equal(returned, 'http://localhost:5173/?layout=building');
});
