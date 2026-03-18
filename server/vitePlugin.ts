import type { Plugin } from 'vite';
import { detectAgents } from './agentDetector.js';

export function agentDetectorPlugin(): Plugin {
  return {
    name: 'agent-detector',
    configureServer(server) {
      server.middlewares.use('/api/agents', (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        try {
          const agents = detectAgents();
          res.end(JSON.stringify(agents));
        } catch (err) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
    },
  };
}
