import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Observation } from '../server/seam.js';
import { createSkillsEnricher } from '../plugins/skills/index.js';

/**
 * Server-side coverage for `plugins/skills/index.ts` (issue #166, extended issue #167
 * round 2): the `Skill` tool tracking already shipped with no dedicated test of its own
 * (only the seam whitelist was tested); this file covers both halves together, since the
 * new tool-allowlist tracking shares all of its parsing and caching machinery.
 */

function toolUseLine(blocks: Array<{ name: string; input?: Record<string, unknown> }>): string {
  return JSON.stringify({ message: { role: 'assistant', content: blocks.map((b) => ({ type: 'tool_use', name: b.name, input: b.input ?? {} })) } });
}

function observation(id: string, transcriptPath: string): Observation {
  return { id, provider: 'claude', name: id, activity: 'implementing', internal: { transcriptPath }, display: {} };
}

async function withTranscript(lines: string[], fn: (transcriptPath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'skills-enricher-'));
  const transcriptPath = path.join(dir, 'session.jsonl');
  try {
    await writeFile(transcriptPath, lines.map((line) => `${line}\n`).join(''));
    await fn(transcriptPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('a Skill tool call sets display.skills, newest-introduced last', async () => {
  await withTranscript([
    toolUseLine([{ name: 'Skill', input: { skill: 'git' } }]),
    toolUseLine([{ name: 'Skill', input: { skill: 'jira' } }]),
  ], async (transcriptPath) => {
    const enricher = createSkillsEnricher();
    const agents = [observation('a', transcriptPath)];
    await enricher.enrich(agents);
    assert.deepEqual(agents[0].display.skills, ['git', 'jira']);
    assert.equal(agents[0].display.lastEquipSource, 'skill');
  });
});

test('an allow-listed tool call sets display.tools; a non-allow-listed one is ignored', async () => {
  await withTranscript([
    toolUseLine([{ name: 'Bash', input: { command: 'ls' } }]),
    toolUseLine([{ name: 'TodoWrite', input: {} }]),
    toolUseLine([{ name: 'Read', input: { file_path: '/x' } }]),
  ], async (transcriptPath) => {
    const enricher = createSkillsEnricher();
    const agents = [observation('a', transcriptPath)];
    await enricher.enrich(agents);
    assert.deepEqual(agents[0].display.tools, ['Bash', 'Read']);
    assert.equal(agents[0].display.lastEquipSource, 'tool');
  });
});

test('lastEquipSource reflects true chronological order across both lists, not just whichever is checked last', async () => {
  await withTranscript([
    toolUseLine([{ name: 'Bash' }]),
    toolUseLine([{ name: 'Skill', input: { skill: 'git' } }]),
  ], async (transcriptPath) => {
    const enricher = createSkillsEnricher();
    const agents = [observation('a', transcriptPath)];
    await enricher.enrich(agents);
    assert.equal(agents[0].display.lastEquipSource, 'skill', 'the Skill call came after the Bash call');
  });
});

test('a repeat call never moves its entry, and never flips lastEquipSource', async () => {
  await withTranscript([
    toolUseLine([{ name: 'Skill', input: { skill: 'git' } }]),
    toolUseLine([{ name: 'Bash' }]),
    toolUseLine([{ name: 'Skill', input: { skill: 'git' } }]), // a repeat, not a new entry
  ], async (transcriptPath) => {
    const enricher = createSkillsEnricher();
    const agents = [observation('a', transcriptPath)];
    await enricher.enrich(agents);
    assert.deepEqual(agents[0].display.skills, ['git']);
    assert.deepEqual(agents[0].display.tools, ['Bash']);
    assert.equal(agents[0].display.lastEquipSource, 'tool', 'the repeat Skill call introduces nothing new, so Bash stays the most recent genuine addition');
  });
});

test('skill text in a prompt or an answer never counts, only a real tool_use block', async () => {
  await withTranscript([
    JSON.stringify({ message: { role: 'user', content: 'please use the git skill' } }),
    JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'I used Bash and the jira skill' }] } }),
  ], async (transcriptPath) => {
    const enricher = createSkillsEnricher();
    const agents = [observation('a', transcriptPath)];
    await enricher.enrich(agents);
    assert.equal(agents[0].display.skills, undefined);
    assert.equal(agents[0].display.tools, undefined);
    assert.equal(agents[0].display.lastEquipSource, undefined);
  });
});

test('past MAX_SKILLS distinct skills, display.skills keeps the most recent 8, not the first 8 (issue #167 round 2 review)', async () => {
  // 9 distinct skills: on the old `.slice(0, MAX_SKILLS)` code this kept skills 1-8 and
  // dropped skill 9 — the truly newest skill — because `agent.display.skills` starts `{}`
  // every poll (`server/claudeSource.ts`'s `toObservation`), so "existing" is always empty
  // and the cap always truncated from the front of the session's full history instead of
  // the back. The equipment catalog's hand item reads `skills[skills.length - 1]` as the
  // newest; a session with more than 8 distinct skills (routine for Gabriel) would freeze
  // on day one under the old code.
  const skills = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
  await withTranscript(
    skills.map((skill) => toolUseLine([{ name: 'Skill', input: { skill } }])),
    async (transcriptPath) => {
      const enricher = createSkillsEnricher();
      const agents = [observation('a', transcriptPath)];
      await enricher.enrich(agents);
      assert.deepEqual(agents[0].display.skills, ['b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']);
      const skillsSeen = agents[0].display.skills!;
      assert.equal(skillsSeen[skillsSeen.length - 1], 'i', 'the 9th, truly newest skill must still be "newest"');
    },
  );
});

test('a later poll only reads the bytes added since the last one, and keeps accumulating across polls', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'skills-enricher-'));
  const transcriptPath = path.join(dir, 'session.jsonl');
  try {
    await writeFile(transcriptPath, `${toolUseLine([{ name: 'Skill', input: { skill: 'git' } }])}\n`);
    const enricher = createSkillsEnricher();
    const first = [observation('a', transcriptPath)];
    await enricher.enrich(first);
    assert.deepEqual(first[0].display.skills, ['git']);

    await writeFile(transcriptPath, `${toolUseLine([{ name: 'Skill', input: { skill: 'git' } }])}\n${toolUseLine([{ name: 'Bash' }])}\n`, { flag: 'w' });
    const second = [observation('a', transcriptPath)];
    await enricher.enrich(second);
    assert.deepEqual(second[0].display.skills, ['git']);
    assert.deepEqual(second[0].display.tools, ['Bash']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
