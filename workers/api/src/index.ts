/**
 * T3 · Воркер-посредник `tidy-api` (Cloudflare Workers).
 *
 * Зачем посредник (ADR-0003): браузер не может звать AI-API напрямую из-за CORS,
 * а токены не должны лежать на телефоне. Секреты живут только здесь:
 *   - ключ генерации (`api.iskragen.ru`) — через секрет `ISKRAGEN_API_KEY`;
 *   - vision-модель (провайдер `opencode-go`) — через секрет `OPENCODE_API_KEY`.
 * В клиент ничего из этого не попадает.
 *
 * Генерация у IskraGen асинхронная, и воркер больше этого не прячет
 * (ADR-0006): клиент сам создаёт задачу, опрашивает статус и забирает файл.
 *
 * Image-to-image (D13): с `imageBase64`+`mimeType` воркер сначала грузит
 * картинку в `POST /v1/files/` (получает `url`), затем подставляет её в
 * `params` выбранной i2i-модели (`input_urls`/`image_urls`/`image_input`).
 * Т2и-запросы без картинки работают по прежнему сценарию D12.
 *
 * Идемпотентность (ADR-0006): клиент присылает `idempotencyKey` — воркер
 * пробрасывает его в `Idempotency-Key` провайдера. Повторный `POST` с тем же
 * ключом возвращает уже существующую задачу **без повторного списания**,
 * поэтому потерянный ответ не стоит второй оплаты.
 *
 * Маршруты:
 *   GET  /models                              → {models:[{slug,title,priceRub}], defaultSlug}
 *   POST /generate  {prompt, model?, imageBase64?, mimeType?, idempotencyKey?}
 *                                          → 202 {taskId, status, costRub, model}
 *   GET  /generate/{taskId}                  → 200 {taskId, status, costRub}
 *   GET  /generate/{taskId}/image            → байты готового изображения
 *   POST /classify  {imageBase64, mimeType}   → {category, subcategory, confidence}
 *   GET  /health                              → {ok, generate, classify}
 */

import {
  CLASSIFY_SYSTEM_PROMPT,
  FALLBACK_CATEGORY,
  FALLBACK_SUBCATEGORY,
  classifyFromModel,
  type Classification,
} from "./taxonomy";
import {
  CLASSIFY_TIMEOUT_MS,
  GENERATE_STATUS_TIMEOUT_MS,
  IMAGE_DOWNLOAD_TIMEOUT_MS,
  MAX_GENERATE_BODY_BYTES,
  MAX_GENERATE_IMAGE_BYTES,
  MAX_GENERATE_INPUT_BYTES,
  MODELS_TIMEOUT_MS,
} from "./config";
import {
  DEFAULT_IMAGE_MODEL_SLUG,
  DEFAULT_IMAGE_TO_IMAGE_MODEL_SLUG,
  IMAGE_MODELS,
  findImageModel,
  frameParams,
  type ImageModel,
} from "./models";

/** Binding Cloudflare Rate Limiting (`ratelimits` в wrangler.jsonc). */
export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  /**
   * Секрет: ключ генерации `api.iskragen.ru` (`wrangler secret put ISKRAGEN_API_KEY`).
   * Если не задан — `/generate` отвечает 503 `not_configured`.
   */
  ISKRAGEN_API_KEY?: string;
  /** Slug модели; по умолчанию `gpt-image-2-text-to-image`. Переопределяется var-ом. */
  ISKRAGEN_MODEL_SLUG?: string;
  /** Базовый URL провайдера; по умолчанию `ISKRAGEN_BASE_URL`. */
  ISKRAGEN_BASE_URL?: string;
  /** Секрет: ключ провайдера `opencode-go`. В репозиторий не попадает. */
  OPENCODE_API_KEY?: string;
  /**
   * Секрет: клиентский токен PWA (`wrangler secret put CLIENT_TOKEN`).
   * Если не задан — защищённые маршруты отвечают 503 `not_configured`.
   */
  CLIENT_TOKEN?: string;
  /** Список источников через запятую. Переопределяется var-ом `ALLOWED_ORIGINS`. */
  ALLOWED_ORIGINS?: string;
  /** Лимитер создания генерации (5 запросов/мин — каждый кадр стоит денег). */
  GENERATE_RATE_LIMITER?: RateLimitBinding;
  /** Лимитер опроса статуса генерации (60 запросов/мин). */
  GENERATION_STATUS_RATE_LIMITER?: RateLimitBinding;
  /** Лимитер скачивания результата генерации (10 запросов/мин). */
  GENERATION_IMAGE_RATE_LIMITER?: RateLimitBinding;
  /** Лимитер классификации (40 запросов/мин). */
  CLASSIFY_RATE_LIMITER?: RateLimitBinding;
  /** Лимитер каталога моделей. */
  MODELS_RATE_LIMITER?: RateLimitBinding;
  /** Общий лимитер: fallback, если отдельные bindings не сконфигурированы. */
  RATE_LIMITER?: RateLimitBinding;
}

/** Провайдер генерации: агрегатор в рублях, асинхронные задачи + polling. */
export const ISKRAGEN_BASE_URL = "https://api.iskragen.ru/v1";
export const ISKRAGEN_MODEL_SLUG = "gpt-image-2-text-to-image";
export const VISION_PROVIDER = "opencode-go";
export const VISION_MODEL = "deepseek-v4.1-flash";
export const VISION_BASE_URL = "https://opencode.ai/zen/go/v1";

/**
 * Провайдер `opencode-go` маршрутизирует запросы по сессии: без заголовка
 * `x-opencode-session` он отвечает 400 `MissingSessionID` (и на больших телах
 * успевает ответить раньше, чем воркер дописывает запрос, — отсюда зависание).
 * Значение — UUID, новый на каждый запрос; сессию не переиспользуем.
 */
export const OPENCODE_SESSION_HEADER = "x-opencode-session";

/** Заголовок с клиентским токеном PWA. Сверяется constant-time с секретом `CLIENT_TOKEN`. */
export const CLIENT_TOKEN_HEADER = "x-tidy-client";

/** Новый идентификатор сессии для одного запроса к провайдеру. */
export function newOpencodeSessionId(): string {
  return crypto.randomUUID();
}

const DEFAULT_ALLOWED_ORIGINS =
  "https://zakhvatov.github.io,https://tidy-clone.pages.dev,http://localhost:5173";

const MAX_PROMPT_CHARS = 800;
const MAX_CLASSIFY_BODY_BYTES = 4 * 1024 * 1024;
const MIN_DIMENSION = 256;
const MAX_DIMENSION = 2048;

const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);

/**
 * MIME входного изображения генерации: провайдер в `POST /v1/files/` принимает
 * только перечисленное, HEIC/HEIF туда не входят — клиент жмёт в JPEG.
 */
const GENERATE_INPUT_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/bmp",
  "image/gif",
  "image/tiff",
]);

/** Ответы vision-модели ограничиваем бюджетом токенов: нужен только короткий JSON.
 *  DeepSeek V4.1 Flash — reasoning-модель, поэтому запас должен покрывать и рассуждение. */
const VISION_MAX_TOKENS = 2048;

/** Коды ошибок API: union, а не свободная строка, — расхождение ловится типами. */
export type ApiErrorCode =
  | "invalid_input"
  | "payload_too_large"
  | "not_found"
  | "not_ready"
  | "method_not_allowed"
  | "internal_error"
  | "not_configured"
  | "unauthorized"
  | "rate_limited"
  | "billing"
  | "model_timeout"
  | "model_error";

export class HttpError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly allow?: string;

  constructor(status: number, code: ApiErrorCode, message: string, allow?: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.allow = allow;
  }
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

function allowedOrigins(env: Env): string[] {
  const raw = env.ALLOWED_ORIGINS?.trim() ? env.ALLOWED_ORIGINS : DEFAULT_ALLOWED_ORIGINS;
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

/**
 * Разрешён ли источник: точное совпадение со списком ИЛИ превью-поддомен Pages.
 *
 * Cloudflare Pages выдаёт каждому превью адрес `<hash>.tidy-clone.pages.dev`, и
 * перечислять все хэши в `ALLOWED_ORIGINS` невозможно. Поэтому для каждого
 * настроенного `https://<name>.pages.dev` разрешаем ровно один дополнительный
 * поддомен-метку: `https://<preview>.` + `<name>.pages.dev`. Проверка — по
 * суффиксу с точкой, а не по `*`.
 */
export function isAllowedOrigin(origin: string, allowed: string[]): boolean {
  if (allowed.includes(origin)) return true;

  let hostname: string;
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:") return false;
    hostname = url.hostname.toLowerCase();
  } catch {
    return false;
  }

  for (const candidate of allowed) {
    let base: URL;
    try {
      base = new URL(candidate);
    } catch {
      continue;
    }
    if (base.protocol !== "https:") continue;
    const baseHost = base.hostname.toLowerCase();
    if (!baseHost.endsWith(".pages.dev")) continue;
    const suffix = `.${baseHost}`;
    if (!hostname.endsWith(suffix)) continue;
    const label = hostname.slice(0, -suffix.length);
    // Превью — ровно одна метка перед базовым домёном; вложенные поддомены не пускаем.
    if (label.length > 0 && !label.includes(".")) return true;
  }
  return false;
}

export function corsHeaders(request: Request, env: Env): Record<string, string> {
  const headers: Record<string, string> = {
    vary: "Origin",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": `content-type, ${CLIENT_TOKEN_HEADER}`,
    "access-control-expose-headers": "x-tidy-model, x-tidy-cost-rub",
    "access-control-max-age": "86400",
  };
  const origin = request.headers.get("Origin");
  if (origin && isAllowedOrigin(origin, allowedOrigins(env))) {
    headers["access-control-allow-origin"] = origin;
  }
  return headers;
}

// ---------------------------------------------------------------------------
// Ответы и ошибки
// ---------------------------------------------------------------------------

function jsonResponse(
  status: number,
  body: unknown,
  request: Request,
  env: Env,
  extra: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...corsHeaders(request, env),
      ...extra,
    },
  });
}

function errorResponse(
  status: number,
  code: ApiErrorCode,
  message: string,
  request: Request,
  env: Env,
  allow?: string,
): Response {
  return jsonResponse(status, { error: { code, message } }, request, env, allow ? { allow } : {});
}

/** Внутренние стектрейсы наружу не отдаём: только собственные безопасные сообщения. */
function toErrorResponse(error: unknown, request: Request, env: Env, path: string): Response {
  if (error instanceof HttpError) {
    return errorResponse(error.status, error.code, error.message, request, env, error.allow);
  }
  console.error(`[tidy-api] ${request.method} ${path} → 500: ${shortError(error)}`);
  return errorResponse(500, "internal_error", "Внутренняя ошибка воркера", request, env);
}

function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 200);
}

// ---------------------------------------------------------------------------
// Тело запроса
// ---------------------------------------------------------------------------

async function readJsonObject(request: Request, maxBytes: number): Promise<Record<string, unknown>> {
  // Если размер заявлен заголовком и уже превышает лимит — не читаем тело вовсе.
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await request.body?.cancel().catch(() => undefined);
    throw new HttpError(413, "payload_too_large", "Тело запроса слишком большое");
  }

  const bytes = await readBodyWithLimit(request, maxBytes);
  if (bytes.length === 0) {
    throw new HttpError(400, "invalid_input", "Пустое тело запроса");
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new HttpError(400, "invalid_input", "Тело запроса не является корректным UTF-8");
  }
  if (text.trim().length === 0) {
    throw new HttpError(400, "invalid_input", "Пустое тело запроса");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "invalid_input", "Тело запроса не является корректным JSON");
  }
  if (!isRecord(parsed)) {
    throw new HttpError(400, "invalid_input", "Тело запроса должно быть JSON-объектом");
  }
  return parsed;
}

/**
 * Читает тело потоком, считая байты, и обрывает чтение сразу при превышении лимита.
 *
 * `await request.text()` буферизует всё тело целиком: запрос без `Content-Length`
 * (chunked) обходил проверку и удерживал память до потолка Cloudflare. Здесь чтение
 * идёт reader'ом, и при первом же превышении `reader.cancel()` закрывает поток.
 */
async function readBodyWithLimit(request: Request, maxBytes: number): Promise<Uint8Array> {
  const body = request.body;
  if (!body) return new Uint8Array(0);

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new HttpError(413, "payload_too_large", "Тело запроса слишком большое");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "invalid_input", "Не удалось прочитать тело запроса");
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readDimension(value: unknown, field: "width" | "height"): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new HttpError(400, "invalid_input", `${field} должен быть целым числом`);
  }
  if (value < MIN_DIMENSION || value > MAX_DIMENSION) {
    throw new HttpError(400, "invalid_input", `${field} должен быть от ${MIN_DIMENSION} до ${MAX_DIMENSION}`);
  }
  return value;
}

function isValidBase64(value: string): boolean {
  const compact = value.replace(/\s+/g, "");
  if (compact.length === 0 || compact.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(compact);
}

/**
 * Constant-time сравнение токенов без раннего выхода по содержимому. Длины
 * смешиваются в аккумулятор, байты сравниваются XOR-ом по всей длине `max`:
 * ни префикс, ни позиция не влияют на время. `===` для секретов недопустим.
 */
function timingSafeTokenEqual(provided: string, expected: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(provided);
  const right = encoder.encode(expected);
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

/**
 * Барьер для защищённых маршрутов: клиентский токен PWA.
 * Нет секрета `CLIENT_TOKEN` → 503 `not_configured` (никакого «открыто по умолчанию»),
 * неверный/отсутствующий заголовок → 401 `unauthorized`.
 */
async function requireClientToken(request: Request, env: Env): Promise<void> {
  const expected = env.CLIENT_TOKEN?.trim();
  if (!expected) {
    throw new HttpError(503, "not_configured", "Сервис не настроен: не задан CLIENT_TOKEN");
  }
  const provided = request.headers.get(CLIENT_TOKEN_HEADER) ?? "";
  if (!timingSafeTokenEqual(provided, expected)) {
    throw new HttpError(401, "unauthorized", "Неверный или отсутствующий клиентский токен");
  }
}

/** Хэш IP клиента — ключ лимитера (в открытом виде IP не храним). */
async function rateLimitKey(request: Request): Promise<string> {
  const ip =
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type ProtectedRoute =
  | "generate"
  | "generation_status"
  | "generation_image"
  | "classify"
  | "models";

/**
 * Cloudflare Rate Limiting. Отсутствие binding в локальном запуске — не ошибка:
 * лимит просто не применяется. Сбой самого лимитера — fail-open, чтобы не ронять сервис.
 *
 * У генерации три правила: создание (5/мин, кадр платный), опрос статуса
 * (60/мин — клиент дёргает каждые ~3 с) и скачивание (10/мин — файл один на задачу).
 */
async function enforceRateLimit(request: Request, env: Env, route: ProtectedRoute): Promise<void> {
  const fallback = env.RATE_LIMITER;
  const limiter =
    route === "generate"
      ? env.GENERATE_RATE_LIMITER ?? fallback
      : route === "generation_status"
        ? env.GENERATION_STATUS_RATE_LIMITER ?? fallback
        : route === "generation_image"
          ? env.GENERATION_IMAGE_RATE_LIMITER ?? fallback
          : route === "classify"
            ? env.CLASSIFY_RATE_LIMITER ?? fallback
            : env.MODELS_RATE_LIMITER ?? fallback;
  if (!limiter || typeof limiter.limit !== "function") return;

  let outcome: { success: boolean };
  try {
    outcome = await limiter.limit({ key: await rateLimitKey(request) });
  } catch (error) {
    console.error(`[tidy-api] rate limiter error: ${shortError(error)}`);
    return;
  }
  if (!outcome.success) {
    throw new HttpError(429, "rate_limited", "Слишком много запросов, попробуйте позже");
  }
}

/** Токен проверяем первым: незачем тратить лимит на неаутентифицированные запросы. */
async function guardProtected(request: Request, env: Env, route: ProtectedRoute): Promise<void> {
  await requireClientToken(request, env);
  await enforceRateLimit(request, env, route);
}

/**
 * `fetch` с дедлайном, который реально отменяет запрос через `AbortSignal` —
 * **вместе с чтением тела**.
 *
 * Прежний вариант снимал таймаут в `finally` сразу после прихода заголовков,
 * поэтому `response.arrayBuffer()` на зависшем скачивании висел без ограничения
 * вовсе: воркер не мог вернуть ответ, а клиент видел «Не удалось связаться с
 * сервисом» при живом провайдере (ADR-0006, «Надёжность»). Здесь таймаут
 * гасится только после того, как тело прочитано.
 *
 * `504` — таймаут шлюза; ошибку сети обрабатывает вызывающий код как `502`.
 */
async function timedFetch<T>(
  url: string,
  init: RequestInit,
  ms: number,
  code: ApiErrorCode,
  read: (response: Response) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return await read(response);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new HttpError(504, code, "Модель не ответила за отведённое время");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Ответ провайдера, разобранный до JSON: статус нужен для маппинга ошибок. */
interface ProviderJson {
  status: number;
  ok: boolean;
  payload: unknown;
}

/**
 * Читает JSON-ответ провайдера под общим дедлайном. Нечитаемое тело на
 * ошибочном статусе не считается сбоем: маппингу ошибок нужен только код.
 */
async function readJsonTimed(url: string, init: RequestInit, ms: number): Promise<ProviderJson> {
  return await timedFetch(url, init, ms, "model_timeout", async (response) => {
    const payload: unknown = await response.json().catch(() => null);
    return { status: response.status, ok: response.ok, payload };
  });
}

/** Читает тело изображения под тем же дедлайном, что и заголовки. */
async function readBytesTimed(
  url: string,
  init: RequestInit,
  ms: number,
): Promise<{ status: number; ok: boolean; contentType: string; bytes: Uint8Array }> {
  return await timedFetch(url, init, ms, "model_timeout", async (response) => {
    const contentType = imageContentType(response.headers.get("content-type"));
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { status: response.status, ok: false, contentType, bytes: new Uint8Array(0) };
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { status: response.status, ok: true, contentType, bytes };
  });
}

// ---------------------------------------------------------------------------
// Маршруты
// ---------------------------------------------------------------------------

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  let path = "/";
  try {
    path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
  } catch {
    return errorResponse(400, "invalid_input", "Некорректный URL запроса", request, env);
  }

  if (request.method === "OPTIONS") {
    // Корректный preflight: 204 и CORS-заголовки (Allow-Origin — только для разрешённого источника).
    return new Response(null, { status: 204, headers: corsHeaders(request, env) });
  }

  try {
    if (path === "/health") {
      if (request.method !== "GET") throw methodNotAllowed("GET");
      return jsonResponse(
        200,
        { ok: true, generate: isGenerateConfigured(env), classify: hasVisionKey(env) },
        request,
        env,
      );
    }
    if (path === "/models") {
      if (request.method !== "GET") throw methodNotAllowed("GET");
      await guardProtected(request, env, "models");
      return await handleModels(request, env);
    }
    if (path === "/generate") {
      if (request.method !== "POST") throw methodNotAllowed("POST");
      await guardProtected(request, env, "generate");
      return await handleGenerate(request, env);
    }
    const generationRoute = /^\/generate\/([^/]+)(\/image)?$/.exec(path);
    if (generationRoute !== null) {
      if (request.method !== "GET") throw methodNotAllowed("GET");
      const taskId = readTaskId(generationRoute[1] ?? "");
      if (generationRoute[2] === "/image") {
        await guardProtected(request, env, "generation_image");
        return await handleGenerationImage(taskId, request, env);
      }
      await guardProtected(request, env, "generation_status");
      return await handleGenerationStatus(taskId, request, env);
    }
    if (path === "/classify") {
      if (request.method !== "POST") throw methodNotAllowed("POST");
      await guardProtected(request, env, "classify");
      return await handleClassify(request, env);
    }
    throw new HttpError(404, "not_found", "Маршрут не найден");
  } catch (error) {
    return toErrorResponse(error, request, env, path);
  }
}

function methodNotAllowed(allow: string): HttpError {
  return new HttpError(405, "method_not_allowed", `Поддерживается только метод ${allow}`, allow);
}

function hasVisionKey(env: Env): boolean {
  return (env.OPENCODE_API_KEY?.trim().length ?? 0) > 0;
}

function isGenerateConfigured(env: Env): boolean {
  return (env.ISKRAGEN_API_KEY?.trim().length ?? 0) > 0;
}

function providerBaseUrl(env: Env): string {
  return (env.ISKRAGEN_BASE_URL?.trim() || ISKRAGEN_BASE_URL).replace(/\/+$/, "");
}

function providerModel(env: Env): string {
  return env.ISKRAGEN_MODEL_SLUG?.trim() || ISKRAGEN_MODEL_SLUG;
}

/** Статусы, после которых опрашивать бессмысленно: задача уже провалилась. */
const TERMINAL_FAILED_STATUSES = new Set(["FAILED", "REFUNDED", "CANCELLED", "ENQUEUE_FAILED"]);

/** Статусы, в которых задача ещё идёт. */
const ACTIVE_STATUSES = new Set(["PENDING", "PROCESSING"]);

/** Задача генерации у провайдера: её id, статус и удержанная стоимость. */
interface GenerationTask {
  id: string;
  status: string;
  costRub: number | null;
}

/** Максимум символов `Idempotency-Key`: ограничение провайдера (1–64). */
const MAX_IDEMPOTENCY_KEY_CHARS = 64;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;

/**
 * Разбирает `idempotencyKey` из тела. Ключ необязателен (старые клиенты),
 * но заданный обязан быть безопасной строкой: он уйдёт провайдеру заголовком.
 */
function readIdempotencyKey(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new HttpError(400, "invalid_input", "Поле idempotencyKey должно быть строкой");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > MAX_IDEMPOTENCY_KEY_CHARS || !IDEMPOTENCY_KEY_PATTERN.test(trimmed)) {
    throw new HttpError(
      400,
      "invalid_input",
      `Поле idempotencyKey: от 1 до ${MAX_IDEMPOTENCY_KEY_CHARS} символов [A-Za-z0-9._:-]`,
    );
  }
  return trimmed;
}

/**
 * Ставит задачу у провайдера и сразу возвращает её id (ADR-0006, раздел 3):
 * ни статус, ни файл здесь не ждём — их клиент забирает сам.
 *
 * `Idempotency-Key` пробрасывается как есть: повторный `POST` с тем же ключом
 * возвращает существующую задачу без повторного списания, поэтому потерянный
 * ответ (обрыв сети, закрытая вкладка) не стоит второй оплаты.
 */
async function createGeneration(
  apiKey: string,
  env: Env,
  prompt: string,
  model: ImageModel,
  inputUrl: string | null = null,
  idempotencyKey?: string,
): Promise<GenerationTask> {
  const base = providerBaseUrl(env);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
  };
  if (idempotencyKey !== undefined) headers["Idempotency-Key"] = idempotencyKey;

  let reply: ProviderJson;
  try {
    reply = await readJsonTimed(
      `${base}/generations`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          modelSlug: model.slug,
          prompt,
          params: generationParams(model, inputUrl),
        }),
      },
      IMAGE_DOWNLOAD_TIMEOUT_MS,
    );
  } catch (error) {
    if (error instanceof HttpError) throw error;
    console.error(`[tidy-api] generate: провайдер недоступен: ${shortError(error)}`);
    throw new HttpError(502, "model_error", "Сервис генерации недоступен");
  }

  if (!reply.ok) throw generationUpstreamError(reply.status, "create");

  const payload = reply.payload;
  const id = isRecord(payload) && typeof payload.id === "string" ? payload.id : "";
  if (id.length === 0) {
    console.error("[tidy-api] generate: провайдер не вернул id задачи");
    throw new HttpError(502, "model_error", "Сервис генерации вернул некорректный ответ");
  }
  const status =
    isRecord(payload) && typeof payload.status === "string" ? payload.status : "PENDING";
  const costRub = isRecord(payload) && typeof payload.costRub === "number" ? payload.costRub : null;
  return { id, status, costRub };
}

/**
 * Параметры кадра конкретной модели плюс ссылка на загруженный референс (D13).
 * Ключ подсказывает сам каталог модели (`paramsSchema`): `input_urls` у Flux и
 * GPT Image 2, `image_urls` у Grok и Qwen, `image_input` у Nano Banana.
 */
function generationParams(
  model: ImageModel,
  inputUrl: string | null,
): Record<string, string | string[]> {
  const params: Record<string, string | string[]> = { ...frameParams(model) };
  if (inputUrl !== null && model.imageInputParam !== null) {
    params[model.imageInputParam] = [inputUrl];
  }
  return params;
}

/** Расширение файла из MIME; провайдеру пофиг имя, но пустое тоже не годится. */
function referenceFileName(mime: string): string {
  const known = new Map([
    ["image/jpeg", "jpg"],
    ["image/png", "png"],
    ["image/webp", "webp"],
  ]);
  return `reference.${known.get(mime) ?? "bin"}`;
}

/**
 * Загружает входное изображение провайдеру и возвращает его URL (D13).
 * i2i-модели IskraGen принимают только ссылки на файлы: `POST /v1/files/`
 * отвечает `201 {url, ...}`. Дедупликации нет — каждый кадр грузит свою копию.
 */
async function uploadInputFile(
  apiKey: string,
  env: Env,
  bytes: Uint8Array,
  mimeType: string,
): Promise<string> {
  const base = providerBaseUrl(env);
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mimeType }), referenceFileName(mimeType));

  let reply: ProviderJson;
  try {
    reply = await readJsonTimed(
      `${base}/files/`,
      { method: "POST", headers: { authorization: `Bearer ${apiKey}` }, body: form },
      IMAGE_DOWNLOAD_TIMEOUT_MS,
    );
  } catch (error) {
    if (error instanceof HttpError) throw error;
    console.error(`[tidy-api] generate: загрузка референса недоступна: ${shortError(error)}`);
    throw new HttpError(502, "model_error", "Сервис генерации недоступен");
  }

  if (!reply.ok) throw generationUpstreamError(reply.status, "upload");

  const payload = reply.payload;
  const url = isRecord(payload) && typeof payload.url === "string" ? payload.url : "";
  if (url.length === 0) {
    console.error("[tidy-api] generate: провайдер не вернул url загруженного файла");
    throw new HttpError(502, "model_error", "Сервис генерации не принял входное изображение");
  }
  return url;
}

/** Декодирует base64 в байты; корректность строки проверяет вызвавший код. */
function decodeBase64Bytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Текущий статус задачи у провайдера. Опрашивается клиентом, не воркером. */
async function fetchGenerationState(
  base: string,
  apiKey: string,
  id: string,
  timeoutMs: number,
): Promise<{ status: string; costRub: number | null }> {
  let reply: ProviderJson;
  try {
    reply = await readJsonTimed(
      `${base}/generations/${encodeURIComponent(id)}`,
      { headers: { authorization: `Bearer ${apiKey}` } },
      timeoutMs,
    );
  } catch (error) {
    if (error instanceof HttpError) throw error;
    console.error(`[tidy-api] generate: статус недоступен: ${shortError(error)}`);
    throw new HttpError(502, "model_error", "Сервис генерации недоступен");
  }

  if (!reply.ok) throw generationUpstreamError(reply.status, "poll");

  const payload = reply.payload;
  if (!isRecord(payload) || typeof payload.status !== "string") {
    throw new HttpError(502, "model_error", "Сервис генерации вернул некорректный ответ");
  }
  return {
    status: payload.status,
    costRub: typeof payload.costRub === "number" ? payload.costRub : null,
  };
}

/** Байты готового результата; отдельный запрос, а не тело статуса. */
async function downloadResult(
  base: string,
  apiKey: string,
  id: string,
  timeoutMs: number,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  let reply: {
    status: number;
    ok: boolean;
    contentType: string;
    bytes: Uint8Array;
  };
  try {
    reply = await readBytesTimed(
      `${base}/generations/${encodeURIComponent(id)}/download?index=0`,
      { headers: { authorization: `Bearer ${apiKey}` } },
      timeoutMs,
    );
  } catch (error) {
    if (error instanceof HttpError) throw error;
    console.error(`[tidy-api] generate: скачивание не удалось: ${shortError(error)}`);
    throw new HttpError(502, "model_error", "Не удалось скачать готовое изображение");
  }

  if (!reply.ok) throw generationUpstreamError(reply.status, "download");

  const contentType = reply.contentType;
  if (contentType.length === 0) {
    console.error("[tidy-api] generate: провайдер вернул не изображение");
    throw new HttpError(502, "model_error", "Сервис генерации вернул не изображение");
  }

  const bytes = reply.bytes;
  if (bytes.length === 0) {
    throw new HttpError(502, "model_error", "Сервис генерации вернул пустое изображение");
  }
  if (bytes.length > MAX_GENERATE_IMAGE_BYTES) {
    console.error(`[tidy-api] generate: результат ${bytes.length} байт больше потолка`);
    throw new HttpError(502, "model_error", "Сервис генерации вернул слишком большое изображение");
  }
  return { bytes, contentType };
}

function imageContentType(raw: string | null): string {
  const value = (raw ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  return value.startsWith("image/") ? value : "";
}

/**
 * HTTP-ошибки провайдера в наши коды. Баланс и лимит частоты — отдельные коды:
 * клиент по ним не ретраит, а показывает понятный текст.
 */
function generationUpstreamError(
  status: number,
  stage: "create" | "poll" | "download" | "upload",
): HttpError {
  console.error(`[tidy-api] generate: провайдер ${stage} ответил ${status}`);
  // 404 только у поллинга/скачивания: задача провайдера неизвестна (истекла
  // или чужой id) — это «не найдено», а не сбой шлюза.
  if (status === 404 && (stage === "poll" || stage === "download")) {
    return new HttpError(404, "not_found", "Задача генерации не найдена");
  }
  if (status === 402) return new HttpError(402, "billing", "Закончился баланс генерации");
  if (status === 429) {
    return new HttpError(429, "rate_limited", "Сервис генерации ограничил частоту запросов");
  }
  if (status === 401 || status === 403) {
    return new HttpError(503, "not_configured", "Сервис генерации отклонил ключ или модель");
  }
  return new HttpError(502, "model_error", "Сервис генерации вернул ошибку");
}

/**
 * Модель для конкретного запроса. Клиент может выбрать из каталога; без
 * выбора работает модель из `ISKRAGEN_MODEL_SLUG` (совместимость с прежним
 * контрактом). Произвольный slug не принимаем: только известные модели.
 *
 * С картинкой (D13) выбранная т2и-модель заменяется на `DEFAULT_IMAGE_TO_IMAGE_MODEL_SLUG`:
 * в приложении могли остаться сохранённые выборы из т2и-каталога D12, и молчаливый
 * отказ «модель не берёт референс» ломал бы весь поток оцифровки. Фактическая
 * модель честно возвращается в заголовке `x-tidy-model` и в логе.
 */
function selectImageModel(value: unknown, env: Env, withInputImage: boolean): ImageModel {
  const fallbackIfNeeded = (model: ImageModel): ImageModel => {
    if (!withInputImage || model.imageInputParam !== null) return model;
    const replacement =
      findImageModel(DEFAULT_IMAGE_TO_IMAGE_MODEL_SLUG) ??
      ({
        slug: DEFAULT_IMAGE_TO_IMAGE_MODEL_SLUG,
        title: DEFAULT_IMAGE_TO_IMAGE_MODEL_SLUG,
        priceRub: 0,
        aspectParam: "aspect_ratio" as const,
        supportsResolution: true,
        imageInputParam: null,
      } satisfies ImageModel);
    console.error(
      `[tidy-api] generate: модель ${model.slug} не принимает референс, подставлена ${replacement.slug}`,
    );
    return replacement;
  };

  if (value === undefined || value === null) {
    const configured = providerModel(env);
    return fallbackIfNeeded(
      findImageModel(configured) ?? {
        // Конфиг может указывать на модель вне нашего каталога — не ломаем
        // старый сценарий, но и не обещаем ей каталог в UI. Референс не указываем:
        // если с картинкой — fallbackIfNeeded подставит известную i2i-модель.
        slug: configured,
        title: configured,
        priceRub: 0,
        aspectParam: "aspect_ratio",
        supportsResolution: true,
        imageInputParam: null,
      },
    );
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpError(400, "invalid_input", "Поле model должно быть непустой строкой");
  }
  const model = findImageModel(value.trim());
  if (model === undefined) {
    throw new HttpError(400, "invalid_input", "Неизвестная модель генерации");
  }
  return fallbackIfNeeded(model);
}

/** Свежие цены из публичного каталога провайдера; сбой не должен ломать выбор. */
async function readCatalogPrices(env: Env): Promise<Map<string, number>> {
  const apiKey = env.ISKRAGEN_API_KEY?.trim();
  const headers: Record<string, string> = {};
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  let reply: ProviderJson;
  try {
    reply = await readJsonTimed(`${providerBaseUrl(env)}/catalog/`, { headers }, MODELS_TIMEOUT_MS);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    console.error(`[tidy-api] models: каталог недоступен: ${shortError(error)}`);
    throw new HttpError(502, "model_error", "Каталог моделей недоступен");
  }
  if (!reply.ok) {
    throw new HttpError(502, "model_error", "Каталог моделей недоступен");
  }

  const payload: unknown = reply.payload;
  const prices = new Map<string, number>();
  if (!isRecord(payload) || !Array.isArray(payload.models)) return prices;
  for (const item of payload.models) {
    if (!isRecord(item)) continue;
    const slug = item.slug;
    const price = item.sellPriceRub;
    if (typeof slug === "string" && typeof price === "number" && Number.isFinite(price)) {
      prices.set(slug, price);
    }
  }
  return prices;
}

/**
 * Каталог для выбора в приложении. Отдаём IMAGE-модели каталога (т2и и i2i,
 * `IMAGE_MODELS`) и подтягиваем цены провайдера; если каталог недоступен —
 * остаются цены из `models.ts`, чтобы выбор и генерация работали без лишнего
 * запроса.
 */
async function handleModels(request: Request, env: Env): Promise<Response> {
  let prices = new Map<string, number>();
  try {
    prices = await readCatalogPrices(env);
  } catch (error) {
    console.error(`[tidy-api] GET /models: каталог недоступен: ${shortError(error)}`);
  }

  const models = IMAGE_MODELS.map((model) => ({
    slug: model.slug,
    title: model.title,
    priceRub: prices.get(model.slug) ?? model.priceRub,
  }));
  const configured = providerModel(env);
  const defaultSlug =
    findImageModel(configured)?.slug ?? DEFAULT_IMAGE_MODEL_SLUG;

  return jsonResponse(
    200,
    { models, defaultSlug, pricesLive: prices.size > 0 },
    request,
    env,
  );
}

async function handleGenerate(request: Request, env: Env): Promise<Response> {
  const body = await readJsonObject(request, MAX_GENERATE_BODY_BYTES);

  const rawPrompt = body.prompt;
  if (typeof rawPrompt !== "string" || rawPrompt.trim().length === 0) {
    throw new HttpError(400, "invalid_input", "Поле prompt обязательно и не должно быть пустым");
  }
  const promptChars = Array.from(rawPrompt).length;
  if (promptChars > MAX_PROMPT_CHARS) {
    throw new HttpError(400, "invalid_input", `Промпт длиннее ${MAX_PROMPT_CHARS} символов`);
  }

  // Клиент присылает квадратный кадр. Провайдер задаёт размер через
  // `params.aspect_ratio` + `resolution`, поэтому width/height валидируем,
  // но в запрос не передаём: 1:1 + 1K — то, что ждут сетка и коллаж.
  readDimension(body.width, "width");
  readDimension(body.height, "height");
  if (body.width !== undefined || body.height !== undefined) {
    console.log("[tidy-api] размер кадра задан провайдеру как 1:1 / 1K");
  }

  // Входное изображение (D13): Оригинал в base64 — референс для image-to-image
  // перерисовки. Допускаем и «чистый» base64, и data URL, как в `/classify`.
  const rawInputImage = typeof body.imageBase64 === "string" ? body.imageBase64.trim() : "";
  const hasInputImage = rawInputImage.length > 0;
  let inputImage: { bytes: Uint8Array; mime: string } | null = null;
  if (hasInputImage) {
    const dataUrl = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(rawInputImage);
    const base64 = (dataUrl ? dataUrl[2] : rawInputImage).replace(/\s+/g, "");
    const declaredMime =
      typeof body.mimeType === "string" && body.mimeType.trim().length > 0
        ? body.mimeType
        : (dataUrl?.[1] ?? "");
    const mimeType = (declaredMime.toLowerCase().split(";")[0] ?? "").trim();
    if (mimeType.length === 0) {
      throw new HttpError(400, "invalid_input", "Поле mimeType обязательно вместе с imageBase64");
    }
    if (!GENERATE_INPUT_MIME_TYPES.has(mimeType)) {
      throw new HttpError(400, "invalid_input", "Недопустимый mimeType входного изображения");
    }
    if (!isValidBase64(base64)) {
      throw new HttpError(400, "invalid_input", "imageBase64 не является корректной base64-строкой");
    }
    const bytes = decodeBase64Bytes(base64);
    if (bytes.length === 0) {
      throw new HttpError(400, "invalid_input", "Входное изображение пустое");
    }
    if (bytes.length > MAX_GENERATE_INPUT_BYTES) {
      throw new HttpError(400, "invalid_input", "Входное изображение слишком большое для генерации");
    }
    inputImage = { bytes, mime: mimeType };
  }

  const model = selectImageModel(body.model, env, hasInputImage);
  // Ключ идемпотентности валидируем до оплачиваемых шагов: неверный ключ —
  // это 400, а не «провайдер отклонил заголовок».
  const idempotencyKey = readIdempotencyKey(body.idempotencyKey);

  const apiKey = env.ISKRAGEN_API_KEY?.trim();
  if (!apiKey) {
    throw new HttpError(503, "not_configured", "Генерация недоступна: не настроен ключ ISKRAGEN_API_KEY");
  }

  const started = Date.now();
  // Успешная загрузка референса сдвигает точку невозврата: файл уже у провайдера,
  // поэтому загрузка идёт до создания задачи.
  const inputUrl =
    inputImage === null
      ? null
      : await uploadInputFile(apiKey, env, inputImage.bytes, inputImage.mime);
  const task = await createGeneration(apiKey, env, rawPrompt, model, inputUrl, idempotencyKey);
  console.log(
    `[tidy-api] POST /generate → 202, задача ${task.id}, ` +
      `модель ${model.slug}, ${Date.now() - started} мс, ` +
      `статус ${task.status}, стоимость ${task.costRub ?? "?"} ₽, ` +
      `промпт ${promptChars} символов` +
      `${inputUrl === null ? "" : ", i2i-референс загружен"}` +
      `${idempotencyKey === undefined ? "" : ", ключ задан"}`,
  );

  return jsonResponse(
    202,
    { taskId: task.id, status: task.status, costRub: task.costRub, model: model.slug },
    request,
    env,
    {
      "x-tidy-model": model.slug,
      ...(task.costRub === null ? {} : { "x-tidy-cost-rub": String(task.costRub) }),
    },
  );
}

/** Валидирует `taskId` из пути: он уходит провайдеру в URL без кодирования-сюрпризов. */
function readTaskId(raw: string): string {
  let taskId: string;
  try {
    taskId = decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, "invalid_input", "Некорректный идентификатор задачи");
  }
  if (taskId.length === 0 || taskId.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(taskId)) {
    throw new HttpError(400, "invalid_input", "Некорректный идентификатор задачи");
  }
  return taskId;
}

function requireGenerateKey(env: Env): string {
  const apiKey = env.ISKRAGEN_API_KEY?.trim();
  if (!apiKey) {
    throw new HttpError(503, "not_configured", "Генерация недоступна: не настроен ключ ISKRAGEN_API_KEY");
  }
  return apiKey;
}

/**
 * Статус задачи для авто-опроса клиента. Возвращает статус провайдера как есть
 * (`PENDING`/`PROCESSING`/`SUCCEEDED`/`FAILED`) и удержанную стоимость.
 */
async function handleGenerationStatus(
  taskId: string,
  request: Request,
  env: Env,
): Promise<Response> {
  const apiKey = requireGenerateKey(env);
  const state = await fetchGenerationState(
    providerBaseUrl(env),
    apiKey,
    taskId,
    GENERATE_STATUS_TIMEOUT_MS,
  );
  console.log(
    `[tidy-api] GET /generate/${taskId} → 200, статус ${state.status}, ` +
      `стоимость ${state.costRub ?? "?"} ₽`,
  );
  return jsonResponse(
    200,
    { taskId, status: state.status, costRub: state.costRub },
    request,
    env,
    state.costRub === null ? {} : { "x-tidy-cost-rub": String(state.costRub) },
  );
}

/**
 * Байты готовой картинки. Отдельный запрос от статуса (ADR-0006): файл не
 * должен висеть в теле опроса, который клиент дёргает каждые ~3 с.
 * До `SUCCEEDED` — 409 `not_ready`: это не ошибка сервиса, а ранний запрос.
 */
async function handleGenerationImage(
  taskId: string,
  request: Request,
  env: Env,
): Promise<Response> {
  const apiKey = requireGenerateKey(env);
  const base = providerBaseUrl(env);
  const state = await fetchGenerationState(base, apiKey, taskId, GENERATE_STATUS_TIMEOUT_MS);
  if (state.status !== "SUCCEEDED") {
    if (TERMINAL_FAILED_STATUSES.has(state.status)) {
      throw new HttpError(409, "not_ready", "Генерация не удалась — изображение не появится");
    }
    if (!ACTIVE_STATUSES.has(state.status)) {
      throw new HttpError(409, "not_ready", `Неизвестный статус задачи: ${state.status}`);
    }
    throw new HttpError(409, "not_ready", "Изображение ещё не готово");
  }

  const downloaded = await downloadResult(base, apiKey, taskId, IMAGE_DOWNLOAD_TIMEOUT_MS);
  console.log(
    `[tidy-api] GET /generate/${taskId}/image → 200, ${downloaded.bytes.length} байт, ` +
      `стоимость ${state.costRub ?? "?"} ₽`,
  );
  return new Response(downloaded.bytes, {
    status: 200,
    headers: {
      "content-type": downloaded.contentType,
      "cache-control": "no-store",
      ...(state.costRub === null ? {} : { "x-tidy-cost-rub": String(state.costRub) }),
      ...corsHeaders(request, env),
    },
  });
}

async function handleClassify(request: Request, env: Env): Promise<Response> {
  const body = await readJsonObject(request, MAX_CLASSIFY_BODY_BYTES);

  const rawImage = typeof body.imageBase64 === "string" ? body.imageBase64.trim() : "";
  if (rawImage.length === 0) {
    throw new HttpError(400, "invalid_input", "Поле imageBase64 обязательно");
  }

  // Допускаем как «чистый» base64, так и data URL — на случай, если клиент передаст его целиком.
  const dataUrl = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(rawImage);
  const base64 = (dataUrl ? dataUrl[2] : rawImage).replace(/\s+/g, "");

  const declaredMime = typeof body.mimeType === "string" && body.mimeType.trim().length > 0
    ? body.mimeType
    : (dataUrl?.[1] ?? "");
  if (declaredMime.trim().length === 0) {
    throw new HttpError(400, "invalid_input", "Поле mimeType обязательно");
  }
  const mimeType = (declaredMime.toLowerCase().split(";")[0] ?? "").trim();
  if (!IMAGE_MIME_TYPES.has(mimeType)) {
    throw new HttpError(400, "invalid_input", "Недопустимый mimeType изображения");
  }
  if (!isValidBase64(base64)) {
    throw new HttpError(400, "invalid_input", "imageBase64 не является корректной base64-строкой");
  }

  // Ключа нет — это не сбой воркера, а ненастроенное окружение: 503 и понятный код.
  const apiKey = env.OPENCODE_API_KEY?.trim();
  if (!apiKey) {
    throw new HttpError(503, "not_configured", "Распознавание недоступно: не настроен ключ OPENCODE_API_KEY");
  }

  const content = await callVisionModel(apiKey, base64, mimeType);
  const classification: Classification = classifyFromModel(content.parsed);
  console.log(
    `[tidy-api] POST /classify → 200, ${classification.category}/${classification.subcategory}, ` +
      `изображение ${base64.length} символов, модель ответила ${content.raw ? "да" : "нет"}`,
  );
  return jsonResponse(200, classification, request, env);
}

interface VisionResult {
  parsed: ParsedModelResponse;
  raw: boolean;
}

/** Разобранный ответ модели: либо JSON-объект, либо null (мусор → «Разное»). */
export type ParsedModelResponse = Record<string, unknown> | null;

async function callVisionModel(apiKey: string, base64: string, mimeType: string): Promise<VisionResult> {
  const payload = {
    model: VISION_MODEL,
    messages: [
      { role: "system", content: CLASSIFY_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: "Определи категорию и подкатегорию вещи на фото. Ответ — строго JSON." },
          { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } },
        ],
      },
    ],
    max_tokens: VISION_MAX_TOKENS,
    stream: false,
  };

  let reply: ProviderJson;
  try {
    reply = await readJsonTimed(
      `${VISION_BASE_URL}/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
          [OPENCODE_SESSION_HEADER]: newOpencodeSessionId(),
        },
        body: JSON.stringify(payload),
      },
      CLASSIFY_TIMEOUT_MS,
    );
  } catch (error) {
    if (error instanceof HttpError) throw error;
    console.error(`[tidy-api] classify upstream error: ${shortError(error)}`);
    throw new HttpError(502, "model_error", "Сервис распознавания недоступен");
  }

  if (!reply.ok) {
    console.error(`[tidy-api] classify upstream status ${reply.status}`);
    throw new HttpError(502, "model_error", `Сервис распознавания вернул ошибку (${reply.status})`);
  }

  const json: unknown = reply.payload;
  if (json === null) {
    console.error("[tidy-api] classify: некорректный JSON от провайдера");
    throw new HttpError(502, "model_error", "Сервис распознавания вернул некорректный ответ");
  }

  const raw = readVisionText(json);
  if (raw === null) {
    // Провайдер ответил, но текста нет — считаем ответ мусорным и уходим в «Разное».
    return { parsed: null, raw: false };
  }
  return { parsed: parseModelJson(raw), raw: true };
}

function readVisionText(json: unknown): string | null {
  if (!isRecord(json)) return null;
  const choices = json.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const message = isRecord(choices[0]) ? choices[0].message : undefined;
  if (!isRecord(message)) return null;

  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content
      .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
      .join("");
    return text.length > 0 ? text : null;
  }
  return null;
}

/** Достаёт JSON из ответа модели: чистый, в ```-ограждении или с текстом вокруг. */
export function parseModelJson(raw: string): ParsedModelResponse {
  const trimmed = raw.trim();
  const candidates: string[] = [trimmed];

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));

  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate) as unknown;
      if (isRecord(value)) return value;
    } catch {
      // пробуем следующий вариант
    }
  }
  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
};

// Экспортируем fallback-константы, чтобы тесты и клиенты не хардкодили «Разное».
export { FALLBACK_CATEGORY, FALLBACK_SUBCATEGORY };
