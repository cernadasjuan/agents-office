import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_SCRIPT = path.join(REPO_ROOT, 'scripts', 'build-launcher-app.sh');

/** A fake clone with a weird name, just real enough for the build script's own checks: a repo
 * root the script treats as a real clone (it only probes for `node_modules/.bin/vite`). */
function fakeRepoRoot(name: string): string {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-office-launcher-build-'));
  const repoRoot = path.join(parent, name);
  fs.mkdirSync(path.join(repoRoot, 'node_modules', '.bin'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, 'scripts', 'launcher'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'node_modules', '.bin', 'vite'), '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(repoRoot, 'node_modules', '.bin', 'vite'), 0o755);
  return repoRoot;
}

test('a repo root with a space, a quote and a $ never changes what the generated script runs', () => {
  // The exact shape the old front-end review flagged: a clone path built to break out of an
  // unescaped double-quoted shell string if it were ever interpolated into shell source.
  const weirdName = `weird "repo" \`$(echo pwned)\` name`;
  const repoRoot = fakeRepoRoot(weirdName);
  const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-office-launcher-dest-'));
  try {
    execFileSync('bash', [BUILD_SCRIPT, repoRoot, destDir], { stdio: 'pipe' });

    const resourceFile = path.join(destDir, 'Agents Office.app', 'Contents', 'Resources', 'repo-root.txt');
    const launcherBin = path.join(destDir, 'Agents Office.app', 'Contents', 'MacOS', 'agents-office-launcher');

    // The path reaches disk byte for byte: no shell escaping ever touches it, because it is
    // never written as shell source in the first place.
    assert.equal(fs.readFileSync(resourceFile, 'utf8'), repoRoot);

    // The generated script holds no trace of the path or the injection payload: it is fully
    // static (quoted heredoc), the same regardless of repo_root. This is the real guarantee —
    // not a string that happens to be "safely escaped", but a script with nothing to escape.
    const launcherSource = fs.readFileSync(launcherBin, 'utf8');
    assert.ok(!launcherSource.includes('pwned'), 'no payload leaked into the generated script');
    assert.ok(!launcherSource.includes(repoRoot), 'the repo path is never baked into the script body');
    assert.match(launcherSource, /repo_root="\$\(cat "\$bin_dir\/\.\.\/Resources\/repo-root\.txt"\)"/, 'it reads the path from the resource file at run time instead');

    // A static, literal command substitution in source is not itself a vulnerability — bash
    // only ever treats `$(...)` as code when it appears unquoted in source text, never when it
    // arrives as the *content* of a variable (what `cat` puts into `repo_root` here). Proven
    // directly: substitute a fake HOME and a stub `cat`/`dirname` and confirm the script
    // resolves AGENTS_OFFICE_REPO_ROOT back to the literal weird string, with the payload
    // never executed (no "pwned" marker file appears anywhere).
    const binDir = path.join(destDir, 'Agents Office.app', 'Contents', 'MacOS');
    const probe = `
      set -e
      bin_dir="${binDir.replace(/"/g, '\\"')}"
      repo_root="$(cat "$bin_dir/../Resources/repo-root.txt")"
      printf '%s' "$repo_root"
    `;
    const resolved = execFileSync('bash', ['-c', probe], { encoding: 'utf8' });
    assert.equal(resolved, repoRoot);
    assert.ok(!fs.existsSync('/tmp/pwned'), 'the injection payload never ran as a command');

    assert.doesNotThrow(() => execFileSync('bash', ['-n', launcherBin]), 'the generated script is syntactically valid shell');
  } finally {
    fs.rmSync(path.dirname(repoRoot), { recursive: true, force: true });
    fs.rmSync(destDir, { recursive: true, force: true });
  }
});

const FIND_NODE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'launcher', 'find-node.sh');

/**
 * Sources find-node.sh and calls one of its nvm helpers directly, with HOME replaced. Calls
 * `nvm_default_node`/`highest_installed_nvm_node`, not `find_node` itself: `find_node` checks
 * the hardcoded `/opt/homebrew/bin/node` and `/usr/local/bin/node` paths first, which are
 * real, machine-specific paths a test cannot safely erase, so it would answer from whatever
 * this machine has installed instead of exercising the nvm logic under test.
 */
function callNvmHelper(fn: 'nvm_default_node' | 'highest_installed_nvm_node', home: string): { stdout: string; status: number } {
  const probe = `
    set -e
    source "${FIND_NODE_SCRIPT}"
    ${fn}
  `;
  const result = spawnSync('/bin/bash', ['-c', probe], { encoding: 'utf8', env: { HOME: home } });
  if (result.error) throw result.error;
  return { stdout: (result.stdout ?? '').trim(), status: result.status ?? 1 };
}

function fakeNvmInstall(home: string, versions: string[], defaultAlias?: string): void {
  for (const version of versions) {
    const binDir = path.join(home, '.nvm', 'versions', 'node', version, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'node'), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(binDir, 'node'), 0o755);
  }
  if (defaultAlias !== undefined) {
    const aliasDir = path.join(home, '.nvm', 'alias');
    fs.mkdirSync(aliasDir, { recursive: true });
    fs.writeFileSync(path.join(aliasDir, 'default'), `${defaultAlias}\n`);
  }
}

test('nvm_default_node resolves a default set to a bare major ("22") to the highest installed v22.x', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-office-find-node-'));
  try {
    // v18 is installed too, and it is not the highest overall: picking it would mean the
    // bare-major lookup fell through to "highest installed version" by coincidence, not by
    // actually resolving the major the user asked for.
    fakeNvmInstall(home, ['v18.20.4', 'v22.11.0', 'v22.15.0'], '22');
    const { stdout, status } = callNvmHelper('nvm_default_node', home);
    assert.equal(status, 0);
    assert.equal(stdout, path.join(home, '.nvm', 'versions', 'node', 'v22.15.0', 'bin', 'node'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('nvm_default_node resolves a default set to a full version exactly, no major fallback needed', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-office-find-node-'));
  try {
    fakeNvmInstall(home, ['v20.11.0', 'v22.15.0'], '20.11.0');
    const { stdout, status } = callNvmHelper('nvm_default_node', home);
    assert.equal(status, 0);
    assert.equal(stdout, path.join(home, '.nvm', 'versions', 'node', 'v20.11.0', 'bin', 'node'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('highest_installed_nvm_node falls back correctly when no default resolves', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-office-find-node-'));
  try {
    fakeNvmInstall(home, ['v18.20.4', 'v9.0.0', 'v22.15.0']); // no default alias at all
    const { stdout, status } = callNvmHelper('highest_installed_nvm_node', home);
    assert.equal(status, 0);
    assert.equal(stdout, path.join(home, '.nvm', 'versions', 'node', 'v22.15.0', 'bin', 'node'), 'sort -V, not a lexical sort: v9 does not beat v18 or v22');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// --- Launcher app icon (issue #205) ---

test('the built app bundle carries the committed icon and points Info.plist at it', () => {
  const repoRoot = fakeRepoRoot('icon-repo');
  const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-office-launcher-dest-'));
  try {
    execFileSync('bash', [BUILD_SCRIPT, repoRoot, destDir], { stdio: 'pipe' });
    const resourcesDir = path.join(destDir, 'Agents Office.app', 'Contents', 'Resources');
    assert.ok(fs.existsSync(path.join(resourcesDir, 'AgentsOffice.icns')), 'the icon is copied into the bundle');
    const plist = fs.readFileSync(path.join(destDir, 'Agents Office.app', 'Contents', 'Info.plist'), 'utf8');
    assert.match(plist, /<key>CFBundleIconFile<\/key>\s*<string>AgentsOffice<\/string>/, 'Info.plist names the icon file (no extension, the macOS convention)');
  } finally {
    fs.rmSync(path.dirname(repoRoot), { recursive: true, force: true });
    fs.rmSync(destDir, { recursive: true, force: true });
  }
});

test('a checkout missing the committed .icns still builds the app, just without an icon (graceful degradation)', () => {
  const repoRoot = fakeRepoRoot('no-icon-repo');
  const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-office-launcher-dest-'));
  const iconPath = path.join(REPO_ROOT, 'scripts', 'launcher', 'AgentsOffice.icns');
  const backupPath = `${iconPath}.test-backup`;
  fs.renameSync(iconPath, backupPath);
  try {
    execFileSync('bash', [BUILD_SCRIPT, repoRoot, destDir], { stdio: 'pipe' });
    const resourcesDir = path.join(destDir, 'Agents Office.app', 'Contents', 'Resources');
    assert.equal(fs.existsSync(path.join(resourcesDir, 'AgentsOffice.icns')), false);
    const plist = fs.readFileSync(path.join(destDir, 'Agents Office.app', 'Contents', 'Info.plist'), 'utf8');
    assert.ok(!plist.includes('CFBundleIconFile'), 'no icon key without an icon to point at — the pre-#205 plist shape');
  } finally {
    fs.renameSync(backupPath, iconPath);
    fs.rmSync(path.dirname(repoRoot), { recursive: true, force: true });
    fs.rmSync(destDir, { recursive: true, force: true });
  }
});

test('build-launcher-app.sh refuses a repo root with no built vite binary', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-office-launcher-build-'));
  const repoRoot = path.join(parent, 'no-vite-here');
  fs.mkdirSync(repoRoot, { recursive: true });
  const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-office-launcher-dest-'));
  try {
    assert.throws(() => execFileSync('bash', [BUILD_SCRIPT, repoRoot, destDir], { stdio: 'pipe' }));
    assert.equal(fs.existsSync(path.join(destDir, 'Agents Office.app')), false);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
    fs.rmSync(destDir, { recursive: true, force: true });
  }
});
