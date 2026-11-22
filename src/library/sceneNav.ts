/**
 * The single seam between the office scene and the library's own scene (issue #239, Gabriel's
 * "different dimension" idea): a URL search parameter. `main.ts` reads it once, at boot, to
 * decide which scene to build; both the office's own library-door click and the library
 * scene's own "back to the office" door navigate through the exact same two functions below.
 * Nothing else ever has to know this param's name or its one value — a later redesign (the hex
 * office plan's own step 4, moving the entrance door to sit behind Gabriel's office) only ever
 * has to change what the office SIDE points at, never this seam itself.
 */

const SCENE_PARAM = 'scene';
const LIBRARY_SCENE_VALUE = 'library';
/** Issue #245 review: the active floor, carried across the seam as a query param (never the
 * hash — the library scene reads it once at boot, the same way it reads `scene` itself,
 * not through the office's own `#view=`/`#room=` hash machinery, which this scene has no
 * other use for). Without it (or `ALL_FLOORS`), the library scene falls back to its own
 * "first library" default — the same graceful degradation as before this existed. */
const FLOOR_PARAM = 'floor';

export function isLibrarySceneSearch(search: string): boolean {
  return new URLSearchParams(search).get(SCENE_PARAM) === LIBRARY_SCENE_VALUE;
}

/** The floor the library scene should show the catalog for, from its own boot URL — undefined
 * when the office entered with no specific floor focused (or omitted it). */
export function libraryFloorFromSearch(search: string): string | undefined {
  return new URLSearchParams(search).get(FLOOR_PARAM) ?? undefined;
}

/** The parts of `window.location` the nav helpers need; injectable for tests (the same shape
 * `layout/registry.ts`'s own `LayoutSwitchLocation` already uses for the layout switch). */
export interface SceneNavLocation {
  href: string;
}

/** The URL that enters the library scene from wherever the office currently stands (its own
 * `#view=`/`#room=` hash is dropped: the library scene has no use for an office-scoped hash,
 * and keeping one would read as a (broken) promise to resume at that office hash on return).
 * `floor` (issue #245 review: the catalog must follow the active floor, not always the first
 * configured library) carries across as a query param instead — omitted entirely without one,
 * so the library scene's own "no floor specified" default applies, same as before this existed. */
export function libraryEntryUrl(location: SceneNavLocation, floor?: string): string {
  const url = new URL(location.href);
  url.searchParams.set(SCENE_PARAM, LIBRARY_SCENE_VALUE);
  if (floor) url.searchParams.set(FLOOR_PARAM, floor);
  else url.searchParams.delete(FLOOR_PARAM);
  url.hash = '';
  return url.toString();
}

/** The URL that returns to the office from the library scene, landing on the library room
 * itself (issue #245 review: a shared arrival pose, reusing the office's own existing
 * `#room=<name>` framing hash — the single seam this half of the trip owns, so a later move of
 * the office door (the hex plan's own step 4) only ever has to keep `#room=library` resolving,
 * never a second hard-coded position here). */
export function officeReturnUrl(location: SceneNavLocation): string {
  const url = new URL(location.href);
  url.searchParams.delete(SCENE_PARAM);
  url.searchParams.delete(FLOOR_PARAM);
  url.hash = '#room=library';
  return url.toString();
}
