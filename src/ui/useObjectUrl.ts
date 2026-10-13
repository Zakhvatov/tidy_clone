import { useEffect, useState } from 'react'

/**
 * Держит object URL для `Blob`'а: создаёт его при появлении или смене blob'а и
 * освобождает при смене и при размонтировании. Так `URL.createObjectURL` не
 * накапливается при перерисовках и переходах между экранами.
 *
 * Возвращает пустую строку, пока URL не готов или blob отсутствует.
 */
export function useObjectUrl(blob: Blob | undefined): string {
  const [url, setUrl] = useState('')

  useEffect(() => {
    if (blob === undefined) {
      setUrl('')
      return
    }
    const next = URL.createObjectURL(blob)
    setUrl(next)
    return () => {
      URL.revokeObjectURL(next)
    }
  }, [blob])

  return url
}
