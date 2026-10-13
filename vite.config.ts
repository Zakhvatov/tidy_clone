/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

import { manifest } from './src/app/manifest'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // Регистрация service worker'а делается вручную в src/main.tsx
      // через virtual:pwa-register, поэтому автовставка скрипта выключена.
      injectRegister: null,
      includeAssets: ['apple-touch-icon.png', 'pwa-192x192.png', 'maskable-512x512.png'],
      manifest,
      workbox: {
        // Версионированный прекеш: устаревшие кэши вычищаются при обновлении.
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        globPatterns: ['**/*.{js,css,html,png,svg,webmanifest}'],
        // Офлайн-заглушка навигации: любая навигация отдаёт precache-оболочку SPA.
        navigateFallback: '/index.html',
      },
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
