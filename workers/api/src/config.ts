/**
 * Числовые константы воркера, вынесенные из точки входа `src/index.ts`.
 *
 * Cloudflare Workers трактует каждый именованный export из entry-модуля как
 * отдельный entrypoint (Durable Object, Workflow и т.п.) и падает при старте
 * с `Incorrect type for map entry ...: not of type 'function or ExportedHandler'`,
 * если это не функция. Поэтому значения, которые нужны тестам, живут здесь,
 * а не в `index.ts`.
 */

/** Размер кадра по умолчанию для генерации AI-версии. */
export const DEFAULT_FRAME_SIZE = 1024;

/**
 * Таймаут vision-запроса держим заметно ниже ~18 с — предела, после которого
 * Cloudflare рвёт клиентское соединение, если воркер ещё молчит. Иначе 504
 * не успевает дойти до клиента, и тот видит оборванный `Recv failure`.
 */
export const CLASSIFY_TIMEOUT_MS = 15_000;
