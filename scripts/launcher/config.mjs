// Config for the macOS launcher app (scripts/build-launcher-app.sh,
// scripts/install-launcher.sh, scripts/launcher/agents-office-launcher.mjs).
//
// The launcher reads a small KEY=VALUE file so a user's mission roots, GitHub repos and
// office portrait survive a `git pull` and a rebuild of the launcher app. The file is never
// `source`d: only the known keys below are read, everything else is ignored.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Env vars the launcher config file may set. Anything else in the file is ignored. */
export const KNOWN_KEYS = [
  'AGENTS_OFFICE_MISSION_ROOTS',
  'AGENTS_OFFICE_GITHUB_REPOS',
  'AGENTS_OFFICE_PORTRAIT',
];

/** A config file past this size, or that is not a regular file, is never read (it cannot hold more than a few KB of real config anyway). */
export const CONFIG_MAX_BYTES = 64 * 1024;

/** Where the launcher config file lives, one per machine, independent of where the repo is cloned. */
export function configPath() {
  return path.join(os.homedir(), 'Library', 'Application Support', 'AgentsOffice', 'launcher.env');
}

function stripQuotes(value) {
  const trimmed = value.trim();
  const first = trimmed[0];
  const last = trimmed.at(-1);
  if (trimmed.length >= 2 && ((first === '"' && last === '"') || (first === "'" && last === "'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Parses a launcher config file's text into an env var map.
 * Blank lines and lines starting with `#` are skipped. Only KNOWN_KEYS are kept, an empty
 * value is dropped (so a commented-out or blank key leaves the plugin at its old, off default).
 */
export function parseConfig(text) {
  const env = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!KNOWN_KEYS.includes(key)) continue;
    const value = stripQuotes(line.slice(eq + 1));
    if (value !== '') env[key] = value;
  }
  return env;
}

/** The file the installer writes when none exists yet. Every key starts commented out. */
export function defaultConfigTemplate() {
  return `# Agents Office launcher config.
# Uncomment and set any value the launcher should pass to the fork server.
# A commented-out or blank key keeps that plugin's old, off default.

# Root folders the missions plugin scans for mission.yaml files, comma-separated.
# AGENTS_OFFICE_MISSION_ROOTS=

# owner/name repositories the GitHub plugin draws as wall boards, comma-separated.
# AGENTS_OFFICE_GITHUB_REPOS=

# Path to an image (png, jpg, jpeg, webp or gif, at most 2 MB) for the office door portrait.
# AGENTS_OFFICE_PORTRAIT=
`;
}

/** Writes the template config file if it does not exist yet. Returns true when it created one. */
export function ensureConfig(fsImpl = fs) {
  const file = configPath();
  if (fsImpl.existsSync(file)) return false;
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  fsImpl.writeFileSync(file, defaultConfigTemplate());
  return true;
}

/**
 * Reads the launcher config file as an env var map. Missing file, or anything that is not a
 * plain regular file of a sane size (a symlink, a pipe, a directory, something oversized),
 * reads as no overrides rather than stalling the launcher or reading unbounded data.
 */
export function readConfigEnv(fsImpl = fs) {
  const file = configPath();
  let stat;
  try {
    stat = fsImpl.lstatSync(file);
  } catch {
    return {};
  }
  if (!stat.isFile() || stat.size > CONFIG_MAX_BYTES) return {};
  return parseConfig(fsImpl.readFileSync(file, 'utf8'));
}
