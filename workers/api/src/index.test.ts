import { afterEach, describe, expect, it, vi } from "vitest";

import {
  handleRequest,
  OPENCODE_SESSION_HEADER,
  parseModelJson,
  type Env,
} from "./index";
import { CLASSIFY_TIMEOUT_MS, DEFAULT_FRAME_SIZE } from "./config";
import {
  FALLBACK_CATEGORY,
  FALLBACK_SUBCATEGORY,
  classifyFromModel,
  isKnownCategory,
  isKnownSubcategory,
  topCategories,
} from "./taxonomy";

const BASE = "https://tidy-api.test";
const ORIGIN = "http://localhost:5173";
const OTHER_ORIGIN = "https://tidy-clone.pages.dev";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ALLOWED_ORIGINS: `${OTHER_ORIGIN},${ORIGIN}`,
    ...overrides,
  };
}

function get(path: string, origin?: string): Request {
  const headers: Record<string, string> = {};
  if (origin) headers.origin = origin;
  return new Request(`${BASE}${path}`, { method: "GET", headers });
}

function post(path: string, body: unknown, origin?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (origin) headers.origin = origin;
  return new Request(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

function options(path: string, origin?: string): Request {
  const headers: Record<string, string> = { "access-control-request-method": "POST" };
  if (origin) headers.origin = origin;
  return new Request(`${BASE}${path}`, { method: "OPTIONS", headers });
}

function aiEnv(result: unknown): Env {
  return makeEnv({ AI: { run: vi.fn(async () => result) } });
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
  it("сообщает ai:true, когда binding AI подключён", async () => {
    const response = await handleRequest(get("/health"), aiEnv(undefined));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, ai: true });
  });

  it("сообщает ai:false, когда binding AI отсутствует", async () => {
    const response = await handleRequest(get("/health"), makeEnv());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, ai: false });
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
    const response = await handleRequest(get("/health", OTHER_ORIGIN), aiEnv(undefined));
    expect(response.headers.get("access-control-allow-origin")).toBe(OTHER_ORIGIN);
  });

  it("не проставляет CORS чужому источнику", async () => {
    const response = await handleRequest(get("/health", "https://evil.example"), aiEnv(undefined));
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Методы и маршруты
// ---------------------------------------------------------------------------

describe("методы и маршруты", () => {
  it("GET /generate → 405 и Allow: POST", async () => {
    const response = await handleRequest(get("/generate"), aiEnv(undefined));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect((await errorBody(response)).code).toBe("method_not_allowed");
  });

  it("POST /health → 405 и Allow: GET", async () => {
    const response = await handleRequest(post("/health", {}), aiEnv(undefined));
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
    const response = await handleRequest(post("/generate", {}), aiEnv(undefined));
    expect(response.status).toBe(400);
    expect((await errorBody(response)).code).toBe("invalid_input");
  });

  it("пустой prompt → 400", async () => {
    const response = await handleRequest(post("/generate", { prompt: "   " }), aiEnv(undefined));
    expect(response.status).toBe(400);
  });

  it("prompt из 801 символа → 400", async () => {
    const response = await handleRequest(post("/generate", { prompt: "x".repeat(801) }), aiEnv(undefined));
    expect(response.status).toBe(400);
  });

  it("prompt ровно из 800 символов принимается", async () => {
    const response = await handleRequest(
      post("/generate", { prompt: "x".repeat(800) }),
      aiEnv(new Response(new Uint8Array([1]), { headers: { "content-type": "image/jpeg" } })),
    );
    expect(response.status).toBe(200);
  });

  it("нечисловой width → 400, а не 500", async () => {
    const response = await handleRequest(post("/generate", { prompt: "hoodie", width: "big" }), aiEnv(undefined));
    expect(response.status).toBe(400);
  });

  it("width вне диапазона → 400", async () => {
    const response = await handleRequest(post("/generate", { prompt: "hoodie", width: 64 }), aiEnv(undefined));
    expect(response.status).toBe(400);
  });

  it("битый JSON → 400", async () => {
    const request = new Request(`${BASE}/generate`, { method: "POST", body: "{not json" });
    const response = await handleRequest(request, aiEnv(undefined));
    expect(response.status).toBe(400);
    expect((await errorBody(response)).code).toBe("invalid_input");
  });

  it("слишком большое тело → 413", async () => {
    const response = await handleRequest(post("/generate", { prompt: "x".repeat(20_000) }), aiEnv(undefined));
    expect(response.status).toBe(413);
    expect((await errorBody(response)).code).toBe("payload_too_large");
  });
});

// ---------------------------------------------------------------------------
// POST /generate — модель
// ---------------------------------------------------------------------------

describe("POST /generate: модель", () => {
  it("отдаёт image/jpeg байтами и CORS", async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x10]);
    const response = await handleRequest(
      post("/generate", { prompt: "hoodie", width: DEFAULT_FRAME_SIZE, height: DEFAULT_FRAME_SIZE }, ORIGIN),
      aiEnv(new Response(bytes, { headers: { "content-type": "image/jpeg" } })),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it("понимает ответ модели в виде base64", async () => {
    const response = await handleRequest(
      post("/generate", { prompt: "hoodie" }),
      aiEnv({ image: btoa(String.fromCharCode(1, 2, 3)) }),
    );
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("ошибка модели → 502 model_error без утечки стектрейса", async () => {
    const run = vi.fn(async () => {
      throw new Error("internal stack: secret-token-123");
    });
    const response = await handleRequest(post("/generate", { prompt: "hoodie" }), makeEnv({ AI: { run } }));
    expect(response.status).toBe(502);

    const body = await response.json();
    expect((body as { error: { code: string } }).error.code).toBe("model_error");
    expect(JSON.stringify(body)).not.toContain("secret-token-123");
    expect(JSON.stringify(body)).not.toContain("internal stack");
  });

  it("пустой ответ модели → 502", async () => {
    const response = await handleRequest(post("/generate", { prompt: "hoodie" }), aiEnv(null));
    expect(response.status).toBe(502);
  });

  it("отсутствие binding AI → 500 без утечки деталей", async () => {
    const response = await handleRequest(post("/generate", { prompt: "hoodie" }), makeEnv());
    expect(response.status).toBe(500);
    expect((await errorBody(response)).code).toBe("internal_error");
  });

  it("не передаёт width/height в flux-1-schnell (additionalProperties: false)", async () => {
    const run = vi.fn(async (_model: string, _input: Record<string, unknown>) => new Response(new Uint8Array([9])));
    const response = await handleRequest(
      post("/generate", { prompt: "hoodie", width: 512, height: 512 }),
      makeEnv({ AI: { run } }),
    );
    expect(response.status).toBe(200);

    const input = run.mock.calls[0]![1];
    expect(input).toEqual({ prompt: "hoodie", steps: 4 });
    expect(input).not.toHaveProperty("width");
    expect(input).not.toHaveProperty("height");
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
  it("содержит 8 верхних категорий из ADR-0004", () => {
    expect(topCategories()).toEqual([
      "Верх",
      "Низ",
      "Платья",
      "Верхняя одежда",
      "Второй слой",
      "Обувь",
      "Аксессуары",
      "Бельё",
    ]);
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
