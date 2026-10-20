/**
 * Каталог моделей генерации, доступных из приложения.
 *
 * Провайдер IskraGen отдаёт десятки моделей (картинки, видео, аудио), но нам
 * нужны только text-to-image: воркер передаёт промпт и ничего больше. Список
 * фиксирован, чтобы клиент не мог подставить произвольный slug: это и защита
 * от случайной дорогой модели, и предсказуемый набор параметров.
 *
 * Цены — базовые `sellPriceRub` из публичного каталога провайдера (за кадр 1K).
 * `handleModels` в `index.ts` подтягивает актуальные цены из каталога, а эти
 * значения остаются запасными на случай недоступности провайдера.
 */

import { GENERATE_ASPECT, GENERATE_RESOLUTION } from "./config";

/** Как модель принимает квадратный кадр: `aspect_ratio`, `image_size` или никак. */
export type AspectParam = "aspect_ratio" | "image_size" | null;

export interface ImageModel {
  slug: string;
  /** Короткое название для выбора в приложении. */
  title: string;
  /** Базовая цена за кадр 1K в рублях. */
  priceRub: number;
  /** Какие параметры кадра понимает модель. */
  aspectParam: AspectParam;
  supportsResolution: boolean;
}

/** Модель по умолчанию, если `ISKRAGEN_MODEL_SLUG` не задан или неизвестен UI. */
export const DEFAULT_IMAGE_MODEL_SLUG = "gpt-image-2-text-to-image";

/**
 * Только text-to-image модели каталога. Image-to-image сюда не входят: наш
 * поток не отправляет провайдеру исходное изображение. Порядок — от дешёвых к
 * дорогим, чтобы выбор начинался с экономии.
 */
export const IMAGE_MODELS: readonly ImageModel[] = [
  {
    slug: "nano-banana-2-1",
    title: "Nano Banana 2.1",
    priceRub: 4,
    aspectParam: "aspect_ratio",
    supportsResolution: true,
  },
  {
    slug: "nano-banana-2-lite",
    title: "Nano Banana 2 Lite",
    priceRub: 5,
    aspectParam: "aspect_ratio",
    supportsResolution: false,
  },
  {
    slug: "grok-imagine-image-2-0-text-to-image",
    title: "Grok Imagine 2.0",
    priceRub: 5,
    aspectParam: "aspect_ratio",
    supportsResolution: false,
  },
  {
    slug: "grok-imagine-text-to-image",
    title: "Grok Imagine",
    priceRub: 5,
    aspectParam: "aspect_ratio",
    supportsResolution: false,
  },
  {
    slug: "qwen3-text-to-image",
    title: "Qwen Image 3.0",
    priceRub: 7,
    aspectParam: "image_size",
    supportsResolution: true,
  },
  {
    slug: "gpt-image-2-text-to-image",
    title: "GPT Image 2",
    priceRub: 7,
    aspectParam: "aspect_ratio",
    supportsResolution: true,
  },
  {
    slug: "gpt-image-2-5-flare-text-to-image",
    title: "GPT Image 2.5 Flare",
    priceRub: 7,
    aspectParam: "aspect_ratio",
    supportsResolution: true,
  },
  {
    slug: "nano-banana-2",
    title: "Nano Banana 2",
    priceRub: 10,
    aspectParam: "aspect_ratio",
    supportsResolution: true,
  },
  {
    slug: "midjourney-text-to-image",
    title: "Midjourney",
    priceRub: 20,
    aspectParam: "aspect_ratio",
    supportsResolution: true,
  },
];

const BY_SLUG = new Map(IMAGE_MODELS.map((model) => [model.slug, model]));

export function findImageModel(slug: string): ImageModel | undefined {
  return BY_SLUG.get(slug);
}

/**
 * Параметры кадра для конкретной модели. Нельзя слать всем одно и то же:
 * Qwen ждёт `image_size` вместо `aspect_ratio`, а Grok не понимает
 * `resolution` и отвергает неизвестный параметр.
 */
export function frameParams(model: ImageModel): Record<string, string> {
  const params: Record<string, string> = {};
  if (model.aspectParam !== null) params[model.aspectParam] = GENERATE_ASPECT;
  if (model.supportsResolution) params.resolution = GENERATE_RESOLUTION;
  return params;
}
