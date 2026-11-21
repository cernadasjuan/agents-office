import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { missionsInToolCalls, missionsPlugin, parseRoots, readMissions, summarizeMission } from '../plugins/missions/index.js';
import type { Observation } from '../server/seam.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-office-missions-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

function writeMission(slug: string, body: string): void {
  fs.mkdirSync(path.join(root, 'missions', slug), { recursive: true });
  fs.writeFileSync(path.join(root, 'missions', slug, 'mission.yaml'), body);
}

writeMission('office-roadmap', `
title: "Office roadmap"
status: active
destination: >
  Every slice merged.
artifacts:
  - {id: ART-1, title: "Design explainer"}
members:
  - {kind: gh, ref: "owner/repo#46", title: "Roadmap parent", role: current}
  - {kind: gh, ref: "owner/repo#11", title: "Fixes", role: done}
  - {kind: folder, ref: "tickets/x", title: "Folder", role: current}
journey:
  - {id: J-1, kind: session, end: "2026-11-18T19:40:00Z"}
  - {id: J-2, kind: session}
  - {id: J-3, kind: gap}
threads:
  - {id: T-1, title: "Big intent", state: open}
  - {id: T-2, title: "Post upstream", state: needs_you}
  - {id: T-3, title: "Done thing", state: resolved}
`);
writeMission('old-mission', 'title: Old\nstatus: done\n');
fs.mkdirSync(path.join(root, 'missions', '_meta'), { recursive: true });

// Issue #159 review round 1: a sleeper's `session:` field is free text until checked against
// the slug shape, same as the story lookup's own check.
writeMission('slug-check', `
title: "Slug check"
status: active
journey:
  - {id: J-1, kind: session, session: tidy-otter}
  - {id: J-2, kind: session, session: "../escape"}
  - {id: J-3, kind: session, session: "Not_A_Slug"}
`);

test('a mission record becomes room walls: statement, docs, issues, kanban and past sessions', () => {
  const [mission] = readMissions([root]).filter((m) => m.slug === 'office-roadmap');
  assert.equal(mission.title, 'Office roadmap');
  assert.equal(mission.state, 'open');
  assert.equal(mission.statement, 'Every slice merged.');
  assert.deepEqual(mission.docs, ['Design explainer']);
  assert.deepEqual(mission.issues, [
    { repo: 'owner/repo', number: 46, title: 'Roadmap parent', state: 'open' },
    { repo: 'owner/repo', number: 11, title: 'Fixes', state: 'closed' },
  ]);
  assert.deepEqual(mission.kanban.map((c) => [c.column, c.cards.map((card) => card.number)]), [['Needs you', [2]], ['Open', [1]], ['Done', [3]]]);
  assert.deepEqual(mission.sleepers, [{ id: 'J-1', endedAt: '2026-11-18T19:40:00Z' }, { id: 'J-2' }]);
});

test('a session entry with no id does not become a tombstone', () => {
  const mission = summarizeMission('no-id', { title: 'No id', status: 'active', journey: [{ kind: 'session' }, { id: 'J-1', kind: 'session' }] });
  assert.deepEqual(mission?.sleepers, [{ id: 'J-1' }]);
});

// --- Issue #146: link each war-room issue to its real GitHub issue ---

test('AC: "owner/repo#46" keeps the repo and the number', () => {
  const mission = summarizeMission('x', { members: [{ kind: 'gh', ref: 'gabriel-amyot/agents-office#46', title: 'Roadmap' }] });
  assert.deepEqual(mission?.issues, [{ repo: 'gabriel-amyot/agents-office', number: 46, title: 'Roadmap', state: 'open' }]);
});

test('AC: a bare "#46" gives no repo and no link', () => {
  const mission = summarizeMission('x', { members: [{ kind: 'gh', ref: '#46', title: 'Local only' }] });
  assert.deepEqual(mission?.issues, [{ number: 46, title: 'Local only', state: 'open' }]);
  assert.ok(!('repo' in mission!.issues[0]));
});

test('a full GitHub issue URL also keeps the repo and the number', () => {
  const mission = summarizeMission('x', { members: [{ kind: 'gh', ref: 'https://github.com/gabriel-amyot/agents-office/issues/46', title: 'By URL' }] });
  assert.deepEqual(mission?.issues, [{ repo: 'gabriel-amyot/agents-office', number: 46, title: 'By URL', state: 'open' }]);
});

test('the mission\'s root issue appears first in the issue list', () => {
  const mission = summarizeMission('x', {
    root_issue: { number: 122, url: 'https://github.com/gabriel-amyot/agentic-engeneering-settings/issues/122' },
    members: [{ kind: 'gh', ref: 'gabriel-amyot/agents-office#46', title: 'Roadmap' }],
  });
  assert.deepEqual(mission?.issues[0], { repo: 'gabriel-amyot/agentic-engeneering-settings', number: 122, title: 'Root issue', state: 'open' });
  assert.equal(mission?.issues.length, 2);
});

// --- Issue #191: a mission tags its own repo, for the focused floor to scope its war room by ---

test('a mission\'s repo comes from its root issue first, kept as the full owner/repo pair', () => {
  const mission = summarizeMission('x', { root_issue: { number: 1, url: 'https://github.com/gabriel-amyot/agents-office/issues/1' } });
  assert.equal(mission?.repo, 'gabriel-amyot/agents-office');
});

test('without a root issue, a mission falls back to its first GitHub member\'s repo, also kept whole', () => {
  const mission = summarizeMission('x', { members: [
    { kind: 'folder', ref: 'tickets/x', title: 'Folder' },
    { kind: 'gh', ref: 'gabriel-amyot/widget-service#9', title: 'Fix' },
  ] });
  assert.equal(mission?.repo, 'gabriel-amyot/widget-service');
});

test('with no GitHub reference at all, a mission falls back to its own root directory\'s floor, owner/repo included when its remote resolves one', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-office-missions-root-'));
  const repoDir = path.join(fixtureRoot, 'someorg', 'project-xyz');
  fs.mkdirSync(path.join(repoDir, '.git'), { recursive: true });
  try {
    const mission = summarizeMission('x', { title: 'No GH ref' }, repoDir);
    assert.equal(mission?.repo, 'someorg/project-xyz', 'no remote configured here: falls back to the parent-dir qualifier, same as the floor itself would');
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('with no GitHub reference and a root whose own git remote resolves one, the mission tags the full owner/repo, not the directory name', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-office-missions-remote-'));
  const repoDir = path.join(fixtureRoot, 'projects', 'agents-office');
  fs.mkdirSync(path.join(repoDir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/gabriel-amyot/agents-office.git\n');
  try {
    const mission = summarizeMission('x', { title: 'No GH ref, remote resolves' }, repoDir);
    assert.equal(mission?.repo, 'gabriel-amyot/agents-office', 'the remote owner/repo, not "projects/agents-office"');
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('with no GitHub reference and a root that resolves to no repo at all, a mission tags the general floor', () => {
  const mission = summarizeMission('x', { title: 'No GH ref, no repo' }, root);
  assert.equal(mission?.repo, 'general');
});

test('with no GitHub reference and no root given, a mission carries no repo tag', () => {
  const mission = summarizeMission('x', { title: 'No GH ref, no root' });
  assert.ok(!('repo' in mission!));
});

test('a done mission is a locked room, and folders that are not missions are skipped', () => {
  const missions = readMissions([root]);
  assert.equal(missions.find((m) => m.slug === 'old-mission')?.state, 'locked');
  assert.equal(missions.some((m) => m.slug === '_meta'), false);
  assert.equal(summarizeMission('x', 'not an object'), null);
});

test('only absolute roots are accepted', () => {
  assert.deepEqual(parseRoots(`relative, ${root} ,/bad\0path`), [root]);
});

const line = (input: Record<string, unknown>, name = 'Bash') =>
  JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', name, input }] } });

test('tool calls that touch a mission count; text that only mentions it does not', () => {
  const known = new Set(['office-roadmap']);
  const chunk = [
    JSON.stringify({ message: { role: 'user', content: 'please open missions/office-roadmap/mission.yaml' } }),
    line({ command: '~/.claude/skills/mission/scripts/mission sync office-roadmap -m x' }),
    line({ file_path: '/pm/missions/office-roadmap/mission.yaml' }, 'Read'),
    line({ command: 'mission thread add office-roadmap --kind intent' }),
    line({ command: 'mission sync unknown-slug' }),
  ].join('\n');
  assert.deepEqual(missionsInToolCalls(chunk, known), ['office-roadmap', 'office-roadmap', 'office-roadmap']);
});

test('a session and its subagents join the room of the open mission its tool calls touched last', async () => {
  const transcript = path.join(root, 'session.jsonl');
  fs.writeFileSync(transcript, `${line({ command: 'mission sync office-roadmap' })}\n`);
  const plugin = missionsPlugin([root]);
  const observations: Observation[] = [
    { id: 's', provider: 'claude', name: 's', activity: 'planning', internal: { transcriptPath: transcript }, display: {} },
    { id: 'child', parentId: 's', provider: 'claude', name: 'c', activity: 'researching', internal: {}, display: {} },
    { id: 'other', provider: 'claude', name: 'o', activity: 'idle', internal: {}, display: {} },
  ];
  await plugin.enrichers![0].enrich(observations);
  assert.deepEqual(observations.map((o) => o.display.roomKey), ['mission:office-roadmap', 'mission:office-roadmap', undefined]);

  const world = await plugin.world![0].world(observations);
  assert.deepEqual(world.rooms!.map((r) => [r.key, r.state]).sort(),
    [['mission:office-roadmap', 'open'], ['mission:old-mission', 'locked'], ['mission:slug-check', 'open']].sort());
});

test('AC: a sleeper\'s session field is published as the engraved name only when it has a slug\'s own shape', async () => {
  const plugin = missionsPlugin([root]);
  const world = await plugin.world![0].world([]);
  const room = world.rooms!.find((r) => r.key === 'mission:slug-check')!;
  const byId = new Map(room.sleepers!.map((sleeper) => [sleeper.id, sleeper]));
  assert.equal(byId.get('J-1')?.name, 'tidy-otter');
  assert.equal(byId.get('J-2')?.name, undefined, 'a session field with a path-like value is not a slug');
  assert.equal(byId.get('J-3')?.name, undefined, 'a session field with underscores or capitals is not a slug');
});

test('without mission roots the plugin adds nothing', async () => {
  const plugin = missionsPlugin([]);
  const observations: Observation[] = [{ id: 's', provider: 'claude', name: 's', activity: 'idle', internal: {}, display: {} }];
  await plugin.enrichers![0].enrich(observations);
  assert.deepEqual(observations[0].display, {});
  assert.deepEqual((await plugin.world![0].world(observations)).rooms, []);
});
