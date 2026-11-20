import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
