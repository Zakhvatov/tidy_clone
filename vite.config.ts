/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

import { appBase } from './src/app/basePath'
import { manifest } from './src/app/manifest'
import { workbox } from './src/app/pwa'

export default defineConfig({
  base: appBase,
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // Регистрация service worker'а делается вручную в src/main.tsx
      // через virtual:pwa-register, поэтому автовставка скрипта выключена.
      injectRegister: null,
      includeAssets: ['apple-touch-icon.png', 'pwa-192x192.png', 'maskable-512x512.png'],
      manifest,
      workbox,
      devOptions: {
        enabled: false,
      },
    }),
  ],
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    css: true,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
})
