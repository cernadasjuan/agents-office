import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { Observation, OfficePlugin } from '../server/seam.js';
import { orderByEnricherPriority } from '../server/vitePlugin.js';
import { createBmadEnricher } from '../plugins/bmad/index.js';
import { libraryPlugin, parseLibrarianTypes } from '../plugins/library/index.js';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-office-enricher-priority-'));
after(() => fs.rmSync(fixture, { recursive: true, force: true }));

// --- Pure sort behavior ---

test('orderByEnricherPriority stably sorts lower priorities first, default 0, never reordering equal priorities', () => {
  const make = (name: string, enricherPriority?: number): OfficePlugin => ({ name, ...(enricherPriority !== undefined ? { enricherPriority } : {}) });
  const ordered = orderByEnricherPriority([make('c'), make('a', -10), make('d'), make('b', -10)]);
  assert.deepEqual(ordered.map((plugin) => plugin.name), ['a', 'b', 'c', 'd']);
});

test('orderByEnricherPriority never mutates the input array', () => {
  const plugins: OfficePlugin[] = [{ name: 'z' }, { name: 'a', enricherPriority: -1 }];
  const original = [...plugins];
  orderByEnricherPriority(plugins);
  assert.deepEqual(plugins, original);
});

// --- Issue #253 review: the actual bmad -> library dependency, registered out of order ---

function transcriptWith(agentCall: string): string {
  const transcriptPath = path.join(fixture, `${Math.random().toString(36).slice(2)}.jsonl`);
  const line = JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: agentCall } }] } });
  fs.writeFileSync(transcriptPath, `${line}\n`);
  return transcriptPath;
}

function librarianSession(): Observation {
  return {
    id: 'prospero-session',
    provider: 'claude',
    name: 'Prospero Session',
    activity: 'researching',
    internal: { transcriptPath: transcriptWith('bmad.py agent librarian') },
    display: {},
  };
}

async function runEnrichers(plugins: OfficePlugin[], observations: Observation[]): Promise<void> {
  for (const plugin of plugins) {
    for (const enricher of plugin.enrichers ?? []) await enricher.enrich(observations);
  }
}

test('issue #253 review: bmad\'s own enricherPriority makes the librarian role land correctly even when library is registered before bmad', async () => {
  const bmad: OfficePlugin = { name: 'bmad', enrichers: [createBmadEnricher()], enricherPriority: -10 };
  const library = libraryPlugin(parseLibrarianTypes(undefined));
  const observations = [librarianSession()];

  // Registered in the "wrong" order on purpose — AGENTS_OFFICE_PLUGINS gives no guarantee here.
  const registeredOutOfOrder = [library, bmad];
  await runEnrichers(orderByEnricherPriority(registeredOutOfOrder), observations);

  assert.equal(observations[0]!.display.role, 'librarian', 'bmad\'s enricher still ran first, so library saw the badge it needs');
});

test('issue #253 review: without the priority fix, the same out-of-order registration silently drops the role (the bug this round fixed)', async () => {
  const bmad: OfficePlugin = { name: 'bmad', enrichers: [createBmadEnricher()] }; // no enricherPriority: the old, unprotected shape
  const library = libraryPlugin(parseLibrarianTypes(undefined));
  const observations = [librarianSession()];

  // No orderByEnricherPriority call at all: plain registration order, library first.
  await runEnrichers([library, bmad], observations);

  assert.notEqual(observations[0]!.display.role, 'librarian', 'library ran before bmad ever set the badge, so it never saw it — the exact failure mode this round fixed');
});
