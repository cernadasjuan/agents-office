import path from 'node:path';
import fs from 'node:fs';
import type { OfficePlugin } from './seam.js';

const PLUGIN_NAME = /^[a-z0-9-]{1,32}$/;

/** Plugin names from a comma list (the AGENTS_OFFICE_PLUGINS variable or the --plugin flag). */
export function parsePluginNames(list: string | undefined): string[] {
  return Array.from(new Set((list ?? '').split(',').map((name) => name.trim()).filter((name) => PLUGIN_NAME.test(name))));
}

/** Where a plugin's server module lives, or null when the name is not a plain plugin folder. */
export function pluginEntry(pluginsDir: string, name: string): string | null {
  if (!PLUGIN_NAME.test(name)) return null;
  const entry = path.join(pluginsDir, name, 'index.ts');
  return fs.existsSync(entry) ? entry : null;
}

export function isOfficePlugin(value: unknown): value is OfficePlugin {
  if (typeof value !== 'object' || value === null) return false;
  const plugin = value as Record<string, unknown>;
  return typeof plugin.name === 'string'
    && ['sources', 'enrichers', 'world'].every((key) => plugin[key] === undefined || Array.isArray(plugin[key]));
}
