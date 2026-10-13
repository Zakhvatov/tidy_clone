import { useEffect, useState } from 'react'

import styles from './PhotoPreview.module.css'

interface PhotoPreviewProps {
  blob: Blob
  alt: string
}

/**
 * Превью изображения по Blob. Object URL создаётся на время жизни превью и
 * освобождается при смене картинки или размонтировании, чтобы не течь памятью.
 */
export function PhotoPreview({ blob, alt }: PhotoPreviewProps) {
  const [url, setUrl] = useState('')

  useEffect(() => {
    const next = URL.createObjectURL(blob)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [blob])

  if (url === '') return <div className={styles.frame} aria-hidden="true" />

  return (
    <div className={styles.frame}>
      <img className={styles.image} src={url} alt={alt} />
    </div>
  )
}
