import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer, type ViteDevServer } from 'vite';
import { observe, projectAgents, projectWorld, type Observation, type OfficePlugin } from '../server/seam.js';
import { parsePluginNames, pluginEntry } from '../server/plugins.js';
import { agentDetectorPlugin } from '../server/vitePlugin.js';
import type { DetectedAgent } from '../server/agentDetector.js';

const publicId = (raw: string) => `h(${raw})`;

function observation(overrides: Partial<Observation> = {}): Observation {
  return { id: 'raw-session', provider: 'claude', name: 'agent', activity: 'researching',
    internal: { pid: 4242, cwd: '/private/project', sessionId: 'raw-session' }, display: {}, ...overrides };
}

test('the agent projection copies only whitelisted, cleaned fields', () => {
  const [agent] = projectAgents([observation({
    name: `evil\u0007${'x'.repeat(100)}`,
    activity: 'hacking',
    provider: 'codex',
    display: { attention: 'panic' as never, waitMinutes: -3, groupKey: 'workspace-7', groupLabel: 'Team\nA',
      badges: ['sally', 'BAD BADGE', '../x'], issues: [{ number: 31, title: 'Seam' }, { number: -1, title: 'bad' }],
      roomKey: 'mission-1' },
  })], publicId);

  assert.equal(agent.name.length, 60);
  assert.ok(!agent.name.includes('\u0007'));
  assert.equal(agent.activity, 'implementing');
  assert.equal(agent.provider, 'codex');
  assert.equal('attention' in agent, false);
  assert.equal('waitMinutes' in agent, false);
  assert.deepEqual(agent.group, { id: 'h(group:workspace-7)', label: 'Team A' });
  assert.deepEqual(agent.badges, ['sally']);
  assert.deepEqual(agent.issues, [{ number: 31, title: 'Seam' }]);
  assert.equal(agent.room, 'h(room:mission-1)');
  assert.equal(JSON.stringify(agent).includes('/private/project'), false);
  assert.equal(JSON.stringify(agent).includes('4242'), false);
});

test('orchestrating projects only alongside your-turn, never alone and never under a waiting block (issue #168)', () => {
  const [yourTurn] = projectAgents([observation({ display: { attention: 'your-turn', orchestrating: true } })], publicId);
  assert.equal(yourTurn.orchestrating, true);

  const [waiting] = projectAgents([observation({ display: { attention: 'waiting', orchestrating: true } as never })], publicId);
  assert.equal('orchestrating' in waiting, false, 'a true block on the user never reads as orchestrating, whatever upstream data claims');

  const [plain] = projectAgents([observation({ display: { attention: 'your-turn' } })], publicId);
  assert.equal('orchestrating' in plain, false);
});

test('skills keeps only plain string tokens, dropping a non-string value even if it would pass the pattern once coerced to a string (issue #166 review)', () => {
  const [agent] = projectAgents([observation({
    display: { skills: ['write-a-skill', 'BAD SKILL', null, 42, true, ['nested']] as never },
  })], publicId);

  assert.deepEqual(agent.skills, ['write-a-skill']);
  assert.ok(agent.skills!.every((skill) => typeof skill === 'string'));
});

test('tools keeps only allow-listed tool names, dropping anything else (issue #167 round 2)', () => {
  const [agent] = projectAgents([observation({
    display: { tools: ['Bash', 'Read', 'NotAllowed', null, 42, 'rm -rf /'] as never },
  })], publicId);

  assert.deepEqual(agent.tools, ['Bash', 'Read']);
});

test('skills past the 8-entry cap keeps the most recent 8, not the first 8 (issue #167 round 2 review: defense in depth against an enricher that forgets to pre-cap)', () => {
  const [agent] = projectAgents([observation({
    display: { skills: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] },
  })], publicId);

  assert.deepEqual(agent.skills, ['b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']);
});

test('lastEquipSource projects only "skill" or "tool", dropping any other value (issue #167 round 2)', () => {
  const [skill] = projectAgents([observation({ display: { lastEquipSource: 'skill' } })], publicId);
  assert.equal(skill.lastEquipSource, 'skill');

  const [tool] = projectAgents([observation({ display: { lastEquipSource: 'tool' } })], publicId);
  assert.equal(tool.lastEquipSource, 'tool');

  const [bad] = projectAgents([observation({ display: { lastEquipSource: 'whatever' as never } })], publicId);
  assert.equal('lastEquipSource' in bad, false);
});

test('an issue card keeps only a cleaned short repository token', () => {
  const [agent] = projectAgents([observation({ display: { issues: [
    { number: 1, title: 'a', repo: 'agents-office' },
    { number: 2, title: 'b', repo: 'owner/inner/short.name' },
    { number: 3, title: 'c', repo: '<img src=x>' },
    { number: 4, title: 'd', repo: '..' },
    { number: 5, title: 'e', repo: 'x'.repeat(41) },
  ] } })], publicId);

  assert.deepEqual(agent.issues, [
    { number: 1, title: 'a', repo: 'agents-office' },
    { number: 2, title: 'b', repo: 'short.name' },
    { number: 3, title: 'c' },
    { number: 4, title: 'd' },
    { number: 5, title: 'e' },
  ]);
});

test('floor keeps a cleaned single-segment or org-qualified two-segment token, never a path with more than one slash (issue #118)', () => {
  const floorOf = (floor: unknown) => projectAgents([observation({ display: { floor: floor as string } })], publicId)[0].floor;

  assert.equal(floorOf('agents-office'), 'agents-office');
  assert.equal(floorOf('general'), 'general');
  assert.equal(floorOf('gabriel-amyot/agents-office'), 'gabriel-amyot/agents-office');
  assert.equal(floorOf('grp-beklever-com/project-management'), 'grp-beklever-com/project-management');
  assert.equal(floorOf('a/b/c'), undefined, 'more than one slash is never kept, not even shortened to its tail');
  assert.equal(floorOf('<img src=x>'), undefined);
  assert.equal(floorOf('..'), undefined);
  assert.equal(floorOf('a/..'), undefined);
  assert.equal(floorOf('../a'), undefined);
  assert.equal(floorOf('x'.repeat(41)), undefined);
  assert.equal(floorOf(undefined), undefined);
});

test('an issue card keeps a label color only as a cleaned 6-hex token', () => {
  const cleaned = (color: unknown) => projectAgents([observation({ display: { issues: [
    { number: 1, title: 'a', color: color as string },
  ] } })], publicId)[0].issues![0].color;

  assert.equal(cleaned('D73A4A'), 'd73a4a');
  assert.equal(cleaned('#0e8a16'), '0e8a16');
  for (const bad of ['red', 'fff', '1234567', '<b>abcdef', 'abcdef;', 0xabcdef, null]) {
    assert.equal(cleaned(bad), undefined, `refused: ${String(bad)}`);
  }
});

test('a plain Claude agent keeps the original three fields', () => {
  assert.deepEqual(Object.keys(projectAgents([observation()], publicId)[0]).sort(), ['activity', 'id', 'name']);
});

test('a failing or slow plugin step drops only its own output', async () => {
  const core = { id: 'core', scan: () => [observation()] };
  const broken = { id: 'broken', scan: () => { throw new Error('boom'); } };
  const marker = { id: 'marker', enrich: (list: Observation[]) => { list[0].display.badges = ['seen']; } };
  const hanging = { id: 'hanging', enrich: () => new Promise<void>(() => undefined) };

  const result = await observe(core, [broken], [hanging, marker]);

  assert.equal(result.length, 1);
  assert.deepEqual(result[0].display.badges, ['seen']);
});

test('a core source failure is an error', async () => {
  await assert.rejects(observe({ id: 'core', scan: () => { throw new Error('boom'); } }, [], []));
});

test('the world projection cleans rooms and boards and hashes their keys', () => {
  const world = projectWorld([{ rooms: [{ key: 'm-1', kind: 'mission', title: 'War\troom', state: 'locked',
    sleepers: [{ id: 'J-1', endedAt: '2026-11-18T19:40:00Z' }, { id: '' }, { id: 'J-2' }],
    walls: { statement: 'Ship it', issues: [{ number: 7, title: 'Fix', state: 'closed' }], kanban: [{ column: 'Doing', cards: [{ number: 8, title: 'Card' }] }] } }],
    boards: [{ key: 'b', title: 'Board', columns: [{ name: 'Todo', cards: [{ number: 1.5, title: 'bad' }] }] }] }],
  ['missions', 'Bad Name'], publicId);

  assert.deepEqual(world.plugins, ['missions']);
  assert.equal(world.rooms[0].id, 'h(room:m-1)');
  assert.equal(world.rooms[0].title, 'War room');
  // A blank id is dropped; a raw journey id is hashed (never sent raw); a time-of-day is cut to the day
  assert.deepEqual(world.rooms[0].sleepers, [{ id: 'h(sleeper:m-1:J-1)', endedAt: '2026-11-18' }, { id: 'h(sleeper:m-1:J-2)' }]);
  assert.equal(world.rooms[0].state, 'locked');
  assert.deepEqual(world.rooms[0].walls.kanban, [{ column: 'Doing', cards: [{ number: 8, title: 'Card' }] }]);
  assert.deepEqual(world.boards[0].columns[0].cards, []);
});

// --- Issue #159/#160: engraved name and tombstone story, whitelisted and capped ---

test('a sleeper\'s name is capped display text; without one, the output carries no name key', () => {
  const world = projectWorld([{ rooms: [{ key: 'm-1', kind: 'mission', title: 'War room', state: 'open',
    sleepers: [{ id: 'J-1', name: 'tidy-otter' }, { id: 'J-2' }] }] }], ['missions'], publicId);
  assert.deepEqual(world.rooms[0].sleepers, [{ id: 'h(sleeper:m-1:J-1)', name: 'tidy-otter' }, { id: 'h(sleeper:m-1:J-2)' }]);
});

test('a story keeps only known personas, caps every list, and always carries an issues key once present', () => {
  const world = projectWorld([{ rooms: [{ key: 'm-1', kind: 'mission', title: 'War room', state: 'open',
    sleepers: [{ id: 'J-1', name: 'tidy-otter', story: {
      intent: 'Fix the git situation safely',
      personas: ['Amelia', 'NotAPersona', 'Amelia'],
      counts: { done: 11, open: 0, abandoned: 0 },
      doneList: Array.from({ length: 20 }, (_, i) => `item ${i}`),
      handoffs: ['/etc/passwd', '2026-11-17-handoff.md'],
      issues: [{ label: 'gabriel-amyot/agents-office#160', url: 'https://github.com/gabriel-amyot/agents-office/issues/160' }, { label: '' }],
    } }] }] }], ['missions'], publicId);

  const story = world.rooms[0].sleepers![0].story;
  assert.deepEqual(story?.personas, ['Amelia']);
  assert.deepEqual(story?.counts, { done: 11, open: 0, abandoned: 0 });
  assert.equal(story?.doneList?.length, 8);
  // A handoff is a file name, never a path (issue #160): only the last path segment survives.
  assert.deepEqual(story?.handoffs, ['passwd', '2026-11-17-handoff.md']);
  // A blank label drops (review round 2: the seam never trusts the reader's own resolution
  // blindly, same as personas and the sleeper name); a real one keeps its resolved link.
  assert.deepEqual(story?.issues, [{ label: 'gabriel-amyot/agents-office#160', url: 'https://github.com/gabriel-amyot/agents-office/issues/160' }]);
});

test('review round 2: an issue with no resolvable owner still shows as plain text, and an unsafe url is dropped, not the whole issue', () => {
  const world = projectWorld([{ rooms: [{ key: 'm-1', kind: 'mission', title: 'War room', state: 'open',
    sleepers: [{ id: 'J-1', name: 'tidy-otter', story: {
      intent: 'x',
      issues: [{ label: 'agents-office#160' }, { label: 'KTP-951' }, { label: 'owner/repo#5', url: 'javascript:alert(1)' }],
    } }] }] }], ['missions'], publicId);
  assert.deepEqual(world.rooms[0].sleepers![0].story?.issues, [
    { label: 'agents-office#160' },
    { label: 'KTP-951' },
    { label: 'owner/repo#5' },
  ]);
});

test('a sleeper with no story at all carries no story key (the card tells the difference from zero issues)', () => {
  const world = projectWorld([{ rooms: [{ key: 'm-1', kind: 'mission', title: 'War room', state: 'open',
    sleepers: [{ id: 'J-1', name: 'tidy-otter' }] }] }], ['missions'], publicId);
  assert.ok(!('story' in world.rooms[0].sleepers![0]));
});

test('review round 1: a name that is not a clean slug never reaches the client', () => {
  const world = projectWorld([{ rooms: [{ key: 'm-1', kind: 'mission', title: 'War room', state: 'open',
    sleepers: [
      { id: 'J-1', name: '../escape' },
      { id: 'J-2', name: 'Not_A_Slug' },
      { id: 'J-3', name: 'a-clean-slug' },
    ] }] }], ['missions'], publicId);
  const byId = new Map(world.rooms[0].sleepers!.map((sleeper) => [sleeper.id, sleeper]));
  assert.equal(byId.get('h(sleeper:m-1:J-1)')?.name, undefined);
  assert.equal(byId.get('h(sleeper:m-1:J-2)')?.name, undefined);
  assert.equal(byId.get('h(sleeper:m-1:J-3)')?.name, 'a-clean-slug');
});

test('review round 1: a path mentioned in free-text story fields is redacted, not just truncated', () => {
  const world = projectWorld([{ rooms: [{ key: 'm-1', kind: 'mission', title: 'War room', state: 'open',
    sleepers: [{ id: 'J-1', name: 'tidy-otter', story: {
      intent: 'Fix the git situation in ~/.claude-shared-config safely',
      doneList: ['Read /Users/gamyot/Developer/project/file.ts', 'Opened file:///etc/hosts', 'A plain line'],
    } }] }] }], ['missions'], publicId);
  const story = world.rooms[0].sleepers![0].story;
  assert.equal(story?.intent, 'Fix the git situation in [path] safely');
  assert.deepEqual(story?.doneList, ['Read [path]', 'Opened [path]', 'A plain line']);
});

test('review round 2: a single-segment absolute path and a relative path are also redacted', () => {
  const world = projectWorld([{ rooms: [{ key: 'm-1', kind: 'mission', title: 'War room', state: 'open',
    sleepers: [{ id: 'J-1', name: 'tidy-otter', story: {
      intent: 'Wrote a file under /tmp then checked /etc for the config',
      doneList: ['Ran ./build.sh', 'Compared against ../baseline/out.json', 'A plain line with no path at all', '50/50 split, not a path'],
    } }] }] }], ['missions'], publicId);
  const story = world.rooms[0].sleepers![0].story;
  assert.equal(story?.intent, 'Wrote a file under [path] then checked [path] for the config');
  assert.deepEqual(story?.doneList, ['Ran [path]', 'Compared against [path]', 'A plain line with no path at all', '50/50 split, not a path']);
});

test('review round 2 follow-up: a quoted, backticked or env-assigned path is redacted too', () => {
  const world = projectWorld([{ rooms: [{ key: 'm-1', kind: 'mission', title: 'War room', state: 'open',
    sleepers: [{ id: 'J-1', name: 'tidy-otter', story: {
      intent: 'Set TMPDIR=/private/tmp before running the build',
      doneList: ['Read "/tmp" for the scratch file', 'Checked `/etc` for the config', '3/4 of the work is done, not a path'],
    } }] }] }], ['missions'], publicId);
  const story = world.rooms[0].sleepers![0].story;
  assert.equal(story?.intent, 'Set TMPDIR=[path] before running the build');
  assert.deepEqual(story?.doneList, ['Read "[path]" for the scratch file', 'Checked `[path]` for the config', '3/4 of the work is done, not a path']);
});

test('a mission issue keeps a clean owner/repo, and drops one that does not match the shape (#146)', () => {
  const world = projectWorld([{ rooms: [{ key: 'm-1', kind: 'mission', title: 'War room', state: 'open',
    walls: { issues: [
      { number: 46, title: 'Roadmap', state: 'open', repo: 'gabriel-amyot/agents-office' },
      { number: 7, title: 'No repo match', state: 'open', repo: '../etc/passwd' },
      { number: 8, title: 'Bare, no repo field', state: 'closed' },
    ] } }] }],
  ['missions'], publicId);

  assert.deepEqual(world.rooms[0].walls.issues, [
    { number: 46, title: 'Roadmap', state: 'open', repo: 'gabriel-amyot/agents-office' },
    { number: 7, title: 'No repo match', state: 'open' },
    { number: 8, title: 'Bare, no repo field', state: 'closed' },
  ]);
});

// --- Issue #191: a room/board's own `repo` tag (RoomInput/BoardInput) ---

test('a room or board keeps a clean owner/repo tag, or a bare short name, and drops anything else', () => {
  const world = projectWorld([
    { rooms: [{ key: 'm-1', kind: 'mission', title: 'Clean owner/repo', state: 'open', repo: 'gabriel-amyot/agents-office', walls: {} }] },
    { rooms: [{ key: 'm-2', kind: 'mission', title: 'Bare short name', state: 'open', repo: 'agents-office', walls: {} }] },
    { boards: [{ key: 'b-1', title: 'Clean board', columns: [], repo: 'gabriel-amyot/agents-office' }] },
  ], ['missions', 'github'], publicId);

  assert.equal(world.rooms[0].repo, 'gabriel-amyot/agents-office');
  assert.equal(world.rooms[1].repo, 'agents-office');
  assert.equal(world.boards[0].repo, 'gabriel-amyot/agents-office');
});

test('a repo tag with a "." or ".." segment is dropped, never reaching the client (issue #191 review nit: the owner/repo whitelist only rejected the literal "./.", not a general relative segment)', () => {
  const world = projectWorld([
    { rooms: [{ key: 'm-1', kind: 'mission', title: 'Dotdot owner', state: 'open', repo: '../private', walls: {} }] },
    { rooms: [{ key: 'm-2', kind: 'mission', title: 'Dot owner', state: 'open', repo: './secret', walls: {} }] },
    { rooms: [{ key: 'm-3', kind: 'mission', title: 'Dotdot repo', state: 'open', repo: 'owner/..', walls: {} }] },
    { boards: [{ key: 'b-1', title: 'Dotdot board', columns: [], repo: '../private' }] },
  ], ['missions', 'github'], publicId);

  assert.equal('repo' in world.rooms[0], false);
  assert.equal('repo' in world.rooms[1], false);
  assert.equal('repo' in world.rooms[2], false);
  assert.equal('repo' in world.boards[0], false);
});

// --- Issue #191/#119: a floor library's own sections, whitelisted and capped ---

test('a library section and entry are cleaned and capped, and a key is hashed, never sent raw', () => {
  const world = projectWorld([{ libraries: [{
    key: '/Users/gab/project-management',
    sections: [{ name: 'vendors', entries: [{ title: 'Placer.ai', archived: true }], truncated: true }],
    repo: 'org/project-management',
  }] }], ['floor-library'], publicId);

  assert.deepEqual(world.libraries, [{
    id: 'h(library:/Users/gab/project-management)',
    sections: [{ name: 'vendors', entries: [{ title: 'Placer.ai', archived: true }], truncated: true }],
    repo: 'org/project-management',
  }]);
});

test('a section name or entry title that reads as a filesystem path is redacted before it crosses (S4: never a path, even one typed as a title by mistake)', () => {
  const world = projectWorld([{ libraries: [{
    key: 'root',
    sections: [{ name: 'vendors', entries: [{ title: '/Users/alice/private-plan.md' }] }] }] }],
  ['floor-library'], publicId);

  assert.equal(world.libraries[0].sections[0].entries[0].title, '[path]');
});

test('plugin names cannot leave the plugins folder', () => {
  assert.deepEqual(parsePluginNames('herdr, ../etc,missions,herdr,BAD'), ['herdr', 'missions']);
  assert.equal(pluginEntry('/tmp/plugins', '../escape'), null);
  assert.equal(pluginEntry('/tmp/plugins', 'missing'), null);
});

// --- HTTP: the world endpoint has the same boundary as the agent endpoint ---

const resources: Array<{ server: ViteDevServer; root: string }> = [];
after(async () => {
  for (const { server, root } of resources) {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

const record: DetectedAgent = { id: 'private-session', name: 'agent', pid: 1, cwd: '/private', startedAt: 1, alive: true, activity: 'meeting' };
const testPlugin: OfficePlugin = {
  name: 'test-plugin',
  enrichers: [{ id: 'attention', enrich: (list) => { for (const agent of list) agent.display.attention = 'waiting'; } }],
  world: [{ id: 'rooms', world: () => ({ rooms: [{ key: 'mission-x', kind: 'mission', title: 'Mission X', state: 'open' }] }) }],
};

async function server() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agents-office-seam-test-'));
  const vite = await createServer({ root, configFile: false, envFile: false,
    plugins: [agentDetectorPlugin({ detect: () => [record], plugins: [testPlugin], codexHome: null })],
    server: { host: '127.0.0.1', port: 0, open: false, watch: null, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] }, logLevel: 'silent' });
  resources.push({ server: vite, root });
  await vite.listen();
  const port = (vite.httpServer!.address() as AddressInfo).port;
  return (route: string, headers: Record<string, string> = {}, method = 'GET') =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: route, method, headers }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode!, body }));
      });
      req.on('error', reject);
      req.end();
    });
}

test('plugins add whitelisted agent fields and world rooms over HTTP, behind the same checks', async () => {
  const request = await server();

  const agents = JSON.parse((await request('/api/agents')).body);
  assert.equal(agents[0].attention, 'waiting');
  const world = JSON.parse((await request('/api/world')).body);
  assert.deepEqual(world.plugins, ['test-plugin']);
  assert.equal(world.rooms[0].title, 'Mission X');
  assert.equal((await request('/api/world', { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await request('/api/world', {}, 'POST')).status, 405);
  assert.equal((await request('/api/world', { Host: 'evil.example' })).status, 403);
});
