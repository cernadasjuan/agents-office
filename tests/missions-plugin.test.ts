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

test('a mission record becomes room walls: statement, docs, issues, kanban and past sessions', () => {
  const [mission] = readMissions([root]).filter((m) => m.slug === 'office-roadmap');
  assert.equal(mission.title, 'Office roadmap');
  assert.equal(mission.state, 'open');
  assert.equal(mission.statement, 'Every slice merged.');
  assert.deepEqual(mission.docs, ['Design explainer']);
  assert.deepEqual(mission.issues, [{ number: 46, title: 'Roadmap parent', state: 'open' }, { number: 11, title: 'Fixes', state: 'closed' }]);
  assert.deepEqual(mission.kanban.map((c) => [c.column, c.cards.map((card) => card.number)]), [['Needs you', [2]], ['Open', [1]], ['Done', [3]]]);
  assert.deepEqual(mission.sleepers, [{ id: 'J-1', endedAt: '2026-11-18T19:40:00Z' }, { id: 'J-2' }]);
});

test('a session entry with no id does not become a tombstone', () => {
  const mission = summarizeMission('no-id', { title: 'No id', status: 'active', journey: [{ kind: 'session' }, { id: 'J-1', kind: 'session' }] });
  assert.deepEqual(mission?.sleepers, [{ id: 'J-1' }]);
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
  assert.deepEqual(world.rooms!.map((r) => [r.key, r.state]).sort(), [['mission:office-roadmap', 'open'], ['mission:old-mission', 'locked']].sort());
});

test('without mission roots the plugin adds nothing', async () => {
  const plugin = missionsPlugin([]);
  const observations: Observation[] = [{ id: 's', provider: 'claude', name: 's', activity: 'idle', internal: {}, display: {} }];
  await plugin.enrichers![0].enrich(observations);
  assert.deepEqual(observations[0].display, {});
  assert.deepEqual((await plugin.world![0].world(observations)).rooms, []);
});
