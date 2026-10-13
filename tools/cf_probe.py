#!/usr/bin/env python3
"""Разведка Cloudflare-дашборда через уже открытый Chrome (CDP на 9222).

Запуск:  python3 tools/cf_probe.py [url]
Без url — просто показывает, что сейчас на экране.
"""
import os
import re
import sys

from playwright.sync_api import sync_playwright

CDP = "http://127.0.0.1:9222"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".cf-probe")


def ensure_out_dir() -> str:
    """Создаёт каталог для скриншотов рядом с проектом."""
    path = os.path.abspath(OUT)
    try:
        os.makedirs(path, exist_ok=True)
    except OSError as exc:
        print(f"не удалось создать каталог {path}: {exc}")
        raise SystemExit(1) from exc
    return path


def dump_relevant_links(page) -> None:
    links = page.eval_on_selector_all(
        "a[href]",
        "els => els.map(e => [e.innerText.trim().slice(0,40), e.getAttribute('href')])",
    )
    seen, out = set(), []
    for title, href in links:
        if not href or href in seen:
            continue
        if re.search(r"worker|pages|ai|billing|plan|token|account", href + " " + title, re.I):
            seen.add(href)
            out.append((title, href))
    print("\n--- РЕЛЕВАНТНЫЕ ССЫЛКИ ---")
    for title, href in out[:40]:
        print(f"  {title[:40]:42s} {href[:110]}")


def main() -> None:
    url = sys.argv[1] if len(sys.argv) > 1 else None
    out_dir = ensure_out_dir()

    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp(CDP)
        context = browser.contexts[0]
        page = context.pages[-1] if context.pages else context.new_page()

        if url:
            page.goto(url, wait_until="domcontentloaded", timeout=60000)
            page.wait_for_timeout(4000)

        print("URL  :", page.url)
        print("TITLE:", page.title())

        shot = os.path.join(out_dir, "screen.png")
        page.screenshot(path=shot, full_page=False)
        print("SCREENSHOT:", shot)

        try:
            text = re.sub(r"\n{2,}", "\n", page.inner_text("body")).strip()
            print("\n--- ТЕКСТ (первые 3000) ---")
            print(text[:3000])
        except Exception as exc:  # noqa: BLE001 - диагностический скрипт
            print("текст не взят:", exc)

        try:
            dump_relevant_links(page)
        except Exception as exc:  # noqa: BLE001 - диагностический скрипт
            print("ссылки не взяты:", exc)

        browser.close()


if __name__ == "__main__":
    main()
