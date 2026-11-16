import { defineConfig } from 'vite';
import { agentDetectorPlugin } from './server/vitePlugin.js';

export default defineConfig({
  plugins: [agentDetectorPlugin()],
  server: {
    host: '127.0.0.1',
    open: true,
  },
});
