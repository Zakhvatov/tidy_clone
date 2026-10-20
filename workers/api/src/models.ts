/**
 * Каталог моделей генерации, доступных из приложения (D13).
 *
 * Провайдер IskraGen отдаёт десятки моделей (картинки, видео, аудио). Остаётся
 * только IMAGE-медиа: text-to-image (воркер передаёт промпт и ничего больше)
 * и image-to-image (воркер загружает Оригинал в `POST /v1/files/` и подставляет
 * его URL в `params`). Список фиксирован, чтобы клиент не мог подставить
 * произвольный slug: это и защита от случайной дорогой модели, и предсказуемый
 * набор параметров.
 *
 * Цены — базовые `sellPriceRub` из публичного каталога провайдера (за кадр 1K),
 * сверены с `GET /v1/catalog/` 20.10.2026. `handleModels` в `index.ts`
 * подтягивает актуальные цены, а эти значения остаются запасными на случай
 * недоступности провайдера.
 */

import { GENERATE_ASPECT, GENERATE_RESOLUTION } from "./config";

/** Как модель принимает квадратный кадр: `aspect_ratio`, `image_size` или никак. */
export type AspectParam = "aspect_ratio" | "image_size" | null;

/** Поле `params`, в котором модель ждёт входные изображения, либо `null`. */
export type ImageInputParam = "input_urls" | "image_urls" | "image_input" | null;

export interface ImageModel {
  slug: string;
  /** Короткое название для выбора в приложении. */
  title: string;
  /** Базовая цена за кадр 1K в рублях. */
  priceRub: number;
  /** Какие параметры кадра понимает модель. */
  aspectParam: AspectParam;
  supportsResolution: boolean;
  /** Принимает ли модель референсное изображение и под каким ключом `params`. */
  imageInputParam: ImageInputParam;
}

/** Модель по умолчанию без картинки: `ISKRAGEN_MODEL_SLUG` или эта. */
export const DEFAULT_IMAGE_MODEL_SLUG = "gpt-image-2-text-to-image";

/**
 * Модель по умолчанию **с** картинкой — самая дешёвая из принимающих референс.
 * Подставляется, когда картинка пришла, а выбранная модель референс не берёт
 * (например, остался сохранённый выбор из т2и-списка D12).
 */
export const DEFAULT_IMAGE_TO_IMAGE_MODEL_SLUG = "nano-banana-2-1";

/**
 * IMAGE-модели каталога провайдера. Порядок — от дешёвых к дорогим, чтобы
 * выбор начинался с экономии. Поля `imageInputParam`/`aspectParam` сверены
 * с `paramsSchema` каталога: лишний параметр провайдер отвергает.
 */
export const IMAGE_MODELS: readonly ImageModel[] = [
  {
    slug: "nano-banana-2-1",
    title: "Nano Banana 2.1",
    priceRub: 4,
    aspectParam: "aspect_ratio",
    supportsResolution: true,
    imageInputParam: "image_input",
  },
  {
    slug: "nano-banana-2-lite",
    title: "Nano Banana 2 Lite",
    priceRub: 5,
    aspectParam: "aspect_ratio",
    supportsResolution: false,
    imageInputParam: "image_urls",
  },
  {
    slug: "grok-imagine-image-2-0-image-edit",
    title: "Grok Imagine 2.0 Edit",
    priceRub: 5,
    aspectParam: "aspect_ratio",
    supportsResolution: false,
    imageInputParam: "image_urls",
  },
  {
    slug: "grok-imagine-image-2-0-text-to-image",
    title: "Grok Imagine 2.0",
    priceRub: 5,
    aspectParam: "aspect_ratio",
    supportsResolution: false,
    imageInputParam: null,
  },
  {
    slug: "grok-imagine-text-to-image",
    title: "Grok Imagine",
    priceRub: 5,
    aspectParam: "aspect_ratio",
    supportsResolution: false,
    imageInputParam: null,
  },
  {
    slug: "grok-imagine-image-to-image",
    title: "Grok Imagine Image",
    priceRub: 5,
    aspectParam: null,
    supportsResolution: false,
    imageInputParam: "image_urls",
  },
  {
    slug: "flux-2-pro-image-to-image",
    title: "Flux 2 Pro Image",
    priceRub: 6,
    aspectParam: "aspect_ratio",
    supportsResolution: true,
    imageInputParam: "input_urls",
  },
  {
    slug: "qwen3-text-to-image",
    title: "Qwen Image 3.0",
    priceRub: 7,
    aspectParam: "image_size",
    supportsResolution: true,
    imageInputParam: null,
  },
  {
    slug: "qwen3-image-to-image",
    title: "Qwen Image 3.0 Image",
    priceRub: 7,
    aspectParam: "image_size",
    supportsResolution: true,
    imageInputParam: "image_urls",
  },
  {
    slug: "gpt-image-2-text-to-image",
    title: "GPT Image 2",
    priceRub: 7,
    aspectParam: "aspect_ratio",
    supportsResolution: true,
    imageInputParam: null,
  },
  {
    slug: "gpt-image-2-image-to-image",
    title: "GPT Image 2 Image",
    priceRub: 7,
    aspectParam: "aspect_ratio",
    supportsResolution: true,
    imageInputParam: "input_urls",
  },
  {
    slug: "gpt-image-2-5-flare-text-to-image",
    title: "GPT Image 2.5 Flare",
    priceRub: 7,
    aspectParam: "aspect_ratio",
    supportsResolution: true,
    imageInputParam: null,
  },
  {
    slug: "gpt-image-2-5-flare-image-to-image",
    title: "GPT Image 2.5 Flare Image",
    priceRub: 7,
    aspectParam: null,
    supportsResolution: false,
    imageInputParam: "input_urls",
  },
  {
    slug: "nano-banana-2",
    title: "Nano Banana 2",
    priceRub: 10,
    aspectParam: "aspect_ratio",
    supportsResolution: true,
    imageInputParam: "image_input",
  },
  {
    slug: "midjourney-text-to-image",
    title: "Midjourney",
    priceRub: 20,
    aspectParam: "aspect_ratio",
    supportsResolution: true,
    imageInputParam: null,
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
