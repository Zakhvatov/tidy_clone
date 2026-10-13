/**
 * Сырые данные карточки Wildberries.
 *
 * Это НЕ доменная «Вещь» (`src/domain/types.ts`) и не должно её дублировать:
 * `WbCard` — снимок внешних данных продавца, который затем переводится в Вещь
 * словарём таксономии (T7). Имена полей — английские, потому что это чужая
 * схема, а не язык нашего домена (см. `CONTEXT.md`).
 */

/** Извлечённые из `card.json` + `sellers.json` данные товара. */
export interface WbCard {
  /** `nm_id` карточки. Единственное обязательное поле. */
  nmId: number
  /** `imt_name` — название товара. */
  name?: string
  /** `subj_name` — категория WB (в нашей таксономии — подкатегория). */
  subjectName?: string
  /** `subj_root_name` — надкатегория WB. */
  rootSubjectName?: string
  /** `selling.brand_name` — бренд. */
  brand?: string
  /** `nm_colors_names` — строка «бордовый, зеленый» → массив. */
  colors: string[]
  /** Состав из опций WB («Состав …»). Может быть пустым. */
  composition: string[]
  /** `contents` — комплектация, свободный текст продавца. */
  contents?: string
  /** `media.photo_count` — сколько фото в карточке. */
  photoCount: number
  /** Собранные ссылки на фото `images/big/{n}.webp`, длина = `photoCount`. */
  photoUrls: string[]
  /** `sellers.json → supplierName`. */
  sellerName?: string
  /** `sellers.json → trademark`. */
  trademark?: string
}
