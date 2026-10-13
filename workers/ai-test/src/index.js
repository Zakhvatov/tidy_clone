/**
 * Тестовый воркер: проверяет, что Workers AI генерирует картинки на бесплатном тарифе.
 *
 *   GET /                  → страница с формой
 *   GET /?prompt=<текст>   → сгенерированная картинка
 *   GET /?prompt=<текст>&debug=1 → JSON со статусом и таймингом
 */
const MODEL = "@cf/black-forest-labs/flux-1-schnell";

const DEFAULT_PROMPT =
  "a red hoodie on a pure white background, e-commerce product photo, no shadows";

function page(prompt) {
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Workers AI — тест</title>
<style>
 body{margin:0;padding:24px;background:#0b0b0c;color:#fff;
      font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
 h1{font-size:20px;margin:0 0 16px}
 form{display:flex;gap:8px;margin-bottom:20px;flex-wrap:wrap}
 input{flex:1;min-width:220px;padding:12px 14px;border-radius:10px;border:1px solid #333;
       background:#151517;color:#fff;font-size:16px}
 button{padding:12px 20px;border-radius:10px;border:0;background:#f6821f;color:#000;
        font-weight:700;font-size:16px;cursor:pointer}
 img{max-width:100%;border-radius:12px;background:#fff}
 .hint{opacity:.55;font-size:13px;margin-top:14px}
</style></head>
<body>
  <h1>Workers AI · ${MODEL}</h1>
  <form method="get">
    <input name="prompt" value="${prompt.replace(/"/g, "&quot;")}" placeholder="промпт">
    <button type="submit">Сгенерировать</button>
  </form>
  ${
    prompt
      ? `<img src="?prompt=${encodeURIComponent(prompt)}" alt="результат">`
      : ""
  }
  <p class="hint">Если картинка появилась — бесплатная генерация работает.</p>
</body></html>`;
}

export default {
  async fetch(request, env) {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return new Response("Некорректный URL запроса", { status: 400 });
    }

    const prompt = url.searchParams.get("prompt");
    const debug = url.searchParams.get("debug");
    const steps = Number(url.searchParams.get("steps") || 4);

    // Диагностика: большой текстовый ответ того же размера, что и картинка.
    if (url.pathname === "/big") {
      const n = Number(url.searchParams.get("n") || 700000);
      const body = "A".repeat(Number.isFinite(n) ? n : 700000);
      return new Response(body, {
        headers: {
          "content-type": "text/plain",
          "cache-control": "no-store",
        },
      });
    }

    if (!prompt) {
      return new Response(page(DEFAULT_PROMPT), {
        headers: { "content-type": "text/html;charset=utf-8" },
      });
    }

    const started = Date.now();
    try {
      const out = await env.AI.run(MODEL, { prompt, steps });

      // Binding может вернуть готовый Response либо объект с base64.
      // Читаем целиком в буфер: отдавать поток наружу нельзя — обрывается.
      let bytes;
      let contentType = "image/jpeg";
      if (out instanceof Response) {
        contentType = out.headers.get("content-type") || contentType;
        bytes = new Uint8Array(await out.arrayBuffer());
      } else if (out && typeof out.image === "string") {
        bytes = Uint8Array.from(atob(out.image), (c) => c.charCodeAt(0));
      } else {
        throw new Error("неожиданный ответ модели: " + JSON.stringify(out).slice(0, 300));
      }

      if (debug) {
        return Response.json({
          ok: true,
          model: MODEL,
          prompt,
          steps,
          ms: Date.now() - started,
          contentType,
          bytes: bytes.length,
        });
      }
      return new Response(bytes, {
        headers: {
          "content-type": contentType,
          "cache-control": "no-store",
        },
      });
    } catch (err) {
      const info = { ok: false, model: MODEL, ms: Date.now() - started, error: String(err) };
      if (debug) return Response.json(info, { status: 500 });
      return new Response("Ошибка: " + info.error, { status: 500 });
    }
  },
};
