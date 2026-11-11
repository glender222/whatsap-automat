import { defineConfig, mergeConfig } from 'vite';
import base from './vite.config';

// Container development only; production keeps vite.config.ts.
export default mergeConfig(base, defineConfig({
  envDir: false,
  server: {
    allowedHosts: ['web', 'localhost', '127.0.0.1'],
    proxy: {
      '/api': { target: 'http://api:3000', changeOrigin: true },
      '/uploads': { target: 'http://api:3000', changeOrigin: true },
      '/socket.io': { target: 'http://api:3000', changeOrigin: true, ws: true },
    },
  },
}));
