/**
 * Keyboard triage (issue #85; F walked back on #214): N selects the next
 * agent in the queue, F recenters the camera and runs the ready herdr focus
 * action directly (see `AgentCard.triageFocus`; falls back to a pulse, no
 * request sent, when no ready action exists), and / gives the triage panel's
 * filter field the focus. Ignored while typing in a form field, or with a
 * modifier held, so these keys never clash with WASD, Space, Q, Shift, O, I,
 * Shift+L, Esc or ?. / and ? report the same `Slash` code on a US layout; `?`
 * is Shift+Slash, so / only fires without Shift.
 */

function isFormField(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  const tag = element?.tagName;
  return tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA' || element?.isContentEditable === true;
}

export interface TriageKeyEvent {
  code: string;
  target: EventTarget | null;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  preventDefault(): void;
}

export interface TriageKeyHandlers {
  /** Key N: select the next agent in the fresh/aging queue. */
  next(): void;
  /** Key F: recenter the camera and run the ready herdr focus action directly. */
  focus(): void;
  /** Key /: give the triage panel's filter field the focus. */
  filter(): void;
}

/** Routes a keydown to N, F or /, else does nothing. The / handler also stops the browser's own quick-find. */
export function handleTriageKey(event: TriageKeyEvent, handlers: TriageKeyHandlers): void {
  if (isFormField(event.target) || event.ctrlKey || event.altKey || event.metaKey) return;
  if (event.code === 'KeyN') handlers.next();
  else if (event.code === 'KeyF') handlers.focus();
  else if (event.code === 'Slash' && !event.shiftKey) {
    event.preventDefault();
    handlers.filter();
  }
}
