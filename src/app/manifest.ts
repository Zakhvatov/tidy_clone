import type { ManifestOptions } from 'vite-plugin-pwa'

import { appBase } from './basePath'

/** Путь к файлу из `public/` с учётом базового пути сборки. */
const asset = (path: string) => `${appBase}${path.replace(/^\//, '')}`

/**
 * Web App Manifest приложения «Гардероб».
 *
 * Вынесен из vite.config.ts отдельным модулем, чтобы его можно было
 * проверять тестами без запуска полной сборки.
 */
export const manifest: Partial<ManifestOptions> = {
  name: 'Гардероб',
  short_name: 'Гардероб',
  description: 'Личный цифровой гардероб: вещи по ссылке или фото, образы и офлайн-режим.',
  lang: 'ru',
  dir: 'ltr',
  display: 'standalone',
  orientation: 'portrait',
  start_url: appBase,
  scope: appBase,
  background_color: '#FFFFFF',
  theme_color: '#FFFFFF',
  icons: [
    {
      src: asset('/pwa-192x192.png'),
      sizes: '192x192',
      type: 'image/png',
      purpose: 'any',
    },
    {
      src: asset('/pwa-512x512.png'),
      sizes: '512x512',
      type: 'image/png',
      purpose: 'any',
    },
    {
      src: asset('/maskable-512x512.png'),
      sizes: '512x512',
      type: 'image/png',
      purpose: 'maskable',
    },
  ],
}
