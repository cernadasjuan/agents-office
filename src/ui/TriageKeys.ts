/**
 * Keyboard triage (issue #85): N selects the next agent in the queue, F readies
 * the selected agent's focus action (see `AgentCard.keyboardFocus`, no request
 * leaves the browser), and / gives the triage panel's filter field the focus.
 * Ignored while typing in a form field, or with a modifier held, so these keys
 * never clash with WASD, Space, Q, Shift, O, I, Shift+L, Esc or ?.
 */

function isFormField(target: EventTarget | null): boolean {
  const tag = (target as Element | null)?.tagName;
  return tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA';
}

export interface TriageKeyEvent {
  code: string;
  target: EventTarget | null;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  preventDefault(): void;
}

export interface TriageKeyHandlers {
  /** Key N: select the next agent in the fresh/aging queue. */
  next(): void;
  /** Key F: ready, but do not run, the selected agent's focus action. */
  focus(): void;
  /** Key /: give the triage panel's filter field the focus. */
  filter(): void;
}

/** Routes a keydown to N, F or /, else does nothing. The / handler also stops the browser's own quick-find. */
export function handleTriageKey(event: TriageKeyEvent, handlers: TriageKeyHandlers): void {
  if (isFormField(event.target) || event.ctrlKey || event.altKey || event.metaKey) return;
  if (event.code === 'KeyN') handlers.next();
  else if (event.code === 'KeyF') handlers.focus();
  else if (event.code === 'Slash') {
    event.preventDefault();
    handlers.filter();
  }
}
