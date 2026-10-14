import { describe, expect, it } from 'vitest'

import { workbox } from './pwa'

/**
 * Конфиг service worker'а — часть обещания «работает офлайн» (T19).
 * Проверяем его тестом, чтобы случайная правка не убрала офлайн-оболочку.
 */
describe('Service worker: офлайн-оболочка (T19)', () => {
  it('отдаёт приложение на любую навигацию (SPA-fallback из прекеша)', () => {
    expect(workbox.navigateFallback).toBe('/index.html')
  })

  it('прекеширует html, скрипты, стили и иконки', () => {
    const patterns = workbox.globPatterns ?? []
    expect(patterns.join(' ')).toContain('html')
    expect(patterns.join(' ')).toContain('js')
    expect(patterns.join(' ')).toContain('css')
    expect(patterns.join(' ')).toContain('png')
  })

  it('активируется сразу и чистит устаревшие кэши', () => {
    expect(workbox.cleanupOutdatedCaches).toBe(true)
    expect(workbox.skipWaiting).toBe(true)
    expect(workbox.clientsClaim).toBe(true)
  })
})
