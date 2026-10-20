/**
 * Базовый путь сборки.
 *
 * Cloudflare Pages отдаёт PWA с корня (`/`), а GitHub Pages — из подкаталога
 * репозитория (`/tidy_clone/`). Путь задаётся переменной окружения `BASE_PATH`
 * на этапе сборки, чтобы один и тот же код работал на обеих площадках.
 */
export function normalizeBase(raw: string | undefined): string {
  const value = raw?.trim()
  if (!value || value === '/') return '/'
  const withLeadingSlash = value.startsWith('/') ? value : `/${value}`
  return withLeadingSlash.endsWith('/') ? withLeadingSlash : `${withLeadingSlash}/`
}

export const appBase = normalizeBase(process.env.BASE_PATH)
