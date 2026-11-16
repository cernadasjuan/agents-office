import { createHmac, randomBytes } from 'node:crypto';
import type { Plugin } from 'vite';
import { detectAgents, type DetectedAgent } from './agentDetector.js';

function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

export function agentDetectorPlugin(detect: () => DetectedAgent[] = detectAgents): Plugin {
  // IDs are stable during this server run, without publishing raw session IDs.
  const idKey = randomBytes(32);
  const publicId = (id: string): string => createHmac('sha256', idKey).update(id).digest('hex');

  return {
    name: 'agent-detector',
    configureServer(server) {
      const host = server.config.server.host;
      if (host !== undefined && host !== false && host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') {
        throw new Error('Agents Office must listen on localhost, 127.0.0.1, or ::1.');
      }

      server.middlewares.use('/api/agents', (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        const reject = (status: number, message: string): void => {
          res.statusCode = status;
          res.end(JSON.stringify({ error: message }));
        };

        if (!isLoopback(req.socket.remoteAddress)) {
          reject(403, 'Local access only');
          return;
        }

        const protocol = server.config.server.https ? 'https' : 'http';
        let expectedOrigin: string;
        try {
          const hostHeader = req.headers.host;
          const url = new URL(`${protocol}://${hostHeader}`);
          if (!hostHeader || url.host !== hostHeader.toLowerCase()
            || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
            reject(403, 'Local host only');
            return;
          }
          expectedOrigin = url.origin;
        } catch {
          reject(403, 'Local host only');
          return;
        }

        // Vite's CORS policy permits other localhost origins. Session metadata
        // requires a stricter boundary: browser callers must use this origin.
        const origin = req.headers.origin;
        if (origin !== undefined && origin !== expectedOrigin) {
          reject(403, 'Same-origin access only');
          return;
        }

        if (req.method !== 'GET') {
          res.setHeader('Allow', 'GET');
          reject(405, 'Method not allowed');
          return;
        }

        try {
          const agents = detect().map((agent) => ({
            id: publicId(agent.id),
            name: agent.name,
            activity: agent.activity,
            ...(agent.parentId ? { parentId: publicId(agent.parentId) } : {}),
          }));
          res.end(JSON.stringify(agents));
        } catch {
          reject(500, 'Unable to detect agents');
        }
      });
    },
  };
}
