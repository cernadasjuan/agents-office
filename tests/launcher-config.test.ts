import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';
import { CONFIG_MAX_BYTES, configPath, defaultConfigTemplate, ensureConfig, parseConfig, readConfigEnv } from '../scripts/launcher/config.mjs';

test('parseConfig ignores comments and blank lines', () => {
  const env = parseConfig('# comment\n\nAGENTS_OFFICE_MISSION_ROOTS=/a/b\n');
  assert.deepEqual(env, { AGENTS_OFFICE_MISSION_ROOTS: '/a/b' });
});

test('parseConfig strips surrounding quotes', () => {
  const env = parseConfig('AGENTS_OFFICE_GITHUB_REPOS="owner/one,owner/two"\n');
  assert.deepEqual(env, { AGENTS_OFFICE_GITHUB_REPOS: 'owner/one,owner/two' });
});

test('parseConfig drops a key outside the known set (no arbitrary env injection)', () => {
  const env = parseConfig('SOME_OTHER_VAR=x\nAGENTS_OFFICE_PORTRAIT=/p.png\n');
  assert.deepEqual(env, { AGENTS_OFFICE_PORTRAIT: '/p.png' });
});

test('parseConfig drops a commented-out key', () => {
  const env = parseConfig('# AGENTS_OFFICE_PORTRAIT=/p.png\n');
  assert.deepEqual(env, {});
});

test('parseConfig drops an empty value, leaving the plugin at its old default', () => {
  const env = parseConfig('AGENTS_OFFICE_MISSION_ROOTS=\n');
  assert.deepEqual(env, {});
});

test('defaultConfigTemplate documents every known key, commented out', () => {
  const template = defaultConfigTemplate();
  for (const key of ['AGENTS_OFFICE_MISSION_ROOTS', 'AGENTS_OFFICE_GITHUB_REPOS', 'AGENTS_OFFICE_PORTRAIT']) {
    assert.match(template, new RegExp(`# ${key}=`));
  }
});

test('ensureConfig creates the file once; readConfigEnv reads it back', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-office-launcher-config-'));
  const homeMock = mock.method(os, 'homedir', () => fixture);
  try {
    assert.equal(ensureConfig(), true, 'first call creates the file');
    assert.equal(fs.existsSync(configPath()), true);
    assert.equal(ensureConfig(), false, 'second call is a no-op, never overwrites edits');

    fs.writeFileSync(configPath(), 'AGENTS_OFFICE_MISSION_ROOTS=/m\n');
    assert.deepEqual(readConfigEnv(), { AGENTS_OFFICE_MISSION_ROOTS: '/m' });
  } finally {
    homeMock.mock.restore();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('readConfigEnv with no file yet returns no overrides', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-office-launcher-config-'));
  const homeMock = mock.method(os, 'homedir', () => fixture);
  try {
    assert.deepEqual(readConfigEnv(), {});
  } finally {
    homeMock.mock.restore();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('readConfigEnv ignores a file past the size cap, instead of reading unbounded data', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-office-launcher-config-'));
  const homeMock = mock.method(os, 'homedir', () => fixture);
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    const oversized = `AGENTS_OFFICE_MISSION_ROOTS=${'x'.repeat(CONFIG_MAX_BYTES + 1)}\n`;
    fs.writeFileSync(configPath(), oversized);
    assert.deepEqual(readConfigEnv(), {}, 'a file past CONFIG_MAX_BYTES reads as no overrides');
  } finally {
    homeMock.mock.restore();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('readConfigEnv ignores anything that is not a plain regular file', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-office-launcher-config-'));
  const homeMock = mock.method(os, 'homedir', () => fixture);
  try {
    fs.mkdirSync(configPath(), { recursive: true }); // a directory at the config path, not a file
    assert.deepEqual(readConfigEnv(), {}, 'a directory never gets read as config text');
  } finally {
    homeMock.mock.restore();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
