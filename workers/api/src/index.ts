/**
 * T3 · Воркер-посредник `tidy-api` (Cloudflare Workers).
 *
 * Зачем посредник (ADR-0003): браузер не может звать AI-API напрямую из-за CORS,
 * а токены не должны лежать на телефоне. Секреты живут только здесь:
 *   - Workers AI доступен через binding `AI` (аккаунт Cloudflare);
 *   - vision-модель (провайдер `opencode-go`) — через секрет `OPENCODE_API_KEY`.
 * В клиент ничего из этого не попадает.
 *
 * Маршруты:
 *   POST /generate  {prompt, width?, height?} → image/jpeg байтами
 *   POST /classify  {imageBase64, mimeType}   → {category, subcategory, confidence}
 *   GET  /health                              → {ok, ai}
 */

import {
  CLASSIFY_SYSTEM_PROMPT,
  FALLBACK_CATEGORY,
  FALLBACK_SUBCATEGORY,
  classifyFromModel,
  type Classification,
} from "./taxonomy";
import { CLASSIFY_TIMEOUT_MS } from "./config";

/** Опции Workers AI: `signal` позволяет отменить подзапрос при таймауте. */
export interface AiRunOptions {
  signal?: AbortSignal;
}

export interface AiBinding {
  run(model: string, input: Record<string, unknown>, options?: AiRunOptions): Promise<unknown>;
}

/** Binding Cloudflare Rate Limiting (`ratelimits` в wrangler.jsonc). */
export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  /** Binding Workers AI (`ai.binding = "AI"` в wrangler.jsonc). */
  AI?: AiBinding;
  /** Секрет: ключ провайдера `opencode-go`. В репозиторий не попадает. */
  OPENCODE_API_KEY?: string;
  /**
   * Секрет: клиентский токен PWA (`wrangler secret put CLIENT_TOKEN`).
   * Если не задан — защищённые маршруты отвечают 503 `not_configured`.
   */
  CLIENT_TOKEN?: string;
  /** Список источников через запятую. Переопределяется var-ом `ALLOWED_ORIGINS`. */
  ALLOWED_ORIGINS?: string;
  /** Лимитер генерации (20 запросов/мин). */
  GENERATE_RATE_LIMITER?: RateLimitBinding;
  /** Лимитер классификации (40 запросов/мин). */
  CLASSIFY_RATE_LIMITER?: RateLimitBinding;
  /** Общий лимитер: fallback, если отдельные bindings не сконфигурированы. */
  RATE_LIMITER?: RateLimitBinding;
}

export const GENERATE_MODEL = "@cf/black-forest-labs/flux-1-schnell";
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

const DEFAULT_ALLOWED_ORIGINS = "https://tidy-clone.pages.dev,http://localhost:5173";

const MAX_PROMPT_CHARS = 800;
const MAX_GENERATE_BODY_BYTES = 16 * 1024;
const MAX_CLASSIFY_BODY_BYTES = 4 * 1024 * 1024;
const MIN_DIMENSION = 256;
const MAX_DIMENSION = 2048;
const GENERATE_TIMEOUT_MS = 30_000;

const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);

/** Ответы vision-модели ограничиваем бюджетом токенов: нужен только короткий JSON.
 *  DeepSeek V4.1 Flash — reasoning-модель, поэтому запас должен покрывать и рассуждение. */
const VISION_MAX_TOKENS = 2048;

/** Коды ошибок API: union, а не свободная строка, — расхождение ловится типами. */
export type ApiErrorCode =
  | "invalid_input"
  | "payload_too_large"
  | "not_found"
  | "method_not_allowed"
  | "internal_error"
  | "not_configured"
  | "unauthorized"
  | "rate_limited"
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

export type ProtectedRoute = "generate" | "classify";

/**
 * Cloudflare Rate Limiting. Отсутствие binding в локальном запуске — не ошибка:
 * лимит просто не применяется. Сбой самого лимитера — fail-open, чтобы не ронять сервис.
 */
async function enforceRateLimit(request: Request, env: Env, route: ProtectedRoute): Promise<void> {
  const limiter =
    route === "generate"
      ? env.GENERATE_RATE_LIMITER ?? env.RATE_LIMITER
      : env.CLASSIFY_RATE_LIMITER ?? env.RATE_LIMITER;
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
 * Workers AI с настоящей отменой подзапроса. `env.AI.run(model, input, { signal })`
 * умеет прерывать работу по `AbortSignal`, поэтому по таймауту генерация govt
 * останавливается и нейроны больше не тратятся (прежний `withTimeout` лишь
 * отбрасывал промис, а подзапрос продолжал жить).
 */
async function runAiWithTimeout(
  ai: AiBinding,
  model: string,
  input: Record<string, unknown>,
  ms: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await ai.run(model, input, { signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new HttpError(504, "model_timeout", "Модель не ответила за отведённое время");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `fetch` с таймаутом, который реально отменяет запрос через `AbortSignal`.
 * `withTimeout` без отмены оставляет подвисший подзапрос живым: воркер не
 * может вернуть ответ, и клиентское соединение обрывается. `504` — таймаут
 * шлюза; ошибку сети обрабатывает вызывающий код как `502`.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  ms: number,
  code: ApiErrorCode,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new HttpError(504, code, "Модель не ответила за отведённое время");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
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
      return jsonResponse(200, { ok: true, ai: isAiAvailable(env) }, request, env);
    }
    if (path === "/generate") {
      if (request.method !== "POST") throw methodNotAllowed("POST");
      await guardProtected(request, env, "generate");
      return await handleGenerate(request, env);
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

function isAiAvailable(env: Env): boolean {
  return typeof env.AI?.run === "function";
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

  // width/height валидируем и принимаем в API, но у flux-1-schnell фиксированный кадр
  // (его схема допускает только `prompt` и `steps`, additionalProperties: false),
  // поэтому в модель они не уходят. Поля оставлены на будущие модели с выбором размера.
  readDimension(body.width, "width");
  readDimension(body.height, "height");
  if (body.width !== undefined || body.height !== undefined) {
    console.log("[tidy-api] размер кадра проигнорирован: flux-1-schnell отдаёт 1024x1024");
  }

  const ai = env.AI;
  if (!ai || typeof ai.run !== "function") {
    throw new HttpError(500, "internal_error", "Workers AI недоступен");
  }

  let output: unknown;
  try {
    output = await runAiWithTimeout(ai, GENERATE_MODEL, { prompt: rawPrompt, steps: 4 }, GENERATE_TIMEOUT_MS);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    console.error(`[tidy-api] generate model error: ${shortError(error)}`);
    throw new HttpError(502, "model_error", "Модель генерации вернула ошибку");
  }

  const bytes = await readImageBytes(output);
  if (!bytes || bytes.length === 0) {
    console.error("[tidy-api] generate: модель вернула пустой ответ");
    throw new HttpError(502, "model_error", "Модель генерации вернула пустой ответ");
  }

  console.log(`[tidy-api] POST /generate → 200, ${bytes.length} байт, промпт ${promptChars} символов`);
  return new Response(bytes, {
    status: 200,
    headers: {
      "content-type": "image/jpeg",
      "cache-control": "no-store",
      ...corsHeaders(request, env),
    },
  });
}

/** Binding Workers AI умеет отдавать и Response, и объект с base64. */
async function readImageBytes(output: unknown): Promise<Uint8Array | null> {
  if (output instanceof Response) {
    return new Uint8Array(await output.arrayBuffer());
  }
  if (isRecord(output) && typeof output.image === "string") {
    return decodeBase64(output.image);
  }
  return null;
}

function decodeBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
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

  let response: Response;
  try {
    response = await fetchWithTimeout(
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
      "model_timeout",
    );
  } catch (error) {
    if (error instanceof HttpError) throw error;
    console.error(`[tidy-api] classify upstream error: ${shortError(error)}`);
    throw new HttpError(502, "model_error", "Сервис распознавания недоступен");
  }

  if (!response.ok) {
    console.error(`[tidy-api] classify upstream status ${response.status}`);
    throw new HttpError(502, "model_error", `Сервис распознавания вернул ошибку (${response.status})`);
  }

  let json: unknown;
  try {
    json = (await response.json()) as unknown;
  } catch {
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
