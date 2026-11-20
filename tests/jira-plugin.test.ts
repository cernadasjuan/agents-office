import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { projectWorld } from '../server/seam.js';
import { createJiraPlugin } from '../plugins/jira/index.js';
import { JIRA_JQL, defaultReadFile, defaultStatFile, parseJiraSearchPage, resolveJiraCredentials } from '../plugins/jira/jira.js';

// Credential files live under a synthetic home, never Gabriel's real ~/.config.
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-office-jira-test-'));
after(() => fs.rmSync(fixture, { recursive: true, force: true }));

const NOW = Date.parse('2026-11-20T12:00:00Z');

const ENV = {
  AGENTS_OFFICE_JIRA_BASE_URL: 'https://beklever.atlassian.net',
  AGENTS_OFFICE_JIRA_EMAIL: 'gamyot@beklever.com',
  AGENTS_OFFICE_JIRA_TOKEN: 'super-secret-token-value',
};

function fakeReadFile(files: Record<string, string>): (filePath: string) => string {
  return (filePath) => {
    if (!(filePath in files)) throw new Error('ENOENT');
    return files[filePath];
  };
}

function fakeStatFile(files: Record<string, { size: number; isFile?: boolean }>) {
  const calls: string[] = [];
  const statFile = (filePath: string) => {
    calls.push(filePath);
    if (!(filePath in files)) throw new Error('ENOENT');
    const { size, isFile = true } = files[filePath];
    return { size, isFile: () => isFile };
  };
  return { statFile, calls };
}

function searchResponse(issues: Array<Record<string, unknown>>) {
  return { issues };
}

function issue(key: string, overrides: Record<string, unknown> = {}) {
  return {
    key,
    fields: {
      summary: `Summary of ${key}`,
      status: { name: 'In Progress' },
      priority: { name: 'High' },
      assignee: { displayName: 'Gabriel Amyot' },
      ...overrides,
    },
  };
}

interface FakeResponse { status: number; body?: unknown; brokenBody?: boolean }

/**
 * `respond` returns the next response: a plain body (200), a `{status, body}` pair, a
 * `{status, brokenBody: true}` pair (headers arrive fine, but `.json()` itself throws — a
 * malformed body or a stream that fails mid-read), or undefined (a network failure, no status).
 */
function fakeFetch(calls: Array<{ url: string; init: RequestInit }>, respond: () => FakeResponse | unknown | undefined): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    const result = respond();
    if (result === undefined) throw new Error('network failure');
    if (typeof result === 'object' && result !== null && 'status' in result) {
      const { status, body, brokenBody } = result as FakeResponse;
      const json = brokenBody ? async () => { throw new SyntaxError('Unexpected token in JSON'); } : async () => body;
      return { ok: status >= 200 && status < 300, status, json } as Response;
    }
    return { ok: true, status: 200, json: async () => result } as Response;
  }) as typeof fetch;
}

// --- Credential resolution ---

test('credentials come from the three environment variables when all three are set', () => {
  const credentials = resolveJiraCredentials(ENV, () => '/nonexistent', defaultReadFile);
  assert.deepEqual(credentials, { baseUrl: 'https://beklever.atlassian.net', email: 'gamyot@beklever.com', token: 'super-secret-token-value' });
});

test('a plain http base URL is accepted only for loopback, a local mock Jira for development (issue #145 review)', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    const credentials = resolveJiraCredentials({ ...ENV, AGENTS_OFFICE_JIRA_BASE_URL: `http://${host}:4321` }, () => '/nonexistent', defaultReadFile);
    assert.equal(credentials?.baseUrl, `http://${host}:4321`, `loopback host ${host}`);
  }
  assert.equal(resolveJiraCredentials({ ...ENV, AGENTS_OFFICE_JIRA_BASE_URL: 'http://jira.example.com' }, () => '/nonexistent', defaultReadFile), undefined,
    'plain http to a real host is still rejected');
});

test('a non-https base URL, or any of the three missing, falls through to the file, which is also absent: no credentials', () => {
  assert.equal(resolveJiraCredentials({ ...ENV, AGENTS_OFFICE_JIRA_BASE_URL: 'http://not-https.example' }, () => '/nonexistent', defaultReadFile), undefined);
  assert.equal(resolveJiraCredentials({ ...ENV, AGENTS_OFFICE_JIRA_EMAIL: undefined }, () => '/nonexistent', defaultReadFile), undefined);
  assert.equal(resolveJiraCredentials({ ...ENV, AGENTS_OFFICE_JIRA_TOKEN: '' }, () => '/nonexistent', defaultReadFile), undefined);
  assert.equal(resolveJiraCredentials({}, () => '/nonexistent', defaultReadFile), undefined);
});

test('without the environment variables, credentials come from the local file at the default path', () => {
  // The default path is `${homedir}/.config/agents-office/jira.json`.
  const home = path.join(fixture, 'home-default');
  const file = path.join(home, '.config', 'agents-office', 'jira.json');
  const body = JSON.stringify({ baseUrl: 'https://beklever.atlassian.net', email: 'g@x.com', token: 'tok' });
  const read = fakeReadFile({ [file]: body });
  const { statFile } = fakeStatFile({ [file]: { size: body.length } });
  assert.deepEqual(resolveJiraCredentials({}, () => home, read, statFile), { baseUrl: 'https://beklever.atlassian.net', email: 'g@x.com', token: 'tok' });
});

test('AGENTS_OFFICE_JIRA_CREDENTIALS_FILE overrides the default file path', () => {
  const file = path.join(fixture, 'custom-creds.json');
  const body = JSON.stringify({ baseUrl: 'https://beklever.atlassian.net', email: 'g@x.com', token: 'tok' });
  const read = fakeReadFile({ [file]: body });
  const { statFile } = fakeStatFile({ [file]: { size: body.length } });
  assert.deepEqual(
    resolveJiraCredentials({ AGENTS_OFFICE_JIRA_CREDENTIALS_FILE: file }, () => '/unused', read, statFile),
    { baseUrl: 'https://beklever.atlassian.net', email: 'g@x.com', token: 'tok' },
  );
});

test('a missing file, an oversized file, invalid JSON, or an incomplete object all resolve to no credentials', () => {
  const missing = path.join(fixture, 'missing.json');
  assert.equal(resolveJiraCredentials({ AGENTS_OFFICE_JIRA_CREDENTIALS_FILE: missing }, () => '/unused', defaultReadFile), undefined);

  const big = path.join(fixture, 'big.json');
  const read = fakeReadFile({ [big]: `{"baseUrl":"https://beklever.atlassian.net","email":"g@x.com","token":"${'x'.repeat(5000)}"}` });
  assert.equal(resolveJiraCredentials({ AGENTS_OFFICE_JIRA_CREDENTIALS_FILE: big }, () => '/unused', read), undefined);

  const badJson = path.join(fixture, 'bad.json');
  const readBad = fakeReadFile({ [badJson]: 'not json' });
  assert.equal(resolveJiraCredentials({ AGENTS_OFFICE_JIRA_CREDENTIALS_FILE: badJson }, () => '/unused', readBad), undefined);

  const partial = path.join(fixture, 'partial.json');
  const readPartial = fakeReadFile({ [partial]: JSON.stringify({ baseUrl: 'https://beklever.atlassian.net', email: 'g@x.com' }) });
  assert.equal(resolveJiraCredentials({ AGENTS_OFFICE_JIRA_CREDENTIALS_FILE: partial }, () => '/unused', readPartial), undefined);
});

test('an oversized file is never read: the size comes from stat, checked before the read (issue #145 review)', () => {
  const big = path.join(fixture, 'stat-big.json');
  const good = JSON.stringify({ baseUrl: 'https://beklever.atlassian.net', email: 'g@x.com', token: 'tok' });
  const read = fakeReadFile({ [big]: good }); // valid content: only the stat should stop this
  const { statFile, calls: statCalls } = fakeStatFile({ [big]: { size: 5000 } });
  let readCalled = false;
  const readSpy = (filePath: string) => { readCalled = true; return read(filePath); };

  assert.equal(resolveJiraCredentials({ AGENTS_OFFICE_JIRA_CREDENTIALS_FILE: big }, () => '/unused', readSpy, statFile), undefined);
  assert.equal(readCalled, false, 'the oversized file is never opened for reading');
  assert.deepEqual(statCalls, [big]);
});

test('a non-regular file (a socket, a directory, a symlink target) is never read, even at a small size', () => {
  const notAFile = path.join(fixture, 'stat-not-a-file');
  const read = fakeReadFile({ [notAFile]: JSON.stringify({ baseUrl: 'https://beklever.atlassian.net', email: 'g@x.com', token: 'tok' }) });
  const { statFile } = fakeStatFile({ [notAFile]: { size: 10, isFile: false } });
  let readCalled = false;
  const readSpy = (filePath: string) => { readCalled = true; return read(filePath); };

  assert.equal(resolveJiraCredentials({ AGENTS_OFFICE_JIRA_CREDENTIALS_FILE: notAFile }, () => '/unused', readSpy, statFile), undefined);
  assert.equal(readCalled, false);
});

test('a file that passes the stat check (a regular file, within the size cap) is read and parsed as before', () => {
  const ok = path.join(fixture, 'stat-ok.json');
  const read = fakeReadFile({ [ok]: JSON.stringify({ baseUrl: 'https://beklever.atlassian.net', email: 'g@x.com', token: 'tok' }) });
  const { statFile } = fakeStatFile({ [ok]: { size: 80 } });
  assert.deepEqual(
    resolveJiraCredentials({ AGENTS_OFFICE_JIRA_CREDENTIALS_FILE: ok }, () => '/unused', read, statFile),
    { baseUrl: 'https://beklever.atlassian.net', email: 'g@x.com', token: 'tok' },
  );
});

test('a stat failure (the file disappeared between calls, a permission error) resolves to no credentials, not a throw', () => {
  const gone = path.join(fixture, 'stat-gone.json');
  const statFile = () => { throw new Error('ENOENT'); };
  assert.equal(resolveJiraCredentials({ AGENTS_OFFICE_JIRA_CREDENTIALS_FILE: gone }, () => '/unused', defaultReadFile, statFile), undefined);
});

// --- Response parsing ---

test('a page of the search response is shape-checked: only issues with a key and a status name count', () => {
  assert.equal(parseJiraSearchPage('not an object', 'https://x'), undefined);
  assert.equal(parseJiraSearchPage({ noIssuesField: true }, 'https://x'), undefined);
  const page = parseJiraSearchPage(searchResponse([
    issue('KTP-1'),
    { key: 'KTP-2', fields: {} }, // no status: dropped
    { fields: { status: { name: 'Open' } } }, // no key: dropped
    issue('KTP-3', { priority: undefined, assignee: undefined }),
  ]), 'https://beklever.atlassian.net')!;
  assert.deepEqual(page.tickets.map((t) => t.key), ['KTP-1', 'KTP-3']);
  assert.equal(page.tickets[0].url, 'https://beklever.atlassian.net/browse/KTP-1');
  assert.equal(page.tickets[0].status, 'In Progress');
  assert.equal(page.tickets[0].priority, 'High');
  assert.equal(page.tickets[1].priority, undefined);
});

test('a page reports isLast from the response, or infers it when nextPageToken is absent', () => {
  assert.equal(parseJiraSearchPage({ issues: [], isLast: false, nextPageToken: 'abc' }, 'https://x')!.isLast, false);
  assert.equal(parseJiraSearchPage({ issues: [], isLast: false, nextPageToken: 'abc' }, 'https://x')!.nextPageToken, 'abc');
  // The search/jql endpoint has shipped without isLast in some responses; no nextPageToken means no more pages regardless.
  assert.equal(parseJiraSearchPage({ issues: [] }, 'https://x')!.isLast, true);
  assert.equal(parseJiraSearchPage({ issues: [], isLast: false }, 'https://x')!.isLast, true);
});

// --- The plugin: no credentials ---

test('without credentials the plugin adds no world provider and calls fetch zero times', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const plugin = createJiraPlugin({ env: {}, homedir: () => '/nonexistent', readFile: () => { throw new Error('no file'); },
    fetch: fakeFetch(calls, () => searchResponse([issue('KTP-1')])) });
  assert.equal(plugin.name, 'jira');
  assert.equal(plugin.world, undefined);
  assert.equal(calls.length, 0);
  assert.deepEqual(projectWorld([], [plugin.name], (raw) => raw).jiraTickets, []);
});

// --- The plugin: with credentials ---

async function worldParts(plugin: ReturnType<typeof createJiraPlugin>) {
  return Promise.all((plugin.world ?? []).map((provider) => provider.world([])));
}

test('the search call hits /rest/api/3/search/jql (the old /search endpoint answers 410 on Jira Cloud), with the open-sprint, assigned-to-me JQL, Basic auth and a timeout, never the token in the URL', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const plugin = createJiraPlugin({ env: ENV, now: () => NOW, fetch: fakeFetch(calls, () => searchResponse([issue('KTP-1')])) });
  await worldParts(plugin);

  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.origin, 'https://beklever.atlassian.net');
  assert.equal(url.pathname, '/rest/api/3/search/jql');
  assert.equal(url.searchParams.get('jql'), JIRA_JQL);
  assert.equal(url.searchParams.get('maxResults'), '50');
  assert.equal(calls[0].url.includes('super-secret-token-value'), false, 'the token never appears in the URL');
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Basic ${Buffer.from('gamyot@beklever.com:super-secret-token-value').toString('base64')}`);
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test('a 410 (the removed /search endpoint) gives no board, with one debug note and no secret in it', async () => {
  const debugLines: string[] = [];
  const debugSpy = (...args: unknown[]) => debugLines.push(args.join(' '));
  const originalDebug = console.debug;
  console.debug = debugSpy;
  try {
    const plugin = createJiraPlugin({ env: ENV, now: () => NOW, fetch: fakeFetch([], () => ({ status: 410, body: {} })) });
    assert.deepEqual(projectWorld(await worldParts(plugin), [plugin.name], (raw) => raw).jiraTickets, []);
    assert.equal(debugLines.length, 1, 'exactly one debug note');
    assert.ok(debugLines[0].includes('410'));
    assert.equal(debugLines[0].includes('super-secret-token-value'), false);
    assert.equal(debugLines[0].includes('gamyot@beklever.com'), false);
  } finally {
    console.debug = originalDebug;
  }
});

test('a 200 with a body that cannot be parsed (bad JSON, or a stream failing mid-read) gives no board on a cold start, with one debug note and no secret in it (issue #145 review)', async () => {
  const debugLines: string[] = [];
  const debugSpy = (...args: unknown[]) => debugLines.push(args.join(' '));
  const originalDebug = console.debug;
  console.debug = debugSpy;
  try {
    const plugin = createJiraPlugin({ env: ENV, now: () => NOW, fetch: fakeFetch([], () => ({ status: 200, brokenBody: true })) });
    assert.deepEqual(projectWorld(await worldParts(plugin), [plugin.name], (raw) => raw).jiraTickets, []);
    assert.equal(debugLines.length, 1, 'exactly one debug note');
    assert.equal(debugLines[0].includes('super-secret-token-value'), false);
    assert.equal(debugLines[0].includes('gamyot@beklever.com'), false);
  } finally {
    console.debug = originalDebug;
  }
});

test('a body that cannot be parsed keeps the last good list once one exists, with one debug note and no secret (issue #145 review)', async () => {
  let now = NOW;
  let broken = false;
  const debugLines: string[] = [];
  const debugSpy = (...args: unknown[]) => debugLines.push(args.join(' '));
  const originalDebug = console.debug;
  console.debug = debugSpy;
  try {
    const plugin = createJiraPlugin({ env: ENV, now: () => now,
      fetch: fakeFetch([], () => (broken ? { status: 200, brokenBody: true } : searchResponse([issue('KTP-1')]))) });

    assert.equal(projectWorld(await worldParts(plugin), [plugin.name], (raw) => raw).jiraTickets.length, 1, 'a good fetch seeds the cache');
    assert.equal(debugLines.length, 0);

    broken = true;
    now += 121_000;
    const projected = projectWorld(await worldParts(plugin), [plugin.name], (raw) => raw);
    assert.equal(projected.jiraTickets.length, 1, 'the last good list survives an unparseable body');
    assert.equal(projected.jiraTickets[0].key, 'KTP-1');
    assert.equal(debugLines.length, 1, 'exactly one debug note');
    assert.equal(debugLines[0].includes('super-secret-token-value'), false);
    assert.equal(debugLines[0].includes('gamyot@beklever.com'), false);
  } finally {
    console.debug = originalDebug;
  }
});

test('multiple pages combine into one ticket list, following nextPageToken, capped at 50 results', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let call = 0;
  const pageOne = { issues: Array.from({ length: 50 }, (_, i) => issue(`KTP-${i + 1}`)), isLast: false, nextPageToken: 'page-2' };
  const pageTwo = { issues: [issue('KTP-51'), issue('KTP-52')], isLast: true };
  const plugin = createJiraPlugin({ env: ENV, now: () => NOW, fetch: fakeFetch(calls, () => (call++ === 0 ? pageOne : pageTwo)) });
  const parts = await worldParts(plugin);

  assert.equal(calls.length, 1, 'the first page already reaches the 50-result cap: no second request is needed');
  const projected = projectWorld(parts, [plugin.name], (raw) => raw);
  assert.equal(projected.jiraTickets.length, 50);
  assert.equal(projected.jiraTickets[0].key, 'KTP-1');
});

test('a short first page is followed by a second page, using its nextPageToken', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let call = 0;
  const pageOne = { issues: [issue('KTP-1')], isLast: false, nextPageToken: 'page-2' };
  const pageTwo = { issues: [issue('KTP-2')], isLast: true };
  const plugin = createJiraPlugin({ env: ENV, now: () => NOW, fetch: fakeFetch(calls, () => (call++ === 0 ? pageOne : pageTwo)) });
  const parts = await worldParts(plugin);

  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[1].url).searchParams.get('nextPageToken'), 'page-2');
  const projected = projectWorld(parts, [plugin.name], (raw) => raw);
  assert.deepEqual(projected.jiraTickets.map((t) => t.key), ['KTP-1', 'KTP-2']);
});

test('pagination is capped at a fixed number of pages even if the API never reports isLast', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let call = 0;
  const plugin = createJiraPlugin({ env: ENV, now: () => NOW, fetch: fakeFetch(calls, () => {
    call++;
    return { issues: [issue(`KTP-${call}`)], isLast: false, nextPageToken: `page-${call + 1}` };
  }) });
  await worldParts(plugin);

  assert.ok(calls.length <= 3, `pagination stops well short of looping forever (${calls.length} calls)`);
});

test('the projected world has the key, summary, status, priority and link, and no token anywhere in it', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const plugin = createJiraPlugin({ env: ENV, now: () => NOW, fetch: fakeFetch(calls, () => searchResponse([issue('KTP-9')])) });
  const parts = await worldParts(plugin);
  const projected = projectWorld(parts, [plugin.name], (raw) => raw);

  assert.deepEqual(projected.jiraTickets, [{
    key: 'KTP-9', summary: 'Summary of KTP-9', status: 'In Progress', assignee: 'Gabriel Amyot', priority: 'High',
    url: 'https://beklever.atlassian.net/browse/KTP-9',
  }]);
  const text = JSON.stringify(projected);
  assert.equal(text.includes('super-secret-token-value'), false, 'the token never leaves the server');
  assert.equal(text.includes('gamyot@beklever.com'), false, 'the email never leaves the server either');
});

test('results are cached for 2 minutes; a later call within the window makes no new request', async () => {
  let now = NOW;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const plugin = createJiraPlugin({ env: ENV, now: () => now, fetch: fakeFetch(calls, () => searchResponse([issue('KTP-1')])) });

  await worldParts(plugin);
  await worldParts(plugin);
  now += 60_000;
  await worldParts(plugin);
  assert.equal(calls.length, 1);

  now += 61_000;
  await worldParts(plugin);
  assert.equal(calls.length, 2);
});

test('a failed fetch gives no board the first time, and keeps the last good tickets after that', async () => {
  let now = NOW;
  let fail = true;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const plugin = createJiraPlugin({ env: ENV, now: () => now,
    fetch: fakeFetch(calls, () => (fail ? undefined : searchResponse([issue('KTP-1')]))) });

  assert.deepEqual(projectWorld(await worldParts(plugin), [plugin.name], (raw) => raw).jiraTickets, []);

  fail = false;
  now += 121_000;
  assert.equal(projectWorld(await worldParts(plugin), [plugin.name], (raw) => raw).jiraTickets.length, 1);

  fail = true;
  now += 121_000;
  assert.equal(projectWorld(await worldParts(plugin), [plugin.name], (raw) => raw).jiraTickets.length, 1, 'the last good list survives a later failure');
});

test('an empty sprint (zero issues) is the same as no board: the world call adds nothing', async () => {
  const plugin = createJiraPlugin({ env: ENV, now: () => NOW, fetch: fakeFetch([], () => searchResponse([])) });
  assert.deepEqual(await worldParts(plugin), [{}]);
});

// --- Whitelist (server/seam.ts) ---

test('projectWorld drops a ticket with a malformed key, caps field lengths, and caps the ticket count', () => {
  const longSummary = 'x'.repeat(200);
  const parts = [{
    jiraTickets: [
      { key: 'not-a-valid-key', summary: 'x', status: 'Open' },
      { key: 'KTP-1', summary: longSummary, status: 'Open', priority: 'y'.repeat(100), assignee: 'z'.repeat(100) },
      ...Array.from({ length: 60 }, (_, i) => ({ key: `KTP-${100 + i}`, summary: 's', status: 'Open' })),
    ],
  }];
  const projected = projectWorld(parts, ['jira'], (raw) => raw);
  assert.equal(projected.jiraTickets.some((t) => t.key === 'not-a-valid-key'), false);
  const ktp1 = projected.jiraTickets.find((t) => t.key === 'KTP-1')!;
  assert.ok(ktp1.summary.length <= 80);
  assert.ok(ktp1.priority!.length <= 16);
  assert.ok(ktp1.assignee!.length <= 40);
  assert.ok(projected.jiraTickets.length <= 50);
});

test('a ticket with no status, or a non-https url, is dropped or stripped', () => {
  const projected = projectWorld([{ jiraTickets: [
    { key: 'KTP-1', summary: 's', status: '' },
    { key: 'KTP-2', summary: 's', status: 'Open', url: 'http://not-https.example/browse/KTP-2' },
  ] }], ['jira'], (raw) => raw);
  assert.equal(projected.jiraTickets.some((t) => t.key === 'KTP-1'), false);
  const ktp2 = projected.jiraTickets.find((t) => t.key === 'KTP-2')!;
  assert.equal(ktp2.url, undefined);
});
