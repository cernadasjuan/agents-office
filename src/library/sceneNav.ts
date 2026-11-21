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

export function isLibrarySceneSearch(search: string): boolean {
  return new URLSearchParams(search).get(SCENE_PARAM) === LIBRARY_SCENE_VALUE;
}

/** The parts of `window.location` the nav helpers need; injectable for tests (the same shape
 * `layout/registry.ts`'s own `LayoutSwitchLocation` already uses for the layout switch). */
export interface SceneNavLocation {
  href: string;
}

/** The URL that enters the library scene from wherever the office currently stands (its own
 * `#view=`/`#room=` hash is dropped: the library scene has no use for an office-scoped hash,
 * and keeping one would read as a (broken) promise to resume at that office hash on return). */
export function libraryEntryUrl(location: SceneNavLocation): string {
  const url = new URL(location.href);
  url.searchParams.set(SCENE_PARAM, LIBRARY_SCENE_VALUE);
  url.hash = '';
  return url.toString();
}

/** The URL that returns to the office from the library scene. */
export function officeReturnUrl(location: SceneNavLocation): string {
  const url = new URL(location.href);
  url.searchParams.delete(SCENE_PARAM);
  url.hash = '';
  return url.toString();
}
