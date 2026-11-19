import type { ManagedAgent } from '../../src/agents/AgentManager.js';

/**
 * One short line of issue IDs in the agent's floating label, so the overview
 * shows them where a card is only a few pixels. It stays in compact labels too:
 * the overview is compact by default, and one short line keeps it readable.
 */

export const MAX_IDS = 5;
/** About the width of a full label. The first ID always shows whole, even when longer. Later IDs drop whole, with `+N`. */
export const ISSUE_LINE_MAX_CHARACTERS = 32;
const LINE_CLASS = 'github-issues';
const STYLE_ID = 'github-issue-ids';
const SEPARATOR = ' · ';

type Issue = NonNullable<NonNullable<ManagedAgent['info']['extras']>['issues']>[number];

/** `agents-office#77 · #79`: the repository shows once while it stays the same, newest first, whole IDs only. */
export function issueIdsLine(issues: Issue[]): string {
  const shown = issues.slice(0, MAX_IDS);
  const ids = shown.map((issue, index) => {
    const same = index > 0 && issue.repo !== undefined && issue.repo === shown[index - 1].repo;
    return `${same ? '' : issue.repo ?? ''}#${issue.number}`;
  });
  let line = '';
  for (let index = 0; index < ids.length; index++) {
    const next = line ? `${line}${SEPARATOR}${ids[index]}` : ids[index];
    const rest = ids.length - index - 1;
    const room = ISSUE_LINE_MAX_CHARACTERS - (rest > 0 ? ` +${rest}`.length : 0);
    if (line && next.length > room) return `${line} +${ids.length - index}`;
    line = next;
  }
  return line;
}

/** The CSS for the line, once per document. Compact labels keep it, small and on one line. */
export function installIssueLineStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = [
    `.agent-label .${LINE_CLASS} { color: #ffd98a; font-size: 11px; font-weight: 600; white-space: nowrap; }`,
    // No CSS ellipsis: issueIdsLine already cuts on whole IDs
    `.agent-label.compact .${LINE_CLASS} { display: block; font-size: 10px; }`,
  ].join('\n');
  doc.head.append(style);
}

/** Put the IDs line in the label, or remove it. The core rewrites the label on a change, so each poll calls this again. */
export function showIssueIds(label: HTMLElement, issues: Issue[]): void {
  const line = issueIdsLine(issues);
  let element = label.querySelector<HTMLElement>(`.${LINE_CLASS}`);
  if (!line) {
    element?.remove();
    return;
  }
  if (!element) {
    element = label.ownerDocument.createElement('div');
    element.className = LINE_CLASS;
    label.append(element);
  }
  if (element.textContent !== line) element.textContent = line;
}
