import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CLIENT_TOKEN_HEADER,
  handleRequest,
  OPENCODE_SESSION_HEADER,
  parseModelJson,
  type Env,
} from "./index";
import {
  CLASSIFY_TIMEOUT_MS,
  DEFAULT_FRAME_SIZE,
  IMAGE_DOWNLOAD_TIMEOUT_MS,
  MAX_GENERATE_BODY_BYTES,
  MAX_GENERATE_INPUT_BYTES,
} from "./config";
import {
  CLASSIFY_SYSTEM_PROMPT,
  FALLBACK_CATEGORY,
  FALLBACK_SUBCATEGORY,
  TAXONOMY,
  classifyFromModel,
  isKnownCategory,
  isKnownSubcategory,
  subcategoriesOf,
  topCategories,
} from "./taxonomy";

const BASE = "https://tidy-api.test";
const ORIGIN = "http://localhost:5173";
const OTHER_ORIGIN = "https://tidy-clone.pages.dev";
const CLIENT_TOKEN = "test-client-token";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ALLOWED_ORIGINS: `${OTHER_ORIGIN},${ORIGIN}`,
    CLIENT_TOKEN,
    ...overrides,
  };
}

function get(path: string, origin?: string, token?: string): Request {
  const headers: Record<string, string> = {};
  if (origin) headers.origin = origin;
  if (token) headers[CLIENT_TOKEN_HEADER] = token;
  return new Request(`${BASE}${path}`, { method: "GET", headers });
}

interface PostOptions {
  /** `null` — не отправлять заголовок; строка — отправить заданный токен. */
  token?: string | null;
  /** Готовый Request (chunked/сырое тело) — заменяет автогенерируемый. */
  request?: Request;
}

function authHeaders(token: string | null | undefined, origin?: string): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (origin) headers.origin = origin;
  if (token !== null) headers[CLIENT_TOKEN_HEADER] = token ?? CLIENT_TOKEN;
  return headers;
}

/** Тело `/generate` ровно `targetBytes` байт: prompt ровно 800 ASCII-символов + padding. */
function generateBody(targetBytes: number): string {
  const prefix = '{"prompt":"';
  const middle = '","padding":"';
  const suffix = '"}';
  const padding = targetBytes - prefix.length - 800 - middle.length - suffix.length;
  return `${prefix}${"x".repeat(800)}${middle}${"y".repeat(padding)}${suffix}`;
}

function streamRequest(
  path: string,
  chunks: Uint8Array[],
  options: { contentLength?: number; token?: string | null } = {},
): { request: Request; cancelled: () => boolean; pulled: () => number } {
  let cancelled = false;
  let pulled = 0;
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        pulled += 1;
        controller.enqueue(chunks[index]!);
        index += 1;
      } else {
        controller.close();
      }
    },
    cancel() {
      cancelled = true;
    },
  });
  const headers = authHeaders(options.token);
  if (options.contentLength !== undefined) headers["content-length"] = String(options.contentLength);
  const request = new Request(`${BASE}${path}`, {
    method: "POST",
    headers,
    body: stream,
    duplex: "half",
  } as RequestInit);
  return { request, cancelled: () => cancelled, pulled: () => pulled };
}

function post(path: string, body: unknown, origin?: string, options: PostOptions = {}): Request {
  if (options.request) return options.request;
  const headers = authHeaders(options.token, origin);
  return new Request(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

function options(path: string, origin?: string): Request {
  const headers: Record<string, string> = { "access-control-request-method": "POST" };
  if (origin) headers.origin = origin;
  return new Request(`${BASE}${path}`, { method: "OPTIONS", headers });
}

const ISKRA_KEY = "iskra-test-key";

function iskraEnv(overrides: Partial<Env> = {}): Env {
  return makeEnv({ ISKRAGEN_API_KEY: ISKRA_KEY, ...overrides });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function imageResponse(
  bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  contentType = "image/png",
): Response {
  return new Response(bytes, { headers: { "content-type": contentType } });
}

interface ProviderScript {
  /** Ответ POST /generations. По умолчанию задача сразу SUCCEEDED. */
  create?: Response;
  /** Последовательные ответы GET /generations/:id; исчерпались → PROCESSING. */
  states?: Response[];
  /** Ответ GET /generations/:id/download. */
  download?: Response;
  /** Ответ POST /v1/files/ (загрузка i2i-референса). */
  upload?: Response;
  /**
   * Тело download, которое висит до таймаута. Тест правки ADR-0006: раньше
   * чтение тела не было ограничено, и зависшее скачивание висело вечно.
   */
  hangingDownload?: boolean;
}

/**
 * Мок IskraGen: один `fetch` на четыре ручки. Возвращает мок, чтобы тесты могли
 * проверить тело запроса и заголовки.
 */
function stubProvider(script: ProviderScript = {}) {
  const states = [...(script.states ?? [])];
  const fetchMock = vi.fn(async (input: Request | string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/files/")) {
      return script.upload ?? jsonResponse({ url: "https://files.iskragen.test/in-ref", id: "f-1" }, 201);
    }
    if (url.endsWith("/generations")) {
      return script.create ?? jsonResponse({ id: "gen-1", status: "SUCCEEDED", costRub: 7 }, 202);
    }
    if (url.endsWith("/download?index=0")) {
      if (script.hangingDownload === true) return hangingResponse(init?.signal ?? null);
      return script.download ?? imageResponse();
    }
    if (/\/generations\/[^/]+$/.test(url)) {
      return states.shift() ?? jsonResponse({ id: "gen-1", status: "PROCESSING", costRub: 7 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/**
 * Тело, которое не завершается само, но отменяется по `AbortSignal`, — так
 * ведёт себя настоящий зависший провайдер под отменённым `fetch`. Нужен, чтобы
 * проверить: чтение тела ограничено дедлайном, а не висит вечно.
 */
function hangingResponse(signal: AbortSignal | null): Response {
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      signal?.addEventListener("abort", () => {
        try {
          streamController?.error(new Error("aborted"));
        } catch {
          // поток уже закрыт — отменять больше нечего
        }
      });
    },
    pull() {
      // Байты не отдаём никогда: тело висит до отмены сигналом.
    },
  });
  return new Response(stream, { headers: { "content-type": "image/png" } });
}

/** Окружение с полным успешным прогоном провайдера (POST → SUCCEEDED → download). */
function iskraSuccessEnv(overrides: Partial<Env> = {}): Env {
  stubProvider();
  return iskraEnv(overrides);
}

// ---------------------------------------------------------------------------
// Fake KV для истории генераций
// ---------------------------------------------------------------------------

type FakeKvValue = string | Uint8Array | ArrayBuffer;

interface FakeKvEntry {
  value: FakeKvValue;
  metadata?: Record<string, unknown> | null;
  expirationTtl?: number;
}

function fakeKvBytes(value: FakeKvValue): Uint8Array {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return value;
}

function fakeKvArrayBuffer(value: FakeKvValue): ArrayBuffer {
  const bytes = fakeKvBytes(value);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/**
 * Минимальная KV-реализация: put/getWithMetadata/delete/list с пагинацией.
 * Позволяет проверить запись pending/gen, сортировку истории и деградацию
 * при сбоях (failPut/failRead) без настоящего Cloudflare.
 */
class FakeKV {
  private readonly store = new Map<string, FakeKvEntry>();
  readonly puts: { key: string; metadata?: Record<string, unknown> | null; expirationTtl?: number }[] = [];
  readonly deleted: string[] = [];
  failPut = false;
  failRead = false;
  failDelete = false;
  failList = false;
  pageSize = 1000;

  seed(key: string, value: FakeKvValue, metadata?: Record<string, unknown>): void {
    this.store.set(key, { value, metadata });
  }

  entry(key: string): FakeKvEntry | undefined {
    return this.store.get(key);
  }

  async put(
    key: string,
    value: FakeKvValue,
    options?: { metadata?: Record<string, unknown>; expirationTtl?: number },
  ): Promise<void> {
    if (this.failPut) throw new Error("kv put failed");
    this.store.set(key, {
      value,
      metadata: options?.metadata,
      expirationTtl: options?.expirationTtl,
    });
    this.puts.push({ key, metadata: options?.metadata, expirationTtl: options?.expirationTtl });
  }

  async getWithMetadata(
    key: string,
    options?: string | { type?: string },
  ): Promise<{ value: unknown; metadata: Record<string, unknown> | null; cacheStatus: null }> {
    if (this.failRead) throw new Error("kv read failed");
    const entry = this.store.get(key);
    if (!entry) return { value: null, metadata: null, cacheStatus: null };
    const type = typeof options === "string" ? options : options?.type;
    if (type === "arrayBuffer") {
      return { value: fakeKvArrayBuffer(entry.value), metadata: entry.metadata ?? null, cacheStatus: null };
    }
    const value =
      typeof entry.value === "string" ? entry.value : new TextDecoder().decode(fakeKvBytes(entry.value));
    return { value, metadata: entry.metadata ?? null, cacheStatus: null };
  }

  async delete(key: string): Promise<void> {
    if (this.failDelete) throw new Error("kv delete failed");
    this.store.delete(key);
    this.deleted.push(key);
  }

  async list(options?: { prefix?: string | null; cursor?: string | null }): Promise<{
    list_complete: boolean;
    keys: { name: string; metadata?: Record<string, unknown> | null }[];
    cursor?: string;
    cacheStatus: null;
  }> {
    if (this.failList) throw new Error("kv list failed");
    const prefix = options?.prefix ?? "";
    const names = [...this.store.keys()].filter((name) => name.startsWith(prefix)).sort();
    const start = options?.cursor ? Number(options.cursor) : 0;
    const page = names.slice(start, start + this.pageSize);
    const complete = start + page.length >= names.length;
    return {
      list_complete: complete,
      keys: page.map((name) => ({ name, metadata: this.store.get(name)?.metadata ?? null })),
      ...(complete ? {} : { cursor: String(start + page.length) }),
      cacheStatus: null,
    };
  }
}

function kvEnv(kv: FakeKV, overrides: Partial<Env> = {}): Env {
  return makeEnv({
    ISKRAGEN_API_KEY: ISKRA_KEY,
    GENERATIONS: kv as unknown as KVNamespace,
    ...overrides,
  });
}

function visionResponse(content: string, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function errorBody(response: Response): Promise<{ code: string; message: string }> {
  const body = (await response.json()) as { error: { code: string; message: string } };
  return body.error;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// /health
// ---------------------------------------------------------------------------

describe("GET /health", () => {
  it("сообщает, настроены ли генерация и классификация", async () => {
    const response = await handleRequest(
      get("/health"),
      makeEnv({ ISKRAGEN_API_KEY: "key", OPENCODE_API_KEY: "key" }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, generate: true, classify: true });
  });

  it("без ключей обе возможности выключены", async () => {
    const response = await handleRequest(get("/health"), makeEnv());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, generate: false, classify: false });
  });
});

// ---------------------------------------------------------------------------
// GET /models
// ---------------------------------------------------------------------------

describe("GET /models", () => {
  const CATALOG = {
    total: 2,
    models: [
      { slug: "nano-banana-2-1", mediaType: "IMAGE", sellPriceRub: 3 },
      { slug: "midjourney-text-to-image", mediaType: "IMAGE", sellPriceRub: 25 },
      { slug: "some-video-model", mediaType: "VIDEO", sellPriceRub: 60 },
    ],
  };

  it("отдаёт IMAGE-модели (т2и и i2i) с живыми ценами провайдера", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(CATALOG)));

    const response = await handleRequest(get("/models", ORIGIN, CLIENT_TOKEN), iskraEnv());
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);

    const body = (await response.json()) as {
      models: { slug: string; title: string; priceRub: number }[];
      defaultSlug: string;
      pricesLive: boolean;
    };
    expect(body.pricesLive).toBe(true);
    expect(body.defaultSlug).toBe("gpt-image-2-text-to-image");
    expect(body.models).toHaveLength(15);
    expect(body.models.find((m) => m.slug === "nano-banana-2-1")?.priceRub).toBe(3);
    expect(body.models.find((m) => m.slug === "gpt-image-2-image-to-image")).toBeDefined();
    expect(body.models.find((m) => m.slug === "flux-2-pro-image-to-image")).toBeDefined();
    expect(body.models.find((m) => m.slug === "midjourney-text-to-image")?.priceRub).toBe(25);
    expect(body.models.some((m) => m.slug === "some-video-model")).toBe(false);
  });

  it("без клиентского токена → 401", async () => {
    const response = await handleRequest(get("/models"), iskraEnv());
    expect(response.status).toBe(401);
    expect((await errorBody(response)).code).toBe("unauthorized");
  });

  it("недоступный каталог не ломает выбор: остаются цены из models.ts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("catalog down");
      }),
    );

    const response = await handleRequest(get("/models", undefined, CLIENT_TOKEN), iskraEnv());
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      models: { slug: string; priceRub: number }[];
      pricesLive: boolean;
    };
    expect(body.pricesLive).toBe(false);
    expect(body.models.find((m) => m.slug === "nano-banana-2-1")?.priceRub).toBe(4);
    expect(body.models.find((m) => m.slug === "midjourney-text-to-image")?.priceRub).toBe(20);
  });

  it("POST /models → 405 и Allow: GET", async () => {
    const response = await handleRequest(post("/models", {}), iskraEnv());
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
  });
});

// ---------------------------------------------------------------------------
// CORS и preflight
// ---------------------------------------------------------------------------

describe("CORS", () => {
  it("preflight OPTIONS отвечает 204 и разрешает настроенный источник", async () => {
    const response = await handleRequest(options("/generate", ORIGIN), makeEnv());
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
    expect(response.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("content-type");
    expect(response.headers.get("access-control-allow-headers")?.toLowerCase()).toContain(CLIENT_TOKEN_HEADER);
    expect(response.headers.get("vary")).toBe("Origin");
  });

  it("preflight не разрешает источник вне списка", async () => {
    const response = await handleRequest(options("/generate", "https://evil.example"), makeEnv());
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("vary")).toBe("Origin");
  });

  it("уважает var ALLOWED_ORIGINS", async () => {
    const response = await handleRequest(options("/classify", "https://custom.example"), makeEnv({ ALLOWED_ORIGINS: "https://custom.example" }));
    expect(response.headers.get("access-control-allow-origin")).toBe("https://custom.example");
  });

  it("проставляет CORS в обычном ответе", async () => {
    const response = await handleRequest(get("/health", OTHER_ORIGIN), iskraEnv());
    expect(response.headers.get("access-control-allow-origin")).toBe(OTHER_ORIGIN);
  });

  it("не проставляет CORS чужому источнику", async () => {
    const response = await handleRequest(get("/health", "https://evil.example"), iskraEnv());
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("разрешает превью-поддомен Pages (одна метка)", async () => {
    const response = await handleRequest(options("/generate", "https://abc123.tidy-clone.pages.dev"), makeEnv());
    expect(response.headers.get("access-control-allow-origin")).toBe("https://abc123.tidy-clone.pages.dev");
  });

  it("не разрешает вложенные и похожие домены", async () => {
    for (const origin of [
      "https://a.b.tidy-clone.pages.dev",
      "https://evil-tidy-clone.pages.dev",
      "https://tidy-clone.pages.dev.evil.example",
      "http://abc123.tidy-clone.pages.dev",
    ]) {
      const response = await handleRequest(options("/generate", origin), makeEnv());
      expect(response.headers.get("access-control-allow-origin"), origin).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Клиентский токен
// ---------------------------------------------------------------------------

describe("клиентский токен", () => {
  it("без секрета CLIENT_TOKEN защищённые маршруты → 503 not_configured", async () => {
    const env = makeEnv({ CLIENT_TOKEN: undefined });
    const generate = await handleRequest(post("/generate", { prompt: "hoodie" }), env);
    expect(generate.status).toBe(503);
    expect((await errorBody(generate)).code).toBe("not_configured");

    const classify = await handleRequest(
      post("/classify", { imageBase64: "AAAA", mimeType: "image/jpeg" }),
      env,
    );
    expect(classify.status).toBe(503);
  });

  it("без заголовка x-tidy-client → 401 unauthorized", async () => {
    const generate = await handleRequest(post("/generate", { prompt: "hoodie" }, undefined, { token: null }), iskraEnv());
    expect(generate.status).toBe(401);
    expect((await errorBody(generate)).code).toBe("unauthorized");

    const classify = await handleRequest(
      post("/classify", { imageBase64: "AAAA", mimeType: "image/jpeg" }, undefined, { token: null }),
      makeEnv({ OPENCODE_API_KEY: "key" }),
    );
    expect(classify.status).toBe(401);
  });

  it("неверный токен → 401 unauthorized", async () => {
    const response = await handleRequest(
      post("/generate", { prompt: "hoodie" }, undefined, { token: "wrong-token" }),
      iskraEnv(),
    );
    expect(response.status).toBe(401);
    expect((await errorBody(response)).code).toBe("unauthorized");
  });

  it("верный токен пропускает запрос", async () => {
    const response = await handleRequest(
      post("/generate", { prompt: "hoodie" }),
      iskraSuccessEnv(),
    );
    expect(response.status).toBe(202);
    expect(response.headers.get("content-type")).toMatch(/application\/json/);
    expect(await response.json()).toMatchObject({ taskId: "gen-1" });
  });
});

// ---------------------------------------------------------------------------
// Ограничение тела на потоке
// ---------------------------------------------------------------------------

describe("ограничение тела на потоке", () => {
  // Лимит тела теперь 12 МБ (D13: тело несёт входную картинку в base64),
  // поэтому границу прощупываем на десятом мегабайте.
  const LIMIT = MAX_GENERATE_BODY_BYTES;

  it("тело ровно на границе проходит", async () => {
    const body = generateBody(LIMIT);
    expect(new TextEncoder().encode(body).length).toBe(LIMIT);
    const request = new Request(`${BASE}/generate`, { method: "POST", headers: authHeaders(undefined), body });
    const response = await handleRequest(request, iskraSuccessEnv());
    expect(response.status).toBe(202);
  });

  it("Content-Length больше лимита → 413 без чтения тела", async () => {
    const { request, pulled } = streamRequest("/generate", [], { contentLength: LIMIT + 1 });
    const response = await handleRequest(request, iskraEnv());
    expect(response.status).toBe(413);
    expect((await errorBody(response)).code).toBe("payload_too_large");
    // Тело не вычитано ни на один чанк.
    expect(pulled()).toBe(0);
  });

  it("chunked без Content-Length: тело больше лимита → 413 и поток обрывается", async () => {
    const { request, cancelled, pulled } = streamRequest("/generate", [
      new Uint8Array(LIMIT + 1),
      new Uint8Array(LIMIT),
      new Uint8Array(LIMIT),
      new Uint8Array(LIMIT),
      new Uint8Array(LIMIT),
    ]);
    const response = await handleRequest(request, iskraEnv());
    expect(response.status).toBe(413);
    expect((await errorBody(response)).code).toBe("payload_too_large");
    expect(cancelled()).toBe(true);
    // Всё тело не вычитано: чтение прекращено на первом же превышении.
    expect(pulled()).toBeLessThan(5);
  });

  it("chunked ровно на границе проходит", async () => {
    const body = new TextEncoder().encode(generateBody(LIMIT));
    const { request } = streamRequest("/generate", [body.subarray(0, 8000), body.subarray(8000)]);
    const response = await handleRequest(request, iskraSuccessEnv());
    expect(response.status).toBe(202);
  });
});

// ---------------------------------------------------------------------------
// Методы и маршруты
// ---------------------------------------------------------------------------

describe("методы и маршруты", () => {
  it("GET /generate → 405 и Allow: POST", async () => {
    const response = await handleRequest(get("/generate"), iskraEnv());
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect((await errorBody(response)).code).toBe("method_not_allowed");
  });

  it("POST /generate/gen-1 → 405 и Allow: GET", async () => {
    const response = await handleRequest(post("/generate/gen-1", {}), iskraEnv());
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
  });

  it("POST /health → 405 и Allow: GET", async () => {
    const response = await handleRequest(post("/health", {}), iskraEnv());
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
  });

  it("неизвестный маршрут → 404", async () => {
    const response = await handleRequest(get("/nope"), makeEnv());
    expect(response.status).toBe(404);
    expect((await errorBody(response)).code).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// POST /generate — валидация
// ---------------------------------------------------------------------------

describe("POST /generate: валидация", () => {
  it("без prompt → 400", async () => {
    const response = await handleRequest(post("/generate", {}), iskraEnv());
    expect(response.status).toBe(400);
    expect((await errorBody(response)).code).toBe("invalid_input");
  });

  it("пустой prompt → 400", async () => {
    const response = await handleRequest(post("/generate", { prompt: "   " }), iskraEnv());
    expect(response.status).toBe(400);
  });

  it("prompt из 801 символа → 400", async () => {
    const response = await handleRequest(post("/generate", { prompt: "x".repeat(801) }), iskraEnv());
    expect(response.status).toBe(400);
  });

  it("prompt ровно из 800 символов принимается", async () => {
    const response = await handleRequest(
      post("/generate", { prompt: "x".repeat(800) }),
      iskraSuccessEnv(),
    );
    expect(response.status).toBe(202);
  });

  it("нечисловой width → 400, а не 500", async () => {
    const response = await handleRequest(post("/generate", { prompt: "hoodie", width: "big" }), iskraEnv());
    expect(response.status).toBe(400);
  });

  it("width вне диапазона → 400", async () => {
    const response = await handleRequest(post("/generate", { prompt: "hoodie", width: 64 }), iskraEnv());
    expect(response.status).toBe(400);
  });

  it("битый JSON → 400", async () => {
    const request = new Request(`${BASE}/generate`, { method: "POST", headers: authHeaders(undefined), body: "{not json" });
    const response = await handleRequest(request, iskraEnv());
    expect(response.status).toBe(400);
    expect((await errorBody(response)).code).toBe("invalid_input");
  });

  it("промпт длиннее 800 символов → 400 invalid_input", async () => {
    const response = await handleRequest(post("/generate", { prompt: "x".repeat(801) }), iskraEnv());
    expect(response.status).toBe(400);
    expect((await errorBody(response)).code).toBe("invalid_input");
  });

  it("тело больше 12 МБ даже с легальным промптом → 413", async () => {
    const response = await handleRequest(
      post("/generate", { prompt: "hoodie", padding: "y".repeat(MAX_GENERATE_BODY_BYTES) }),
      iskraEnv(),
    );
    expect(response.status).toBe(413);
    expect((await errorBody(response)).code).toBe("payload_too_large");
  });

  it("на границе i2i-лимита входная картинка проходит (маленький референс)", async () => {
    stubProvider();
    const response = await handleRequest(
      post("/generate", { prompt: "hoodie", imageBase64: "AAAA", mimeType: "image/jpeg" }),
      iskraEnv(),
    );
    expect(response.status).toBe(202);
  });
});

// ---------------------------------------------------------------------------
// Ограничение частоты
// ---------------------------------------------------------------------------

describe("ограничение частоты", () => {
  it("отказ лимитера → 429 rate_limited", async () => {
    const limiter = { limit: vi.fn(async () => ({ success: false })) };
    const response = await handleRequest(
      post("/generate", { prompt: "hoodie" }),
      iskraEnv({ GENERATE_RATE_LIMITER: limiter }),
    );
    expect(response.status).toBe(429);
    expect((await errorBody(response)).code).toBe("rate_limited");
  });

  it("успешный лимит пропускает запрос, ключ — хэш IP, а не IP", async () => {
    stubProvider();
    const limiter = { limit: vi.fn(async (_options: { key: string }) => ({ success: true })) };
    const response = await handleRequest(
      post("/generate", { prompt: "hoodie" }),
      iskraEnv({ GENERATE_RATE_LIMITER: limiter }),
    );
    expect(response.status).toBe(202);
    expect(limiter.limit).toHaveBeenCalledTimes(1);
    const key = (limiter.limit.mock.calls[0]![0] as { key: string }).key;
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("генерация и классификация используют разные лимитеры", async () => {
    const generateLimiter = { limit: vi.fn(async () => ({ success: false })) };
    const classifyLimiter = { limit: vi.fn(async () => ({ success: true })) };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => visionResponse(JSON.stringify({ category: "Обувь", subcategory: "кроссовки", confidence: 0.9 }))),
    );
    const env = makeEnv({
      ISKRAGEN_API_KEY: ISKRA_KEY,
      OPENCODE_API_KEY: "key",
      GENERATE_RATE_LIMITER: generateLimiter,
      CLASSIFY_RATE_LIMITER: classifyLimiter,
    });

    const generateResponse = await handleRequest(post("/generate", { prompt: "hoodie" }), env);
    expect(generateResponse.status).toBe(429);
    expect(generateLimiter.limit).toHaveBeenCalled();

    const classifyResponse = await handleRequest(
      post("/classify", { imageBase64: "AAAA", mimeType: "image/jpeg" }),
      env,
    );
    expect(classifyResponse.status).toBe(200);
    expect(classifyLimiter.limit).toHaveBeenCalled();
  });

  it("сбой лимитера не роняет сервис (fail-open)", async () => {
    stubProvider();
    const limiter = {
      limit: vi.fn(async () => {
        throw new Error("limiter down");
      }),
    };
    const response = await handleRequest(
      post("/generate", { prompt: "hoodie" }),
      iskraEnv({ GENERATE_RATE_LIMITER: limiter }),
    );
    expect(response.status).toBe(202);
  });

  it("без binding лимитера запрос проходит (локальный запуск)", async () => {
    stubProvider();
    const response = await handleRequest(post("/generate", { prompt: "hoodie" }), iskraEnv());
    expect(response.status).toBe(202);
  });

  it("статус генерации использует свой лимитер (60/мин)", async () => {
    stubProvider();
    const limiter = { limit: vi.fn(async () => ({ success: false })) };
    const response = await handleRequest(
      get("/generate/gen-1", ORIGIN, CLIENT_TOKEN),
      iskraEnv({ GENERATION_STATUS_RATE_LIMITER: limiter }),
    );
    expect(response.status).toBe(429);
    expect((await errorBody(response)).code).toBe("rate_limited");
    expect(limiter.limit).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// POST /generate — модель
// ---------------------------------------------------------------------------

describe("POST /generate: асинхронный запуск (ADR-0006)", () => {
  it("ставит задачу и отвечает 202 с taskId, картинку не ждёт", async () => {
    const fetchMock = stubProvider({
      create: jsonResponse({ id: "gen-42", status: "PENDING", costRub: 5 }, 202),
    });

    const response = await handleRequest(
      post("/generate", { prompt: "hoodie", width: DEFAULT_FRAME_SIZE, height: DEFAULT_FRAME_SIZE }, ORIGIN),
      iskraEnv(),
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      taskId: "gen-42",
      status: "PENDING",
      costRub: 5,
      model: "gpt-image-2-text-to-image",
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(response.headers.get("x-tidy-model")).toBe("gpt-image-2-text-to-image");
    expect(response.headers.get("x-tidy-cost-rub")).toBe("5");

    // только create: воркер не опрашивает статус и не качает файл сам
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [createUrl, createInit] = fetchMock.mock.calls[0]!;
    expect(String(createUrl)).toBe("https://api.iskragen.ru/v1/generations");
    const headers = (createInit?.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${ISKRA_KEY}`);
    expect(headers["Idempotency-Key"]).toBeUndefined();
    const sent = JSON.parse(String(createInit?.body)) as Record<string, unknown>;
    expect(sent).toEqual({
      modelSlug: "gpt-image-2-text-to-image",
      prompt: "hoodie",
      params: { aspect_ratio: "1:1", resolution: "1K", background: "transparent" },
    });
    expect(sent).not.toHaveProperty("width");
    expect(sent).not.toHaveProperty("height");
  });

  it("пробрасывает Idempotency-Key провайдеру", async () => {
    const fetchMock = stubProvider();
    const response = await handleRequest(
      post("/generate", { prompt: "hoodie", idempotencyKey: "item-1:nano-banana-2-1" }),
      iskraEnv(),
    );
    expect(response.status).toBe(202);
    const headers = (fetchMock.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe("item-1:nano-banana-2-1");
  });

  it("недопустимый idempotencyKey → 400 до обращения к провайдеру", async () => {
    for (const bad of ["x".repeat(65), "с пробелом", "ключ/с-разделителем"]) {
      const fetchMock = stubProvider();
      const response = await handleRequest(
        post("/generate", { prompt: "hoodie", idempotencyKey: bad }),
        iskraEnv(),
      );
      expect(response.status).toBe(400);
      expect((await errorBody(response)).code).toBe("invalid_input");
      expect(fetchMock).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    }
  });

  it("пустой idempotencyKey не уходит провайдеру", async () => {
    const fetchMock = stubProvider();
    const response = await handleRequest(
      post("/generate", { prompt: "hoodie", idempotencyKey: "   " }),
      iskraEnv(),
    );
    expect(response.status).toBe(202);
    const headers = (fetchMock.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBeUndefined();
  });

  it("без ключа → 503 not_configured", async () => {
    const response = await handleRequest(post("/generate", { prompt: "hoodie" }), makeEnv());
    expect(response.status).toBe(503);
    expect((await errorBody(response)).code).toBe("not_configured");
  });

  it("402 провайдера → 402 billing", async () => {
    stubProvider({ create: jsonResponse({ error: { code: "INSUFFICIENT_BALANCE" } }, 402) });
    const response = await handleRequest(post("/generate", { prompt: "hoodie" }), iskraEnv());
    expect(response.status).toBe(402);
    expect((await errorBody(response)).code).toBe("billing");
  });

  it("401 провайдера → 503 not_configured без утечки ключа", async () => {
    stubProvider({ create: jsonResponse({ error: { code: "AUTHENTICATION_ERROR" } }, 401) });
    const response = await handleRequest(post("/generate", { prompt: "hoodie" }), iskraEnv());
    expect(response.status).toBe(503);

    const body = await response.json();
    expect((body as { error: { code: string } }).error.code).toBe("not_configured");
    expect(JSON.stringify(body)).not.toContain(ISKRA_KEY);
  });

  it("429 провайдера → 429 rate_limited", async () => {
    stubProvider({ create: jsonResponse({ error: { code: "RATE_LIMIT_ERROR" } }, 429) });
    const response = await handleRequest(post("/generate", { prompt: "hoodie" }), iskraEnv());
    expect(response.status).toBe(429);
    expect((await errorBody(response)).code).toBe("rate_limited");
  });

  it("5xx провайдера → 502 model_error", async () => {
    stubProvider({ create: jsonResponse({ error: { code: "API_ERROR" } }, 502) });
    const response = await handleRequest(post("/generate", { prompt: "hoodie" }), iskraEnv());
    expect(response.status).toBe(502);
    expect((await errorBody(response)).code).toBe("model_error");
  });

  it("сетевой сбой провайдера → 502 без утечки деталей", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNRESET secret-internal");
      }),
    );
    const response = await handleRequest(post("/generate", { prompt: "hoodie" }), iskraEnv());
    expect(response.status).toBe(502);

    const body = await response.json();
    expect((body as { error: { code: string } }).error.code).toBe("model_error");
    expect(JSON.stringify(body)).not.toContain("secret-internal");
  });

  it("ответ без id задачи → 502", async () => {
    stubProvider({ create: jsonResponse({ status: "PENDING" }, 202) });
    const response = await handleRequest(post("/generate", { prompt: "hoodie" }), iskraEnv());
    expect(response.status).toBe(502);
    expect((await errorBody(response)).code).toBe("model_error");
  });
});

// ---------------------------------------------------------------------------
// GET /generate/{taskId} — статус
// ---------------------------------------------------------------------------

describe("GET /generate/{taskId}: статус", () => {
  it("возвращает статус и стоимость с CORS", async () => {
    const fetchMock = stubProvider({
      states: [jsonResponse({ id: "gen-42", status: "SUCCEEDED", costRub: 5 })],
    });
    const response = await handleRequest(get("/generate/gen-42", ORIGIN, CLIENT_TOKEN), iskraEnv());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ taskId: "gen-42", status: "SUCCEEDED", costRub: 5 });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-tidy-cost-rub")).toBe("5");
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://api.iskragen.ru/v1/generations/gen-42",
    );
    expect((fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>).authorization).toBe(
      `Bearer ${ISKRA_KEY}`,
    );
  });

  it("задача ещё идёт → статус провайдера как есть", async () => {
    stubProvider({ states: [jsonResponse({ id: "gen-1", status: "PROCESSING" })] });
    const response = await handleRequest(get("/generate/gen-1", ORIGIN, CLIENT_TOKEN), iskraEnv());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "PROCESSING" });
  });

  it("FAILED — не ошибка транспорта: статус отдаётся клиенту", async () => {
    stubProvider({
      states: [jsonResponse({ id: "gen-1", status: "FAILED", errorCode: "PROVIDER_ERROR" })],
    });
    const response = await handleRequest(get("/generate/gen-1", ORIGIN, CLIENT_TOKEN), iskraEnv());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "FAILED" });
  });

  it("задача не найдена у провайдера → 404 not_found", async () => {
    stubProvider({ states: [jsonResponse({ error: { code: "NOT_FOUND" } }, 404)] });
    const response = await handleRequest(get("/generate/gen-1", ORIGIN, CLIENT_TOKEN), iskraEnv());
    expect(response.status).toBe(404);
    expect((await errorBody(response)).code).toBe("not_found");
  });

  it("5xx провайдера → 502 model_error", async () => {
    stubProvider({ states: [jsonResponse({ error: { code: "API_ERROR" } }, 500)] });
    const response = await handleRequest(get("/generate/gen-1", ORIGIN, CLIENT_TOKEN), iskraEnv());
    expect(response.status).toBe(502);
    expect((await errorBody(response)).code).toBe("model_error");
  });

  it("без ключа ISKRAGEN_API_KEY → 503 not_configured", async () => {
    const response = await handleRequest(get("/generate/gen-1", ORIGIN, CLIENT_TOKEN), makeEnv());
    expect(response.status).toBe(503);
    expect((await errorBody(response)).code).toBe("not_configured");
  });

  it("без клиентского токена → 401", async () => {
    const response = await handleRequest(get("/generate/gen-1", ORIGIN), iskraEnv());
    expect(response.status).toBe(401);
    expect((await errorBody(response)).code).toBe("unauthorized");
  });

  it("недопустимый taskId → 400 без обращения к провайдеру", async () => {
    const fetchMock = stubProvider();
    const response = await handleRequest(
      get("/generate/bad id!", ORIGIN, CLIENT_TOKEN),
      iskraEnv(),
    );
    expect(response.status).toBe(400);
    expect((await errorBody(response)).code).toBe("invalid_input");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET /generate/{taskId}/image — скачивание результата
// ---------------------------------------------------------------------------

describe("GET /generate/{taskId}/image", () => {
  const BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x10]);

  function succeededStatus(): Response {
    return jsonResponse({ id: "gen-42", status: "SUCCEEDED", costRub: 5 });
  }

  it("скачивает файл отдельным запросом после статуса", async () => {
    const fetchMock = stubProvider({
      states: [succeededStatus()],
      download: imageResponse(BYTES, "image/jpeg"),
    });
    const response = await handleRequest(
      get("/generate/gen-42/image", ORIGIN, CLIENT_TOKEN),
      iskraEnv(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-tidy-cost-rub")).toBe("5");
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);

    // первый запрос — статус, второй — скачивание
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://api.iskragen.ru/v1/generations/gen-42",
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      "https://api.iskragen.ru/v1/generations/gen-42/download?index=0",
    );
    expect((fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>).authorization).toBe(
      `Bearer ${ISKRA_KEY}`,
    );
  });

  it("задача ещё идёт → 409 not_ready", async () => {
    stubProvider({ states: [jsonResponse({ id: "gen-42", status: "PROCESSING" })] });
    const response = await handleRequest(
      get("/generate/gen-42/image", ORIGIN, CLIENT_TOKEN),
      iskraEnv(),
    );
    expect(response.status).toBe(409);
    expect((await errorBody(response)).code).toBe("not_ready");
  });

  it("задача провалилась → 409 not_ready с пояснением", async () => {
    stubProvider({
      states: [jsonResponse({ id: "gen-42", status: "FAILED", errorCode: "PROVIDER_ERROR" })],
    });
    const response = await handleRequest(
      get("/generate/gen-42/image", ORIGIN, CLIENT_TOKEN),
      iskraEnv(),
    );
    expect(response.status).toBe(409);
    const body = await errorBody(response);
    expect(body.code).toBe("not_ready");
    expect(body.message).toContain("не удалась");
  });

  it("задача не найдена → 404 not_found", async () => {
    stubProvider({ states: [jsonResponse({ error: { code: "NOT_FOUND" } }, 404)] });
    const response = await handleRequest(
      get("/generate/gen-42/image", ORIGIN, CLIENT_TOKEN),
      iskraEnv(),
    );
    expect(response.status).toBe(404);
    expect((await errorBody(response)).code).toBe("not_found");
  });

  it("не-картинка вместо файла → 502", async () => {
    stubProvider({
      states: [succeededStatus()],
      download: new Response("not an image", { headers: { "content-type": "text/plain" } }),
    });
    const response = await handleRequest(
      get("/generate/gen-42/image", ORIGIN, CLIENT_TOKEN),
      iskraEnv(),
    );
    expect(response.status).toBe(502);
    expect((await errorBody(response)).code).toBe("model_error");
  });

  it("пустой файл → 502", async () => {
    stubProvider({
      states: [succeededStatus()],
      download: imageResponse(new Uint8Array(0), "image/png"),
    });
    const response = await handleRequest(
      get("/generate/gen-42/image", ORIGIN, CLIENT_TOKEN),
      iskraEnv(),
    );
    expect(response.status).toBe(502);
  });

  it("зависшее чтение тела обрывается по таймауту → 504, а не висит вечно", async () => {
    stubProvider({ states: [succeededStatus()], hangingDownload: true });
    vi.useFakeTimers();
    try {
      const pending = handleRequest(
        get("/generate/gen-42/image", ORIGIN, CLIENT_TOKEN),
        iskraEnv(),
      );
      await vi.advanceTimersByTimeAsync(IMAGE_DOWNLOAD_TIMEOUT_MS + 100);
      const response = await pending;
      expect(response.status).toBe(504);
      expect((await errorBody(response)).code).toBe("model_timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("лимит скачивания: отказ своего лимитера → 429", async () => {
    stubProvider();
    const limiter = { limit: vi.fn(async () => ({ success: false })) };
    const response = await handleRequest(
      get("/generate/gen-42/image", ORIGIN, CLIENT_TOKEN),
      iskraEnv({ GENERATION_IMAGE_RATE_LIMITER: limiter }),
    );
    expect(response.status).toBe(429);
    expect((await errorBody(response)).code).toBe("rate_limited");
    expect(limiter.limit).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// POST /generate — выбор модели
// ---------------------------------------------------------------------------

describe("POST /generate: выбор модели", () => {
  function sentBody(fetchMock: ReturnType<typeof stubProvider>): Record<string, unknown> {
    return JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
  }

  it("передаёт выбранную модель и её параметры кадра", async () => {
    const fetchMock = stubProvider();
    const response = await handleRequest(
      post("/generate", {
        prompt: "hoodie",
        model: "grok-imagine-image-2-0-text-to-image",
      }),
      iskraEnv(),
    );
    expect(response.status).toBe(202);
    expect(sentBody(fetchMock)).toEqual({
      modelSlug: "grok-imagine-image-2-0-text-to-image",
      prompt: "hoodie",
      params: { aspect_ratio: "1:1" },
    });
    expect(response.headers.get("x-tidy-model")).toBe("grok-imagine-image-2-0-text-to-image");
    expect(response.headers.get("x-tidy-cost-rub")).toBe("7");
  });

  it("Qwen получает image_size, а не aspect_ratio", async () => {
    const fetchMock = stubProvider();
    const response = await handleRequest(
      post("/generate", { prompt: "hoodie", model: "qwen3-text-to-image" }),
      iskraEnv(),
    );
    expect(response.status).toBe(202);
    expect(sentBody(fetchMock)).toMatchObject({
      modelSlug: "qwen3-text-to-image",
      params: { image_size: "1:1", resolution: "1K" },
    });
  });

  it("неизвестная модель → 400 без обращения к провайдеру", async () => {
    const fetchMock = stubProvider();
    const response = await handleRequest(
      post("/generate", { prompt: "hoodie", model: "expensive-unknown-model" }),
      iskraEnv(),
    );
    expect(response.status).toBe(400);
    expect((await errorBody(response)).code).toBe("invalid_input");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("пустая модель → 400", async () => {
    const response = await handleRequest(
      post("/generate", { prompt: "hoodie", model: "  " }),
      iskraEnv(),
    );
    expect(response.status).toBe(400);
  });

  it("без model работает модель из конфигурации", async () => {
    const fetchMock = stubProvider();
    const response = await handleRequest(post("/generate", { prompt: "hoodie" }), iskraEnv());
    expect(response.status).toBe(202);
    expect(sentBody(fetchMock)).toMatchObject({ modelSlug: "gpt-image-2-text-to-image" });
  });
});

// ---------------------------------------------------------------------------
// POST /generate — входное изображение (i2i, D13)
// ---------------------------------------------------------------------------

describe("POST /generate: входное изображение", () => {
  function sentBody(fetchMock: ReturnType<typeof stubProvider>): Record<string, unknown> {
    return JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
  }

  const OVER_LIMIT_BASE64 = "A".repeat(Math.ceil((MAX_GENERATE_INPUT_BYTES + 1) / 3) * 4);

  it("upload идёт первым, затем create с референсом под ключом модели", async () => {
    const fetchMock = stubProvider();
    const response = await handleRequest(
      post("/generate", { prompt: "hoodie", imageBase64: "AAAA", mimeType: "image/jpeg" }),
      iskraEnv(),
    );
    expect(response.status).toBe(202);

    const [uploadUrl, uploadInit] = fetchMock.mock.calls[0]!;
    expect(String(uploadUrl)).toBe("https://api.iskragen.ru/v1/files/");
    expect((uploadInit?.headers as Record<string, string>).authorization).toBe(`Bearer ${ISKRA_KEY}`);
    expect(new Headers(uploadInit?.headers).has("content-type")).toBe(false);
    const file = (uploadInit?.body as FormData).get("file") as File;
    expect(file.name).toBe("reference.jpg");
    expect(file.type).toBe("image/jpeg");

    expect(sentBody(fetchMock)).toEqual({
      // Конфигурация указывает на gpt-image-2-text-to-image — она не берёт
      // референс, поэтому воркер подставил дефолтную i2i-модель.
      modelSlug: "gpt-image-2-image-to-image",
      prompt: "hoodie",
      params: {
        aspect_ratio: "1:1",
        resolution: "1K",
        background: "transparent",
        input_urls: ["https://files.iskragen.test/in-ref"],
      },
    });
    expect(response.headers.get("x-tidy-model")).toBe("gpt-image-2-image-to-image");
  });

  it("явно выбранная i2i-модель получает свой ключ референса", async () => {
    const fetchMock = stubProvider();
    const response = await handleRequest(
      post("/generate", {
        prompt: "hoodie",
        imageBase64: "AAAA",
        mimeType: "image/jpeg",
        model: "gpt-image-2-image-to-image",
      }),
      iskraEnv(),
    );
    expect(response.status).toBe(202);
    const create = fetchMock.mock.calls[1]!;
    expect(String(create[0])).toBe("https://api.iskragen.ru/v1/generations");
    expect(JSON.parse(String(create[1]?.body))).toMatchObject({
      modelSlug: "gpt-image-2-image-to-image",
      params: {
        aspect_ratio: "1:1",
        resolution: "1K",
        background: "transparent",
        input_urls: ["https://files.iskragen.test/in-ref"],
      },
    });
  });

  it("модели без нативной прозрачности не получают background", async () => {
    const fetchMock = stubProvider();
    const response = await handleRequest(
      post("/generate", {
        prompt: "hoodie",
        imageBase64: "AAAA",
        mimeType: "image/jpeg",
        model: "nano-banana-2-1",
      }),
      iskraEnv(),
    );
    expect(response.status).toBe(202);
    const body = sentBody(fetchMock);
    expect(body).toMatchObject({ modelSlug: "nano-banana-2-1" });
    expect((body.params as Record<string, unknown>).background).toBeUndefined();
  });

  it("т2и-модель без нативной прозрачности не получает background", async () => {
    const fetchMock = stubProvider();
    const response = await handleRequest(
      post("/generate", { prompt: "hoodie", model: "qwen3-text-to-image" }),
      iskraEnv(),
    );
    expect(response.status).toBe(202);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ modelSlug: "qwen3-text-to-image" });
    expect((body.params as Record<string, unknown>).background).toBeUndefined();
  });

  it("сохранённый т2и-выбор с картинкой заменяется и об этом пишется в лог", async () => {
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const fetchMock = stubProvider();
      await handleRequest(
        post("/generate", {
          prompt: "hoodie",
          imageBase64: "AAAA",
          mimeType: "image/jpeg",
          model: "gpt-image-2-text-to-image",
        }),
        iskraEnv(),
      );
      expect(sentBody(fetchMock).modelSlug).toBe("gpt-image-2-image-to-image");
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("не принимает референс"));
    } finally {
      logSpy.mockRestore();
    }
  });

  it("imageBase64 без mimeType → 400", async () => {
    const response = await handleRequest(
      post("/generate", { prompt: "hoodie", imageBase64: "AAAA" }),
      iskraEnv(),
    );
    expect(response.status).toBe(400);
    expect((await errorBody(response)).code).toBe("invalid_input");
  });

  it("HEIC не принимается провайдером → 400", async () => {
    const response = await handleRequest(
      post("/generate", { prompt: "hoodie", imageBase64: "AAAA", mimeType: "image/heic" }),
      iskraEnv(),
    );
    expect(response.status).toBe(400);
  });

  it("битый base64 → 400 до обращения к провайдеру", async () => {
    const fetchMock = stubProvider();
    const response = await handleRequest(
      post("/generate", { prompt: "hoodie", imageBase64: "!!!", mimeType: "image/jpeg" }),
      iskraEnv(),
    );
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("референс больше 8 МБ → 400", async () => {
    const response = await handleRequest(
      post("/generate", { prompt: "hoodie", imageBase64: OVER_LIMIT_BASE64, mimeType: "image/jpeg" }),
      iskraEnv(),
    );
    expect(response.status).toBe(400);
  });

  it("провайдер не вернул url файла → 502 model_error", async () => {
    stubProvider({ upload: jsonResponse({ contentType: "image/jpeg" }, 201) });
    const response = await handleRequest(
      post("/generate", { prompt: "hoodie", imageBase64: "AAAA", mimeType: "image/jpeg" }),
      iskraEnv(),
    );
    expect(response.status).toBe(502);
    expect((await errorBody(response)).code).toBe("model_error");
  });

  it("сбой загрузки референса → 502 model_error", async () => {
    stubProvider({ upload: jsonResponse({ error: { code: "API_ERROR" } }, 500) });
    const response = await handleRequest(
      post("/generate", { prompt: "hoodie", imageBase64: "AAAA", mimeType: "image/jpeg" }),
      iskraEnv(),
    );
    expect(response.status).toBe(502);
    expect((await errorBody(response)).code).toBe("model_error");
  });

  it("генерация не начинается, если загрузка референса не удалась", async () => {
    const fetchMock = stubProvider({ upload: new Response("no space", { status: 500 }) });
    await handleRequest(
      post("/generate", { prompt: "hoodie", imageBase64: "AAAA", mimeType: "image/jpeg" }),
      iskraEnv(),
    );
    const generationCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("/generations"),
    );
    expect(generationCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// POST /classify — валидация и конфигурация
// ---------------------------------------------------------------------------

describe("POST /classify: валидация", () => {
  it("без ключа OPENCODE_API_KEY → 503 not_configured", async () => {
    const response = await handleRequest(
      post("/classify", { imageBase64: "AAAA", mimeType: "image/jpeg" }),
      makeEnv(),
    );
    expect(response.status).toBe(503);
    expect((await errorBody(response)).code).toBe("not_configured");
  });

  it("пустой imageBase64 → 400", async () => {
    const response = await handleRequest(
      post("/classify", { imageBase64: "", mimeType: "image/jpeg" }),
      makeEnv({ OPENCODE_API_KEY: "key" }),
    );
    expect(response.status).toBe(400);
  });

  it("недопустимый mimeType → 400", async () => {
    const response = await handleRequest(
      post("/classify", { imageBase64: "AAAA", mimeType: "application/pdf" }),
      makeEnv({ OPENCODE_API_KEY: "key" }),
    );
    expect(response.status).toBe(400);
  });

  it("некорректный base64 → 400", async () => {
    const response = await handleRequest(
      post("/classify", { imageBase64: "not-base64!!!", mimeType: "image/jpeg" }),
      makeEnv({ OPENCODE_API_KEY: "key" }),
    );
    expect(response.status).toBe(400);
  });

  it("тело больше 4 МБ → 413", async () => {
    const response = await handleRequest(
      post("/classify", { imageBase64: "A".repeat(4 * 1024 * 1024 + 8), mimeType: "image/jpeg" }),
      makeEnv({ OPENCODE_API_KEY: "key" }),
    );
    expect(response.status).toBe(413);
    expect((await errorBody(response)).code).toBe("payload_too_large");
  });
});

// ---------------------------------------------------------------------------
// POST /classify — вызов vision-модели
// ---------------------------------------------------------------------------

describe("POST /classify: vision-модель", () => {
  it("возвращает категорию строго из таксономии и ходит на opencode-go", async () => {
    const fetchMock = vi.fn(
      async (_input: Request | string | URL, _init?: RequestInit) =>
        visionResponse(JSON.stringify({ category: "Обувь", subcategory: "Кроссовки", confidence: 0.92 })),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleRequest(
      post("/classify", { imageBase64: "AAAA", mimeType: "image/jpeg" }, ORIGIN),
      makeEnv({ OPENCODE_API_KEY: "test-key" }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ category: "Обувь", subcategory: "кроссовки", confidence: 0.92 });
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://opencode.ai/zen/go/v1/chat/completions");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBe("Bearer test-key");
    // opencode-go маршрутизирует запросы по сессии: заголовок обязателен и непуст.
    expect(headers[OPENCODE_SESSION_HEADER]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect((init?.signal ?? null) instanceof AbortSignal).toBe(true);

    const sent = JSON.parse(String(init?.body)) as { model: string; messages: unknown[] };
    expect(sent.model).toBe("deepseek-v4.1-flash");
    expect(JSON.stringify(sent)).toContain("data:image/jpeg;base64,AAAA");
    expect(isKnownCategory("Обувь")).toBe(true);
    expect(isKnownSubcategory("Обувь", "кроссовки")).toBe(true);
  });

  it("достаёт JSON из ```-ограждения", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        visionResponse('```json\n{"category":"Верх","subcategory":"худи","confidence":0.7}\n```'),
      ),
    );
    const response = await handleRequest(
      post("/classify", { imageBase64: "AAAA", mimeType: "image/jpeg" }),
      makeEnv({ OPENCODE_API_KEY: "key" }),
    );
    expect(await response.json()).toEqual({ category: "Второй слой", subcategory: "худи", confidence: 0.7 });
  });

  it("мусорный ответ модели → Разное с нулевой уверенностью", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => visionResponse("Извини, я не могу определить вещь на фото.")));
    const response = await handleRequest(
      post("/classify", { imageBase64: "AAAA", mimeType: "image/jpeg" }),
      makeEnv({ OPENCODE_API_KEY: "key" }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      category: FALLBACK_CATEGORY,
      subcategory: FALLBACK_SUBCATEGORY,
      confidence: 0,
    });
  });

  it("категория не из таксономии → Разное", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => visionResponse(JSON.stringify({ category: "Мебель", subcategory: "Стол", confidence: 0.9 }))),
    );
    const response = await handleRequest(
      post("/classify", { imageBase64: "AAAA", mimeType: "image/jpeg" }),
      makeEnv({ OPENCODE_API_KEY: "key" }),
    );
    expect(await response.json()).toEqual({
      category: FALLBACK_CATEGORY,
      subcategory: FALLBACK_SUBCATEGORY,
      confidence: 0,
    });
  });

  it("ошибка провайдера → 502", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => visionResponse("boom", 500)));
    const response = await handleRequest(
      post("/classify", { imageBase64: "AAAA", mimeType: "image/jpeg" }),
      makeEnv({ OPENCODE_API_KEY: "key" }),
    );
    expect(response.status).toBe(502);
    expect((await errorBody(response)).code).toBe("model_error");
  });

  it("сетевой сбой провайдера → 502 без утечки деталей", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNRESET secret-internal");
      }),
    );
    const response = await handleRequest(
      post("/classify", { imageBase64: "AAAA", mimeType: "image/jpeg" }),
      makeEnv({ OPENCODE_API_KEY: "key" }),
    );
    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).not.toContain("secret-internal");
  });

  it("генерирует новый x-opencode-session на каждый запрос", async () => {
    const fetchMock = vi.fn(
      async (_input: Request | string | URL, _init?: RequestInit) =>
        visionResponse(JSON.stringify({ category: "Обувь", subcategory: "кроссовки", confidence: 0.9 })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const env = makeEnv({ OPENCODE_API_KEY: "key" });

    await handleRequest(post("/classify", { imageBase64: "AAAA", mimeType: "image/jpeg" }), env);
    await handleRequest(post("/classify", { imageBase64: "AAAA", mimeType: "image/jpeg" }), env);

    const first = ((fetchMock.mock.calls[0]![1] as RequestInit).headers ?? {}) as Record<string, string>;
    const second = ((fetchMock.mock.calls[1]![1] as RequestInit).headers ?? {}) as Record<string, string>;
    expect(first[OPENCODE_SESSION_HEADER]).toBeTruthy();
    expect(first[OPENCODE_SESSION_HEADER]).not.toBe(second[OPENCODE_SESSION_HEADER]);
  });

  it("зависший провайдер → 504 model_timeout с CORS, а не оборванное соединение", async () => {
    vi.useFakeTimers();
    try {
      // Мок повторяет поведение fetch: висит, пока AbortSignal не отменит запрос.
      const fetchMock = vi.fn(
        (_input: Request | string | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const pending = handleRequest(
        post("/classify", { imageBase64: "AAAA", mimeType: "image/jpeg" }, ORIGIN),
        makeEnv({ OPENCODE_API_KEY: "key" }),
      );
      await vi.advanceTimersByTimeAsync(CLASSIFY_TIMEOUT_MS);
      const response = await pending;

      expect(response.status).toBe(504);
      expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
      expect((await errorBody(response)).code).toBe("model_timeout");
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Токены доступа и /session (T22)
// ---------------------------------------------------------------------------

describe("токены доступа", () => {
  it("принимает CLIENT_TOKEN и все токены из ACCESS_TOKENS (trim + dedupe)", async () => {
    const env = makeEnv({
      CLIENT_TOKEN: "legacy-token",
      ACCESS_TOKENS: " alpha, beta ,alpha,, legacy-token ",
    });
    for (const token of ["legacy-token", "alpha", "beta"]) {
      const response = await handleRequest(get("/session", ORIGIN, token), env);
      expect(response.status, token).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    }
    const rejected = await handleRequest(get("/session", ORIGIN, "gamma"), env);
    expect(rejected.status).toBe(401);
    expect((await errorBody(rejected)).code).toBe("unauthorized");
  });

  it("работает без CLIENT_TOKEN, если задан только ACCESS_TOKENS", async () => {
    const env = makeEnv({ CLIENT_TOKEN: undefined, ACCESS_TOKENS: "only-new" });
    const response = await handleRequest(get("/session", ORIGIN, "only-new"), env);
    expect(response.status).toBe(200);
  });
});

describe("GET /session", () => {
  it("с токеном → 200 {ok:true} и CORS", async () => {
    const response = await handleRequest(get("/session", ORIGIN, CLIENT_TOKEN), makeEnv());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("без токена → 401 unauthorized", async () => {
    const response = await handleRequest(get("/session"), makeEnv());
    expect(response.status).toBe(401);
    expect((await errorBody(response)).code).toBe("unauthorized");
  });

  it("без настроенных токенов → 503 not_configured", async () => {
    const response = await handleRequest(
      get("/session", ORIGIN, "any"),
      makeEnv({ CLIENT_TOKEN: undefined, ACCESS_TOKENS: undefined }),
    );
    expect(response.status).toBe(503);
    expect((await errorBody(response)).code).toBe("not_configured");
  });

  it("POST /session → 405 и Allow: GET", async () => {
    const response = await handleRequest(post("/session", {}), makeEnv());
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
  });
});

// ---------------------------------------------------------------------------
// История генераций (T23)
// ---------------------------------------------------------------------------

describe("POST /generate: pending-запись в KV", () => {
  it("пишет pending:{taskId} с metadata и TTL 7 дней", async () => {
    const kv = new FakeKV();
    stubProvider({ create: jsonResponse({ id: "gen-7", status: "PENDING", costRub: 7 }, 202) });

    const response = await handleRequest(
      post("/generate", {
        prompt: "худи",
        itemId: "item-1",
        title: "Худи",
        category: "Второй слой",
        subcategory: "худи",
      }),
      kvEnv(kv),
    );

    expect(response.status).toBe(202);
    const pending = kv.puts.find((put) => put.key === "pending:gen-7");
    expect(pending).toBeDefined();
    expect(pending?.expirationTtl).toBe(604800);
    expect(pending?.metadata).toMatchObject({
      taskId: "gen-7",
      title: "Худи",
      prompt: "худи",
      model: "gpt-image-2-text-to-image",
      costRub: 7,
      itemId: "item-1",
      category: "Второй слой",
      subcategory: "худи",
    });
    expect(typeof pending?.metadata?.createdAt).toBe("string");
  });

  it("не требует новых полей у старых клиентов", async () => {
    const kv = new FakeKV();
    stubProvider();
    const response = await handleRequest(post("/generate", { prompt: "hoodie" }), kvEnv(kv));
    expect(response.status).toBe(202);
    const pending = kv.puts.find((put) => put.key === "pending:gen-1");
    expect(pending?.metadata).toMatchObject({ taskId: "gen-1", title: "", prompt: "hoodie" });
    expect(pending?.metadata).not.toHaveProperty("itemId");
    expect(pending?.metadata).not.toHaveProperty("category");
    expect(pending?.metadata).not.toHaveProperty("subcategory");
  });

  it("обрезает metadata по лимитам и укладывается в 1024 байта", async () => {
    const kv = new FakeKV();
    stubProvider({ create: jsonResponse({ id: "gen-8", status: "PENDING", costRub: 1 }, 202) });

    await handleRequest(
      post("/generate", {
        prompt: "x".repeat(800),
        title: "T".repeat(200),
        itemId: "i".repeat(200),
        category: "c".repeat(80),
        subcategory: "s".repeat(80),
      }),
      kvEnv(kv),
    );

    const pending = kv.puts.find((put) => put.key === "pending:gen-8");
    expect(pending).toBeDefined();
    expect((pending?.metadata?.title as string).length).toBe(120);
    expect((pending?.metadata?.prompt as string).length).toBe(240);
    expect((pending?.metadata?.itemId as string).length).toBe(128);
    expect((pending?.metadata?.category as string).length).toBe(60);
    expect((pending?.metadata?.subcategory as string).length).toBe(60);
    expect(new TextEncoder().encode(JSON.stringify(pending?.metadata)).length).toBeLessThanOrEqual(
      1024,
    );
  });

  it("сбой KV не ломает создание генерации", async () => {
    const kv = new FakeKV();
    kv.failPut = true;
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    stubProvider();
    try {
      const response = await handleRequest(post("/generate", { prompt: "hoodie" }), kvEnv(kv));
      expect(response.status).toBe(202);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("KV pending"));
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe("история генераций", () => {
  const BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x10]);

  it("download сохраняет gen-запись, история её видит, картинка отдаётся", async () => {
    const kv = new FakeKV();
    kv.seed("pending:gen-42", "1", {
      taskId: "gen-42",
      title: "Худи",
      prompt: "hoodie",
      model: "gpt-image-2-text-to-image",
      costRub: 5,
      createdAt: "2026-10-20T10:00:00.000Z",
      itemId: "item-1",
      category: "Второй слой",
      subcategory: "худи",
    });
    stubProvider({
      states: [jsonResponse({ id: "gen-42", status: "SUCCEEDED", costRub: 5 })],
      download: imageResponse(BYTES, "image/jpeg"),
    });
    const env = kvEnv(kv);

    const download = await handleRequest(
      get("/generate/gen-42/image", ORIGIN, CLIENT_TOKEN),
      env,
    );
    expect(download.status).toBe(200);
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(BYTES);

    const stored = kv.entry("gen:gen-42");
    expect(stored?.metadata).toMatchObject({
      taskId: "gen-42",
      title: "Худи",
      prompt: "hoodie",
      model: "gpt-image-2-text-to-image",
      costRub: 5,
      createdAt: "2026-10-20T10:00:00.000Z",
      itemId: "item-1",
      category: "Второй слой",
      subcategory: "худи",
      contentType: "image/jpeg",
      size: BYTES.length,
    });
    expect(kv.deleted).toContain("pending:gen-42");

    const history = await handleRequest(get("/generations", ORIGIN, CLIENT_TOKEN), env);
    expect(history.status).toBe(200);
    const items = (await history.json()) as {
      items: { taskId: string; title: string; contentType: string; size: number }[];
    };
    expect(items.items).toHaveLength(1);
    expect(items.items[0]).toMatchObject({
      taskId: "gen-42",
      title: "Худи",
      contentType: "image/jpeg",
      size: BYTES.length,
    });

    const image = await handleRequest(
      get("/generations/gen-42/image", ORIGIN, CLIENT_TOKEN),
      env,
    );
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/jpeg");
    expect(image.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(image.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(BYTES);

    const missing = await handleRequest(
      get("/generations/unknown/image", ORIGIN, CLIENT_TOKEN),
      env,
    );
    expect(missing.status).toBe(404);
    expect((await errorBody(missing)).code).toBe("not_found");
  });

  it("при падении KV download всё равно отдаёт картинку", async () => {
    const kv = new FakeKV();
    kv.failRead = true;
    kv.failPut = true;
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    stubProvider({
      states: [jsonResponse({ id: "gen-42", status: "SUCCEEDED", costRub: 5 })],
      download: imageResponse(BYTES, "image/jpeg"),
    });
    try {
      const response = await handleRequest(
        get("/generate/gen-42/image", ORIGIN, CLIENT_TOKEN),
        kvEnv(kv),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/jpeg");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
      expect(kv.entry("gen:gen-42")).toBeUndefined();
      expect(logSpy).toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });

  it("сортирует историю по createdAt desc, при равенстве — по taskId desc", async () => {
    const kv = new FakeKV();
    kv.seed("gen:b", "1", {
      taskId: "b",
      title: "Б",
      prompt: "",
      model: "m",
      costRub: 1,
      createdAt: "2026-10-20T10:00:00.000Z",
    });
    kv.seed("gen:a", "1", {
      taskId: "a",
      title: "А",
      prompt: "",
      model: "m",
      costRub: 1,
      createdAt: "2026-10-21T10:00:00.000Z",
    });
    kv.seed("gen:c", "1", {
      taskId: "c",
      title: "Ц",
      prompt: "",
      model: "m",
      costRub: 1,
      createdAt: "2026-10-20T10:00:00.000Z",
    });

    const response = await handleRequest(get("/generations", ORIGIN, CLIENT_TOKEN), kvEnv(kv));
    expect(response.status).toBe(200);
    const items = (await response.json()) as { items: { taskId: string }[] };
    expect(items.items.map((item) => item.taskId)).toEqual(["a", "c", "b"]);
  });

  it("обходит все страницы list()", async () => {
    const kv = new FakeKV();
    kv.pageSize = 2;
    for (const taskId of ["g1", "g2", "g3", "g4", "g5"]) {
      kv.seed(`gen:${taskId}`, "1", {
        taskId,
        title: taskId,
        prompt: "",
        model: "m",
        costRub: null,
        createdAt: "2026-10-21T10:00:00.000Z",
      });
    }

    const response = await handleRequest(get("/generations", ORIGIN, CLIENT_TOKEN), kvEnv(kv));
    const items = (await response.json()) as { items: { taskId: string }[] };
    expect(items.items.map((item) => item.taskId)).toEqual(["g5", "g4", "g3", "g2", "g1"]);
  });

  it("без binding GENERATIONS → 503 not_configured", async () => {
    const response = await handleRequest(
      get("/generations", ORIGIN, CLIENT_TOKEN),
      iskraEnv(),
    );
    expect(response.status).toBe(503);
    expect((await errorBody(response)).code).toBe("not_configured");
  });

  it("история защищена токеном", async () => {
    const response = await handleRequest(get("/generations", ORIGIN), kvEnv(new FakeKV()));
    expect(response.status).toBe(401);
  });

  it("список и превью используют свои лимитеры", async () => {
    const listLimiter = { limit: vi.fn(async () => ({ success: false })) };
    const imageLimiter = { limit: vi.fn(async () => ({ success: false })) };
    const kv = new FakeKV();
    kv.seed("gen:gen-1", new Uint8Array([1, 2, 3]), {
      taskId: "gen-1",
      title: "",
      prompt: "",
      model: "m",
      costRub: null,
      createdAt: "2026-10-21T10:00:00.000Z",
      contentType: "image/png",
      size: 3,
    });
    const env = kvEnv(kv, {
      GENERATIONS_LIST_RATE_LIMITER: listLimiter,
      GENERATIONS_IMAGE_RATE_LIMITER: imageLimiter,
    });

    const list = await handleRequest(get("/generations", ORIGIN, CLIENT_TOKEN), env);
    expect(list.status).toBe(429);
    expect(listLimiter.limit).toHaveBeenCalledTimes(1);

    const image = await handleRequest(
      get("/generations/gen-1/image", ORIGIN, CLIENT_TOKEN),
      env,
    );
    expect(image.status).toBe(429);
    expect(imageLimiter.limit).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Чистые функции таксономии
// ---------------------------------------------------------------------------

describe("таксономия", () => {
  it("содержит 10 верхних категорий ADR-0004/ADR-0007 и «Разное» — как корневая таксономия", () => {
    expect(topCategories()).toEqual([
      "Верх",
      "Низ",
      "Платья",
      "Блузки",
      "Комбинезоны",
      "Верхняя одежда",
      "Второй слой",
      "Обувь",
      "Аксессуары",
      "Бельё",
      FALLBACK_CATEGORY,
    ]);
  });

  it("ADR-0007: блузки и комбинезоны есть в таксономии, промпте и классификации", () => {
    expect(TAXONOMY).toEqual({
      Верх: ["лонгслив", "футболка", "топ", "кроп-топ", "рубашка", "свитер"],
      Низ: ["джинсы", "брюки", "шорты", "юбка"],
      Платья: ["платье", "сарафан"],
      Блузки: ["блузка"],
      Комбинезоны: ["комбинезон"],
      "Верхняя одежда": ["куртка", "пальто", "пуховик", "пиджак", "тренч"],
      "Второй слой": ["кардиган", "жилет", "худи"],
      Обувь: ["кроссовки", "ботинки", "сапоги", "туфли", "сандалии"],
      Аксессуары: ["сумка", "ремень", "шапка", "шарф", "украшения", "очки"],
      Бельё: ["бюстгальтер", "трусы", "носки", "колготки"],
    });
    expect(subcategoriesOf("Блузки")).toEqual(["блузка"]);
    expect(subcategoriesOf("Комбинезоны")).toEqual(["комбинезон"]);
    expect(CLASSIFY_SYSTEM_PROMPT).toContain("Блузки: блузка");
    expect(CLASSIFY_SYSTEM_PROMPT).toContain("Комбинезоны: комбинезон");
    expect(
      classifyFromModel({ category: "Блузки", subcategory: "блузка", confidence: 0.9 }),
    ).toEqual({ category: "Блузки", subcategory: "блузка", confidence: 0.9 });
    expect(
      classifyFromModel({ category: "Комбинезоны", subcategory: "комбинезон", confidence: 0.8 }),
    ).toEqual({ category: "Комбинезоны", subcategory: "комбинезон", confidence: 0.8 });
  });

  it("согласована с корнем: у «Разное» есть подкатегория и это известная категория", () => {
    expect(subcategoriesOf(FALLBACK_CATEGORY)).toEqual([FALLBACK_SUBCATEGORY]);
    expect(isKnownCategory(FALLBACK_CATEGORY)).toBe(true);
    expect(isKnownSubcategory(FALLBACK_CATEGORY, FALLBACK_SUBCATEGORY)).toBe(true);
  });

  it("приводит регистр к каноническому виду", () => {
    expect(classifyFromModel({ category: "обувь", subcategory: "Кроссовки", confidence: 0.5 })).toEqual({
      category: "Обувь",
      subcategory: "кроссовки",
      confidence: 0.5,
    });
  });

  it("восстанавливает верхнюю категорию по подкатегории", () => {
    expect(classifyFromModel({ category: "Верх", subcategory: "Кроссовки" })).toEqual({
      category: "Обувь",
      subcategory: "кроссовки",
      confidence: 0,
    });
  });

  it("известная категория и неизвестная подкатегория → Разное в нижнем уровне", () => {
    expect(classifyFromModel({ category: "Обувь", subcategory: "Тапки" })).toEqual({
      category: "Обувь",
      subcategory: FALLBACK_SUBCATEGORY,
      confidence: 0,
    });
  });

  it("мусор на входе → Разное/Разное", () => {
    expect(classifyFromModel(null)).toEqual({
      category: FALLBACK_CATEGORY,
      subcategory: FALLBACK_SUBCATEGORY,
      confidence: 0,
    });
    expect(classifyFromModel("просто строка")).toEqual({
      category: FALLBACK_CATEGORY,
      subcategory: FALLBACK_SUBCATEGORY,
      confidence: 0,
    });
    expect(classifyFromModel([1, 2, 3])).toEqual({
      category: FALLBACK_CATEGORY,
      subcategory: FALLBACK_SUBCATEGORY,
      confidence: 0,
    });
  });

  it("обрезает уверенность к диапазону 0..1", () => {
    expect(classifyFromModel({ category: "Низ", subcategory: "джинсы", confidence: 5 }).confidence).toBe(1);
    expect(classifyFromModel({ category: "Низ", subcategory: "джинсы", confidence: -3 }).confidence).toBe(0);
    expect(classifyFromModel({ category: "Низ", subcategory: "джинсы", confidence: "нет" }).confidence).toBe(0);
  });
});

describe("parseModelJson", () => {
  it("разбирает чистый JSON", () => {
    expect(parseModelJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("разбирает JSON в ограждении", () => {
    expect(parseModelJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("разбирает JSON с текстом вокруг", () => {
    expect(parseModelJson('Вот ответ: {"a":1}. Готово.')).toEqual({ a: 1 });
  });

  it("возвращает null на не-JSON", () => {
    expect(parseModelJson("совсем не json")).toBeNull();
    expect(parseModelJson("[1,2,3]")).toBeNull();
  });
});
