import { useEffect, useState } from 'react'

/**
 * Следит за наличием сети. Данные гардероба и так локальные, поэтому
 * офлайн-индикатор нужен только там, где без сети ничего не выйдет:
 * импорт по ссылке Wildberries и распознавание/оцифровка фото.
 *
 * Считаем, что сеть есть, если браузер не сообщает обратного: так экран не
 * мигает предупреждением до первого события `offline`.
 */
export function useOnline(): boolean {
  const [online, setOnline] = useState(
    () => typeof navigator === 'undefined' || navigator.onLine !== false,
  )

  useEffect(() => {
    if (typeof window === 'undefined') return
    const включить = () => setOnline(true)
    const выключить = () => setOnline(false)

    window.addEventListener('online', включить)
    window.addEventListener('offline', выключить)
    // Событие могло пройти до подписки — сверяемся с текущим состоянием.
    setOnline(navigator.onLine !== false)

    return () => {
      window.removeEventListener('online', включить)
      window.removeEventListener('offline', выключить)
    }
  }, [])

  return online
}
