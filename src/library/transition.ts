/**
 * The short loading transition between the office scene and the library's own scene (issue
 * #239: "it could be a different section of the game ... like have a loading screen"). A plain
 * full-screen overlay, shown for `TRANSITION_MS` before the navigation actually happens (so a
 * reload never reads as an abrupt flash) and left up until the destination scene's first frame
 * removes it.
 */

export const TRANSITION_MS = 420;

const FROM_LIBRARY_KEY = 'agents-office.from-library';

export function showTransition(text: string): HTMLElement {
  const element = document.createElement('div');
  element.className = 'scene-transition';
  element.textContent = text;
  document.body.appendChild(element);
  return element;
}

export function removeTransition(element: HTMLElement | null): void {
  element?.remove();
}

/** Shows the overlay, waits for it to actually be seen, then runs `go` (the navigation). */
export function navigateAfterTransition(text: string, go: () => void, wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))): void {
  showTransition(text);
  void wait(TRANSITION_MS).then(go);
}

/** Set right before the library's own "back to the office" door navigates away: the office's
 * own boot reads this once (`consumeReturningFromLibrary`) to show its own brief arrival
 * overlay, without adding one to every ordinary office load. */
export function markReturningFromLibrary(storage: Pick<Storage, 'setItem'> = sessionStorage): void {
  storage.setItem(FROM_LIBRARY_KEY, '1');
}

/** True exactly once per library exit: reading it clears it, so a later ordinary reload of the
 * office never replays the arrival overlay. */
export function consumeReturningFromLibrary(storage: Pick<Storage, 'getItem' | 'removeItem'> = sessionStorage): boolean {
  const flag = storage.getItem(FROM_LIBRARY_KEY) === '1';
  storage.removeItem(FROM_LIBRARY_KEY);
  return flag;
}
