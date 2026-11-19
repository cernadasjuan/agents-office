import { defineConfig } from 'vite';
import { agentDetectorPlugin } from './server/vitePlugin.js';
import { parsePluginNames } from './server/plugins.js';

export default defineConfig({
  // Optional plugins from plugins/<name>/, e.g. AGENTS_OFFICE_PLUGINS=herdr,missions. None by default.
  plugins: [agentDetectorPlugin({ pluginNames: parsePluginNames(process.env.AGENTS_OFFICE_PLUGINS) })],
  server: {
    host: '127.0.0.1',
    open: true,
  },
});
