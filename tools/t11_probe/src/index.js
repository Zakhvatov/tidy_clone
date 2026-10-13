/**
 * Временный воркер-пробник для T11 (спайк).
 *
 * Зачем он нужен: локальная сеть разработчика обрывает любой ответ
 * `*.workers.dev` больше ~20 КБ (см. `docs/decisions-log.md`, D4 — ограничение
 * оказалось двусторонним). Поэтому картинку 1024×1024 (~150–250 КБ) скачать с
 * `tidy-api/generate` локально нельзя. Пробник:
 *
 *   POST /gen    {prompt} — зовёт настоящий `tidy-api` через **service binding**
 *                (это единственный способ без сети сходить из воркера в воркер
 *                того же аккаунта; обычный fetch даёт error 1042), кладёт
 *                полученные байты в KV и отдаёт {key, size}.
 *   GET  /bytes  ?key=..&off=..&len=.. — отдаёт кусок картинки (<15 КБ), чтобы
 *                ответ не попал под сетевой обрыв. Скрипт собирает файл сам.
 *
 * `CLIENT_TOKEN` пробнику передаётся переменной окружения при деплое
 * (`wrangler deploy --var CLIENT_TOKEN:<...>`), в коде секрета нет.
 */
export default {
  async fetch(request, env) {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return new Response("bad url", { status: 400 });
    }

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        hasApi: typeof env.TIDY_API?.fetch === "function",
        hasKv: typeof env.T11_IMAGES?.get === "function",
        hasToken: typeof env.CLIENT_TOKEN === "string" && env.CLIENT_TOKEN.length > 0,
      });
    }

    if (url.pathname === "/gen" && request.method === "POST") {
      let prompt;
      try {
        prompt = (await request.json()).prompt;
      } catch {
        return Response.json({ ok: false, error: "bad json" }, { status: 400 });
      }
      if (typeof prompt !== "string" || prompt.length === 0) {
        return Response.json({ ok: false, error: "empty prompt" }, { status: 400 });
      }

      // Настоящий маршрут: воркер `tidy-api` → Workers AI → image/jpeg.
      const upstream = new Request("https://tidy-api/generate", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-tidy-client": env.CLIENT_TOKEN,
        },
        body: JSON.stringify({ prompt }),
      });

      let response;
      try {
        response = await env.TIDY_API.fetch(upstream);
      } catch (error) {
        return Response.json({ ok: false, error: String(error) }, { status: 502 });
      }
      if (!response.ok) {
        const body = await response.text();
        return Response.json(
          { ok: false, status: response.status, body: body.slice(0, 500) },
          { status: 502 },
        );
      }

      const bytes = new Uint8Array(await response.arrayBuffer());
      const key = crypto.randomUUID();
      await env.T11_IMAGES.put(key, bytes);
      return Response.json({
        ok: true,
        key,
        size: bytes.byteLength,
        contentType: response.headers.get("content-type"),
      });
    }

    if (url.pathname === "/bytes") {
      const key = url.searchParams.get("key") ?? "";
      const off = Math.max(0, Number(url.searchParams.get("off") ?? 0) || 0);
      const len = Math.min(Number(url.searchParams.get("len") ?? 12000) || 12000, 15000);
      const buffer = await env.T11_IMAGES.get(key, "arrayBuffer");
      if (!buffer) return new Response("not found", { status: 404 });
      const all = new Uint8Array(buffer);
      const slice = all.slice(off, off + len);
      return new Response(slice, {
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(slice.byteLength),
          "x-total": String(all.byteLength),
          "cache-control": "no-store",
        },
      });
    }

    return new Response("not found", { status: 404 });
  },
};
