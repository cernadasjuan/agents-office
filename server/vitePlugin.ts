import { createHmac, randomBytes } from 'node:crypto';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin, ViteDevServer } from 'vite';
import type { DetectedAgent } from './agentDetector.js';
import { claudeSource } from './claudeSource.js';
import { codexSource } from './codexSource.js';
import { attentionEnricher } from './attention.js';
import { isOfficePlugin, pluginEntry } from './plugins.js';
import { describeWorld, observe, projectAgents, projectWorld, type OfficePlugin } from './seam.js';

function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

export interface AgentDetectorOptions {
  /** Replace the Claude detector (tests inject synthetic records). */
  detect?: () => DetectedAgent[];
  /** Plugins given directly, for tests and embedders. */
  plugins?: OfficePlugin[];
  /** Plugin folder names to load from `pluginsDir` (AGENTS_OFFICE_PLUGINS or --plugin). */
  pluginNames?: string[];
  pluginsDir?: string;
  /** Codex home for the built-in Codex source. Default: CODEX_HOME, else ~/.codex. null turns the source off. */
  codexHome?: string | null;
}

/**
 * Same checks for every endpoint: loopback socket, local Host, same Origin, GET only.
 * Returns false after it has answered the request with an error.
 */
function admit(server: ViteDevServer, req: IncomingMessage, res: ServerResponse): boolean {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const reject = (status: number, message: string): false => {
    res.statusCode = status;
    res.end(JSON.stringify({ error: message }));
    return false;
  };

  if (!isLoopback(req.socket.remoteAddress)) return reject(403, 'Local access only');

  const protocol = server.config.server.https ? 'https' : 'http';
  let expectedOrigin: string;
  try {
    const hostHeader = req.headers.host;
    const url = new URL(`${protocol}://${hostHeader}`);
    if (!hostHeader || url.host !== hostHeader.toLowerCase()
      || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      return reject(403, 'Local host only');
    }
    expectedOrigin = url.origin;
  } catch {
    return reject(403, 'Local host only');
  }

  // Vite's CORS policy permits other localhost origins. Session metadata
  // requires a stricter boundary: browser callers must use this origin.
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== expectedOrigin) return reject(403, 'Same-origin access only');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return reject(405, 'Method not allowed');
  }
  return true;
}

export function agentDetectorPlugin(options: AgentDetectorOptions | (() => DetectedAgent[]) = {}): Plugin {
  const settings: AgentDetectorOptions = typeof options === 'function' ? { detect: options } : options;
  // IDs are stable during this server run, without publishing raw session IDs.
  const idKey = randomBytes(32);
  const publicId = (id: string): string => createHmac('sha256', idKey).update(id).digest('hex');
  const plugins: OfficePlugin[] = [...(settings.plugins ?? [])];

  const pipeline = () => ({
    core: claudeSource(settings.detect),
    // Codex is built in but runs like a plugin source: its failure drops only its own agents.
    sources: [...(settings.codexHome === null ? [] : [codexSource(settings.codexHome)]),
      ...plugins.flatMap((plugin) => plugin.sources ?? [])],
    enrichers: [attentionEnricher(), ...plugins.flatMap((plugin) => plugin.enrichers ?? [])],
    world: plugins.flatMap((plugin) => plugin.world ?? []),
  });

  return {
    name: 'agent-detector',
    async configureServer(server) {
      const host = server.config.server.host;
      if (host !== undefined && host !== false && host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') {
        throw new Error('Agents Office must listen on localhost, 127.0.0.1, or ::1.');
      }

      const pluginsDir = settings.pluginsDir ?? path.join(server.config.root, 'plugins');
      for (const name of settings.pluginNames ?? []) {
        const entry = pluginEntry(pluginsDir, name);
        if (!entry) {
          server.config.logger.warn(`agents-office: plugin "${name}" not found, skipped`);
          continue;
        }
        const loaded = (await server.ssrLoadModule(entry)).default;
        if (isOfficePlugin(loaded)) plugins.push(loaded);
        else server.config.logger.warn(`agents-office: plugin "${name}" has no valid default export, skipped`);
      }

      server.middlewares.use('/api/agents', async (req, res) => {
        if (!admit(server, req, res)) return;
        try {
          const { core, sources, enrichers } = pipeline();
          res.end(JSON.stringify(projectAgents(await observe(core, sources, enrichers), publicId)));
        } catch {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: 'Unable to detect agents' }));
        }
      });

      server.middlewares.use('/api/world', async (req, res) => {
        if (!admit(server, req, res)) return;
        try {
          const { core, sources, enrichers, world } = pipeline();
          const observations = world.length > 0 ? await observe(core, sources, enrichers) : [];
          const parts = await describeWorld(world, observations);
          res.end(JSON.stringify(projectWorld(parts, plugins.map((plugin) => plugin.name), publicId)));
        } catch {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: 'Unable to describe the office' }));
        }
      });
    },
  };
}
