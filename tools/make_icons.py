#!/usr/bin/env python3
"""Рисует иконки приложения «Гардероб».

Тёплый терракотовый фон #C05B3F и белый силуэт вешалки — визуальное направление
ADR-0005. Скрипт воспроизводим: `python3 tools/make_icons.py` пересобирает все PNG
в public/ из одного источника.

Соглашение по формам:
  * pwa-192x192.png / pwa-512x512.png — скруглённые углы, прозрачные поля;
  * maskable-512x512.png             — заливка во весь квадрат (требование maskable);
  * apple-touch-icon.png             — заливка во весь квадрат: iOS скругляет иконку сам,
                                       двойное скругление дало бы светлые уголки.
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw

BG = (192, 91, 63, 255)  # #C05B3F
FG = (255, 255, 255, 255)
SUPERSAMPLE = 4
ROUND_RADIUS = 0.2237  # доля стороны — близко к маске iOS

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public"


def _draw_hanger(draw: ImageDraw.ImageDraw, cx: float, cy: float, unit: float, width: int) -> None:
    """Рисует вешалку: крючок, штанга и замкнутое треугольное плечо.

    Фигура центрируется по вертикали: считаем полную высоту (крючок + плечо)
    и раскладываем части от верхней границы.
    """
    bar_half = unit * 0.40
    body_h = unit * 0.80  # от штанги до нижней точки
    stem = unit * 0.11
    ring_r = unit * 0.12
    hook_h = stem + 2 * ring_r
    top = cy - (hook_h + body_h) / 2

    # Крючок: стержень вверх и кольцо-петля на конце.
    ring_cy = top + ring_r
    bar_y = top + hook_h
    draw.ellipse(
        [cx - ring_r, ring_cy - ring_r, cx + ring_r, ring_cy + ring_r],
        outline=FG,
        width=max(1, int(width * 0.85)),
    )
    draw.line([(cx, ring_cy + ring_r), (cx, bar_y)], fill=FG, width=width)

    # Плечо: замкнутый треугольник со скруглёнными стыками (без зазубрины в углу).
    bottom_y = bar_y + body_h
    outline = [
        (cx - bar_half, bar_y),
        (cx + bar_half, bar_y),
        (cx, bottom_y),
        (cx - bar_half, bar_y),
    ]
    draw.line(outline, fill=FG, width=width, joint="curve")


def _render(size: int, rounded: bool, hanger_scale: float) -> Image.Image:
    """Возвращает RGBA-иконку заданного размера, нарисованную со сглаживанием."""
    big = size * SUPERSAMPLE
    canvas = Image.new("RGBA", (big, big), (0, 0, 0, 0))

    if rounded:
        mask = Image.new("L", (big, big), 0)
        ImageDraw.Draw(mask).rounded_rectangle(
            [0, 0, big - 1, big - 1],
            radius=int(big * ROUND_RADIUS),
            fill=255,
        )
        background = Image.new("RGBA", (big, big), BG)
        canvas.paste(background, (0, 0), mask)
    else:
        canvas.paste(Image.new("RGBA", (big, big), BG), (0, 0))

    unit = big * hanger_scale
    width = max(1, int(unit * 0.09))
    _draw_hanger(ImageDraw.Draw(canvas), big / 2, big / 2, unit, width)

    return canvas.resize((size, size), Image.Resampling.LANCZOS)


def main() -> int:
    PUBLIC.mkdir(parents=True, exist_ok=True)

    outputs = [
        ("pwa-192x192.png", 192, True, 0.50),
        ("pwa-512x512.png", 512, True, 0.50),
        # maskable: заливка во весь квадрат, фигура внутри безопасной зоны ~80%.
        ("maskable-512x512.png", 512, False, 0.40),
        # apple-touch-icon: опаковый квадрат, iOS скругляет сам.
        ("apple-touch-icon.png", 180, False, 0.50),
    ]

    for name, size, rounded, scale in outputs:
        icon = _render(size, rounded=rounded, hanger_scale=scale)
        path = PUBLIC / name
        icon.save(path)
        print(f"{path.relative_to(ROOT)}: {size}x{size}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
