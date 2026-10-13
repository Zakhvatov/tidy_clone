import { useObjectUrl } from './useObjectUrl'
import styles from './ItemImage.module.css'

interface ItemImageProps {
  /** Blob изображения вещи (AI-версия или Оригинал). */
  blob?: Blob
  alt: string
}

/**
 * Изображение вещи в сетке гардероба: на подложке `#F6F6F4` (ADR-0005).
 *
 * Грузится лениво (`loading="lazy"`) и декодируется асинхронно (`decoding="async"`),
 * контейнер держит фиксированную пропорцию 3:4 — вёрстка не прыгает, пока картинка
 * не пришла. Object URL создаётся и освобождается хуком `useObjectUrl`.
 */
export function ItemImage({ blob, alt }: ItemImageProps) {
  const url = useObjectUrl(blob)

  return (
    <div className={styles.frame}>
      {url !== '' && (
        <img className={styles.image} src={url} alt={alt} loading="lazy" decoding="async" />
      )}
    </div>
  )
}
