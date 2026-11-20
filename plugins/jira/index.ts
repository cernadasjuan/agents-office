import os from 'node:os';
import type { OfficePlugin } from '../../server/seam.js';
import { JiraCache, defaultReadFile, resolveJiraCredentials, type ReadFile } from './jira.js';

/**
 * Personal Jira board plugin (issue #145). Opt-in with `AGENTS_OFFICE_PLUGINS=jira`.
 * Read-only: one GET per poll, at most once every 2 minutes (`JiraCache`). Without
 * credentials it adds nothing and calls nothing, the same as the GitHub plugin
 * without a repository. The CEO office shows the board only while it has data.
 */

export interface JiraPluginOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => number;
  homedir?: () => string;
  readFile?: ReadFile;
}

export function createJiraPlugin(options: JiraPluginOptions = {}): OfficePlugin {
  const env = options.env ?? process.env;
  const credentials = resolveJiraCredentials(env, options.homedir ?? os.homedir, options.readFile ?? defaultReadFile);
  if (!credentials) return { name: 'jira' };
  const doFetch = options.fetch ?? globalThis.fetch;
  const cache = new JiraCache(doFetch, credentials, options.now ?? Date.now);

  return {
    name: 'jira',
    world: [{
      id: 'jira-my-sprint',
      async world() {
        await cache.refresh();
        const tickets = cache.tickets();
        return tickets && tickets.length > 0 ? { jiraTickets: tickets } : {};
      },
    }],
  };
}

export default createJiraPlugin();
