import { createHmac, randomBytes } from 'node:crypto';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin, ViteDevServer } from 'vite';
import type { DetectedAgent } from './agentDetector.js';
import { claudeSource } from './claudeSource.js';
import { codexSource } from './codexSource.js';
import { attentionEnricher } from './attention.js';
import { stuckEnricher } from './stuck.js';
import { isOfficePlugin, pluginEntry } from './plugins.js';
import { describeWorld, observe, projectAgents, projectPeek, projectWorld, VIEW_NAMES, type Observation, type OfficePlugin, type OfficeView } from './seam.js';
import { defaultAuditLogPath, WriteActions } from './actions.js';
import { portraitPathFrom, readPortrait } from './portrait.js';

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
  /** Audit log for write actions. Default: AGENTS_OFFICE_AUDIT_LOG, else a file in the OS temp folder. */
  auditLogPath?: string;
  /** The picture over the office door. Default: AGENTS_OFFICE_PORTRAIT, else none. null turns it off. */
  portraitPath?: string | null;
}

/**
 * Same checks for every endpoint: loopback socket, local Host, same Origin, one method.
 * GET is the default. A POST (opt-in write actions only) must also send an Origin
 * equal to this server, and a same-origin Sec-Fetch-Site when the browser sends one.
 * Returns false after it has answered the request with an error.
 */
function admit(server: ViteDevServer, req: IncomingMessage, res: ServerResponse, method: 'GET' | 'POST' = 'GET'): boolean {
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
  if (method === 'POST') {
    if (origin === undefined) return reject(403, 'Same-origin access only');
    const fetchSite = req.headers['sec-fetch-site'];
    if (fetchSite !== undefined && fetchSite !== 'same-origin') return reject(403, 'Same-origin access only');
  }

  if (req.method !== method) {
    res.setHeader('Allow', method);
    return reject(405, 'Method not allowed');
  }
  return true;
}

const PUBLIC_ID = /^[a-f0-9]{64}$/;

function notFound(res: ServerResponse): void {
  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'Not found' }));
}

/** True when the request names the mounted path itself, not a sub path. */
function isExactPath(req: IncomingMessage): boolean {
  const pathname = (req.url ?? '').split('?')[0];
  return pathname === '' || pathname === '/';
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
    enrichers: [attentionEnricher(), stuckEnricher(), ...plugins.flatMap((plugin) => plugin.enrichers ?? [])],
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

      // Write actions exist only when a loaded plugin offers one (its own opt-in). Without
      // one, no POST route and no token exist, and every API request but GET gets 405.
      const offered = plugins.flatMap((plugin) => plugin.actions ?? []);
      let agentsByPublicId = new Map<string, Observation>();
      const writeActions = offered.length > 0 ? new WriteActions({
        actions: offered,
        lookup: (id) => agentsByPublicId.get(id),
        auditLogPath: settings.auditLogPath ?? defaultAuditLogPath(),
      }) : undefined;
      const enabledActions: ReadonlySet<string> = writeActions?.names ?? new Set();
      // Read views (opt-in plugins, for example peek) answer for one agent of the last poll.
      const views = new Map<string, OfficeView>();
      for (const view of plugins.flatMap((plugin) => plugin.views ?? [])) {
        if ((VIEW_NAMES as readonly string[]).includes(view.name) && !views.has(view.name)) views.set(view.name, view);
      }
      const remembersAgents = writeActions !== undefined || views.size > 0;

      if (writeActions) {
        server.middlewares.use((_req, res, next) => {
          res.setHeader('X-Frame-Options', 'DENY');
          res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
          next();
        });
        server.middlewares.use('/api/actions/token', (req, res) => {
          if (!admit(server, req, res)) return;
          if (!isExactPath(req)) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'Not found' }));
            return;
          }
          res.end(JSON.stringify({ token: writeActions.token }));
        });
        for (const action of writeActions.actions) {
          server.middlewares.use(`/api/actions/${action.name}`, async (req, res) => {
            if (!admit(server, req, res, 'POST')) {
              await writeActions.audit(action.name, undefined, `refused-${res.statusCode}`);
              return;
            }
            if (!isExactPath(req)) {
              res.statusCode = 404;
              res.end(JSON.stringify({ error: 'Not found' }));
              return;
            }
            await writeActions.handle(action, req, res);
          });
        }
        server.config.logger.info(`agents-office: write actions on: ${[...writeActions.names].join(', ')}`);
      }

      server.middlewares.use('/api/agents', async (req, res) => {
        if (!admit(server, req, res)) return;
        try {
          const { core, sources, enrichers } = pipeline();
          const observations = await observe(core, sources, enrichers);
          if (remembersAgents) agentsByPublicId = new Map(observations.map((agent) => [publicId(agent.id), agent]));
          res.end(JSON.stringify(projectAgents(observations, publicId, enabledActions)));
        } catch {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: 'Unable to detect agents' }));
        }
      });

      // GET /api/views/<name>?agent=<public id>. Mounted always, so a missing view is a plain 404.
      server.middlewares.use('/api/views', async (req, res) => {
        if (!admit(server, req, res)) return;
        const url = new URL(req.url ?? '/', 'http://local');
        const view = views.get(url.pathname.replace(/^\/+|\/+$/g, ''));
        if (!view) return notFound(res);
        const agentId = url.searchParams.get('agent') ?? '';
        if (!PUBLIC_ID.test(agentId)) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'Bad agent id' }));
          return;
        }
        const agent = agentsByPublicId.get(agentId);
        if (!agent) return notFound(res);
        try {
          res.end(JSON.stringify(projectPeek(await view.read(agent))));
        } catch {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: 'Unable to read the view' }));
        }
      });

      // Read-only and opt-in: without a valid portrait file the answer is 204 and the office shows a placeholder
      const portraitPath = settings.portraitPath === undefined ? portraitPathFrom() : settings.portraitPath;
      server.middlewares.use('/api/portrait', async (req, res) => {
        if (!admit(server, req, res)) return;
        if (!isExactPath(req)) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: 'Not found' }));
          return;
        }
        const portrait = await readPortrait(portraitPath);
        if (!portrait) {
          res.removeHeader('Content-Type');
          res.statusCode = 204;
          res.end();
          return;
        }
        res.setHeader('Content-Type', portrait.type);
        res.setHeader('Content-Length', portrait.bytes.length);
        res.end(portrait.bytes);
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
