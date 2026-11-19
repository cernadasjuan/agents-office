const TITLE = 'Agents Office';

/** Browser tab title: blocked agents in parentheses, then agents whose turn is yours. */
export function tabTitle(blocked: number, yourTurn: number): string {
  const parts = [blocked > 0 ? `(${blocked})` : '', yourTurn > 0 ? `+${yourTurn}` : ''].filter(Boolean);
  return parts.length === 0 ? TITLE : `${parts.join(' ')}${yourTurn > 0 ? ' ·' : ''} ${TITLE}`;
}

/** The label line: the activity, then how long the agent has waited for the user. */
export function attentionLine(activityLabel: string, attention: string | undefined, waitMinutes: number | undefined): string {
  if (attention === 'waiting') return `Waiting for you${waitMinutes !== undefined ? ` · ${formatWait(waitMinutes)}` : ''}`;
  if (attention === 'your-turn') return `Your turn${waitMinutes !== undefined ? ` · ${formatWait(waitMinutes)}` : ''}`;
  return activityLabel;
}

export function formatWait(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)} h`;
  return `${Math.floor(minutes / (24 * 60))} d`;
}
