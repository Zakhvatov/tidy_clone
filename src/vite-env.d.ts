/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/**
 * Переменные окружения сборки Vite. Дописываются сюда, а не читаются вслепую:
 * опечатка в имени переменной должна ломать `tsc`, а не тихо уходить в default.
 */
interface ImportMetaEnv {
  /** Базовый URL воркера-посредника `tidy-api` (T3). */
  readonly VITE_TIDY_API_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
