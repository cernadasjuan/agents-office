#!/usr/bin/env node

import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// Usage: agents-office [port] [--plugin name[,name]]...
const args = process.argv.slice(2);
const pluginNames = [];
let port = 5173;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--plugin' && args[i + 1]) pluginNames.push(args[++i]);
  else if (/^\d+$/.test(args[i])) port = parseInt(args[i], 10);
}
if (pluginNames.length > 0) {
  process.env.AGENTS_OFFICE_PLUGINS = [process.env.AGENTS_OFFICE_PLUGINS, ...pluginNames].filter(Boolean).join(',');
}

const server = await createServer({
  root,
  configFile: path.join(root, 'vite.config.ts'),
  server: {
    host: '127.0.0.1',
    port,
    open: true,
  },
});

await server.listen();
server.printUrls();
