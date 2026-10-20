import type { VitePWAOptions } from 'vite-plugin-pwa'

import { appBase } from './basePath'

/**
 * Настройки service worker'а (T1/T19).
 *
 * Вынесены из `vite.config.ts` отдельным модулем — как и `manifest` — чтобы
 * офлайн-поведение можно было проверить тестом без запуска сборки.
 *
 * `navigateFallback: '/index.html'` — ключевая строка офлайна: любая навигация
 * в SPA отдаётся из прекеша, поэтому все экраны открываются без сети. Данные
 * гардероба и так локальные (IndexedDB), а сеть нужна только импорту по ссылке
 * и оцифровке.
 */
export const workbox: VitePWAOptions['workbox'] = {
  // Версионированный прекеш: устаревшие кэши вычищаются при обновлении.
  cleanupOutdatedCaches: true,
  clientsClaim: true,
  skipWaiting: true,
  globPatterns: ['**/*.{js,css,html,png,svg,webmanifest}'],
  // Офлайн-заглушка навигации: любая навигация отдаёт precache-оболочку SPA.
  navigateFallback: `${appBase}index.html`,
}
