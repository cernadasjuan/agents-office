import type { ComponentRole } from './HexPlanner.js';

/**
 * Which of the 4 hex wings (issue #258 steps 5/6, `HexPlanner.SECTOR_TABLE`) a mission's own
 * repo belongs in. A mission room only ever carries a bare repo short name (`WorldRoom.repo`,
 * `FloorRegistry.ts`'s own whitelist — one segment, or two joined by a slash), never a full
 * URL or an org-qualified path beyond that, so this is a keyword match against that short name,
 * nothing cleverer.
 *
 * The simplest honest rule, from the floor data this office already carries, not an invented
 * taxonomy. Klever repos all share an `app-`/`grp-` prefix (`workspace-map.yaml`), so the
 * prefix itself carries no signal — only the part after it does:
 * - `infra`: deploy/platform plumbing (`dac`, `infra`, `terraform`, `iac`, a standalone `ci`
 *   segment). Checked first: an infra repo's own name sometimes also carries one of the other
 *   wings' keywords (e.g. a DAC that manages agent config), and deploy plumbing is the more
 *   specific signal of the two.
 * - `portal`: a user-facing frontend (`front`, `portal`).
 * - `agents`: this office itself and anything about running/hosting agents (`agent`, `proxi`,
 *   `hermes` — the Proxi/Hermes agent's own repo names).
 * - `tooling`: everything else, the default wing — skills, scripts, harness/settings repos
 *   (`skill`, `tool`, `script`, `harness`, `settings`), and any repo this rule does not
 *   otherwise recognize (a Java backend service like `app-proximity-report`, for one — no
 *   false-confident bucket for it, the honest catch-all instead). Never a silent drop (round
 *   7: "unmapped missions go to a default wing") — every mission gets a wing, this is just the
 *   catch-all one.
 *
 * Checked in this order (first match wins) so a repo matching two keywords resolves
 * predictably rather than by object key order.
 */
export function componentForRepo(repo: string | undefined): ComponentRole {
  const name = (repo ?? '').toLowerCase();
  if (/(^|-)dac(-|$)|infra|terraform|(^|-)iac(-|$)|(^|-)ci(-|$)/.test(name)) return 'infra';
  if (/front|portal/.test(name)) return 'portal';
  // `proxi(?![a-z])` so "proximity" (app-proximity-report, Klever's own backend) never falsely
  // matches the Proxi agent's own repo name.
  if (/agent|proxi(?![a-z])|hermes/.test(name)) return 'agents';
  return 'tooling';
}
