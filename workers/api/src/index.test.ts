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
  GENERATE_POLL_INTERVAL_MS,
  GENERATE_TIMEOUT_MS,
} from "./config";
import {
  FALLBACK_CATEGORY,
  FALLBACK_SUBCATEGORY,
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
}

/**
 * Мок IskraGen: один `fetch` на три ручки. Возвращает мок, чтобы тесты могли
 * проверить тело запроса и заголовки.
 */
function stubProvider(script: ProviderScript = {}) {
  const states = [...(script.states ?? [])];
  const fetchMock = vi.fn(async (input: Request | string | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/generations")) {
      return script.create ?? jsonResponse({ id: "gen-1", status: "SUCCEEDED", costRub: 7 }, 202);
    }
    if (url.endsWith("/download?index=0")) {
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

/** Окружение с полным успешным прогоном провайдера (POST → SUCCEEDED → download). */
function iskraSuccessEnv(overrides: Partial<Env> = {}): Env {
  stubProvider();
  return iskraEnv(overrides);
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

  it("отдаёт text-to-image модели с живыми ценами провайдера", async () => {
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
    expect(body.models).toHaveLength(9);
    expect(body.models.find((m) => m.slug === "nano-banana-2-1")?.priceRub).toBe(3);
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
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^image\//);
  });
});

// ---------------------------------------------------------------------------
// Ограничение тела на потоке
// ---------------------------------------------------------------------------

describe("ограничение тела на потоке", () => {
  const LIMIT = 16 * 1024;

  it("тело ровно на границе проходит", async () => {
    const body = generateBody(LIMIT);
    expect(new TextEncoder().encode(body).length).toBe(LIMIT);
    const request = new Request(`${BASE}/generate`, { method: "POST", headers: authHeaders(undefined), body });
    const response = await handleRequest(request, iskraSuccessEnv());
    expect(response.status).toBe(200);
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
    expect(response.status).toBe(200);
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
    expect(response.status).toBe(200);
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

  it("слишком большое тело → 413", async () => {
    const response = await handleRequest(post("/generate", { prompt: "x".repeat(20_000) }), iskraEnv());
    expect(response.status).toBe(413);
    expect((await errorBody(response)).code).toBe("payload_too_large");
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
    expect(response.status).toBe(200);
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
    expect(response.status).toBe(200);
  });

  it("без binding лимитера запрос проходит (локальный запуск)", async () => {
    stubProvider();
    const response = await handleRequest(post("/generate", { prompt: "hoodie" }), iskraEnv());
    expect(response.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// POST /generate — модель
// ---------------------------------------------------------------------------

describe("POST /generate: провайдер", () => {
  it("ставит задачу, опрашивает статус и отдаёт байты с CORS", async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x10]);
    const fetchMock = stubProvider({
      create: jsonResponse({ id: "gen-42", status: "PENDING", costRub: 7 }, 202),
      states: [
        jsonResponse({ id: "gen-42", status: "PROCESSING" }),
        jsonResponse({ id: "gen-42", status: "SUCCEEDED", costRub: 7 }),
      ],
      download: imageResponse(bytes, "image/jpeg"),
    });

    vi.useFakeTimers();
    let response: Response;
    try {
      const pending = handleRequest(
        post("/generate", { prompt: "hoodie", width: DEFAULT_FRAME_SIZE, height: DEFAULT_FRAME_SIZE }, ORIGIN),
        iskraEnv(),
      );
      await vi.advanceTimersByTimeAsync(GENERATE_POLL_INTERVAL_MS * 2);
      response = await pending;
    } finally {
      vi.useRealTimers();
    }

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);

    // create + два опроса + download
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const [createUrl, createInit] = fetchMock.mock.calls[0]!;
    expect(String(createUrl)).toBe("https://api.iskragen.ru/v1/generations");
    const headers = (createInit?.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${ISKRA_KEY}`);
    const sent = JSON.parse(String(createInit?.body)) as Record<string, unknown>;
    expect(sent).toEqual({
      modelSlug: "gpt-image-2-text-to-image",
      prompt: "hoodie",
      params: { aspect_ratio: "1:1", resolution: "1K" },
    });
    expect(sent).not.toHaveProperty("width");
    expect(sent).not.toHaveProperty("height");
  });

  it("скачивает результат через /download с авторизацией", async () => {
    const fetchMock = stubProvider();
    const response = await handleRequest(post("/generate", { prompt: "hoodie" }), iskraEnv());
    expect(response.status).toBe(200);

    const [url, init] = fetchMock.mock.calls[1]!;
    expect(String(url)).toBe("https://api.iskragen.ru/v1/generations/gen-1/download?index=0");
    expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${ISKRA_KEY}`);
  });

  it("успешная задача сразу (без polling) не ждёт", async () => {
    stubProvider();
    const response = await handleRequest(post("/generate", { prompt: "hoodie" }), iskraEnv());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
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

  it("FAILED задачи → 502 model_error", async () => {
    stubProvider({
      create: jsonResponse({ id: "gen-1", status: "PENDING" }, 202),
      states: [jsonResponse({ id: "gen-1", status: "FAILED", errorCode: "PROVIDER_ERROR" })],
    });
    vi.useFakeTimers();
    try {
      const pending = handleRequest(post("/generate", { prompt: "hoodie" }), iskraEnv());
      await vi.advanceTimersByTimeAsync(GENERATE_POLL_INTERVAL_MS);
      const response = await pending;
      expect(response.status).toBe(502);
      expect((await errorBody(response)).code).toBe("model_error");
    } finally {
      vi.useRealTimers();
    }
  });

  it("не-картинка вместо файла → 502", async () => {
    stubProvider({ download: new Response("not an image", { headers: { "content-type": "text/plain" } }) });
    const response = await handleRequest(post("/generate", { prompt: "hoodie" }), iskraEnv());
    expect(response.status).toBe(502);
    expect((await errorBody(response)).code).toBe("model_error");
  });

  it("пустой файл → 502", async () => {
    stubProvider({ download: imageResponse(new Uint8Array(0), "image/png") });
    const response = await handleRequest(post("/generate", { prompt: "hoodie" }), iskraEnv());
    expect(response.status).toBe(502);
  });

  it("задача не завершилась за отведённое время → 504 model_timeout", async () => {
    stubProvider({
      create: jsonResponse({ id: "gen-1", status: "PENDING" }, 202),
      states: [],
    });
    vi.useFakeTimers();
    try {
      const pending = handleRequest(post("/generate", { prompt: "hoodie" }), iskraEnv());
      await vi.advanceTimersByTimeAsync(GENERATE_TIMEOUT_MS + GENERATE_POLL_INTERVAL_MS);
      const response = await pending;
      expect(response.status).toBe(504);
      expect((await errorBody(response)).code).toBe("model_timeout");
    } finally {
      vi.useRealTimers();
    }
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
    expect(response.status).toBe(200);
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
    expect(response.status).toBe(200);
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
    expect(response.status).toBe(200);
    expect(sentBody(fetchMock)).toMatchObject({ modelSlug: "gpt-image-2-text-to-image" });
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
// Чистые функции таксономии
// ---------------------------------------------------------------------------

describe("таксономия", () => {
  it("содержит 8 верхних категорий ADR-0004 и «Разное» — как корневая таксономия", () => {
    expect(topCategories()).toEqual([
      "Верх",
      "Низ",
      "Платья",
      "Верхняя одежда",
      "Второй слой",
      "Обувь",
      "Аксессуары",
      "Бельё",
      FALLBACK_CATEGORY,
    ]);
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
