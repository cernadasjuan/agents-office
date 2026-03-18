import { defineConfig } from 'vite';
import { agentDetectorPlugin } from './server/vitePlugin.js';

export default defineConfig({
  plugins: [agentDetectorPlugin()],
  server: {
    open: true,
  },
});
