import { registerSW } from 'virtual:pwa-register'

/**
 * Регистрирует service worker в режиме autoUpdate: новая версия
 * подхватывается при следующем открытии приложения (O9).
 */
export function registerAppServiceWorker(): () => void {
  return registerSW({ immediate: true })
}
