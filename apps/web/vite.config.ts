import path from 'node:path';
import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { jmapRelay } from './dev/jmap-relay.ts';
import { demoServer } from './dev/demo/index.ts';
import { aiDevProxy } from './dev/ai-proxy.ts';

const useMock = process.env.VOXEL_MOCK === '1';
const useDemo = process.env.VOXEL_DEMO === '1';
const backend = process.env.VOXEL_BACKEND ?? 'http://localhost:8080';

const plugins: PluginOption[] = [
  react(),
  tailwindcss(),
  VitePWA({
    registerType: 'autoUpdate',
    injectRegister: false,
    includeAssets: ['favicon.svg'],
    manifest: {
      name: 'Voxel',
      short_name: 'Voxel',
      description: 'Modern webmail',
      lang: 'en',
      theme_color: '#1c1917',
      background_color: '#fafaf9',
      display: 'standalone',
      start_url: '/',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    },
    workbox: {
      globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
      // notifications push : gestionnaires `push` et `notificationclick`
      importScripts: ['/push-sw.js'],
      navigateFallback: '/index.html',
      // liens des pièces jointes volumineuses (/f/…) et leur API : jamais l'appli, toujours le serveur
      navigateFallbackDenylist: [/^\/imap\//, /^\/healthz/, /^\/config\.json/, /^\/files\//, /^\/f\//],
      // config.json : réseau d'abord, copie en cache pour démarrer hors ligne
      runtimeCaching: [{ urlPattern: ({ url }) => url.pathname === '/config.json', handler: 'NetworkFirst' }],
      maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      // une nouvelle version prend la main tout de suite (registerSW recharge la page), au lieu d'attendre
      // que tous les onglets soient fermés
      skipWaiting: true,
      clientsClaim: true,
    },
    devOptions: { enabled: false },
  }),
];
// mode développement sans CORS : relais JMAP local (dev/jmap-relay.ts)
if (useMock) plugins.unshift(jmapRelay());
// mode démo : serveur JMAP en mémoire et LLM simulé (dev/demo)
if (useDemo) plugins.unshift(demoServer());
// proxy CORS des fournisseurs d'IA, serveur de dev seulement (dev/ai-proxy.ts)
plugins.push(aiDevProxy());

export default defineConfig({
  plugins,
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  server: {
    // port fixe : l'origine doit rester la même pour que les boîtes enregistrées (IndexedDB) persistent
    port: 5273,
    strictPort: true,
    // passerelle IMAP locale (npm run dev:server), aussi en mode dev:mock
    proxy: {
      '/imap': { target: backend, changeOrigin: false },
      // pièces jointes volumineuses (npm run dev:server avec VOXEL_S3_*)
      '/files': { target: backend, changeOrigin: false },
      '/f/': { target: backend, changeOrigin: false },
    },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 900,
  },
});
