/**
 * Настройки устройства: то, что живёт только в браузере и не является данными
 * гардероба. Сейчас здесь один ключ — токен доступа к воркеру (T22).
 *
 * Токен больше не вшивается в бандл: пользователь вводит его один раз на
 * экране `/access`, а приложение запоминает его на этом устройстве. Поэтому
 * `localStorage` может быть недоступен (приватный режим, очищенное хранилище) —
 * ни одно чтение или сохранение не должно бросать: без токена приложение
 * остаётся рабочим, просто генерация попросит его ввести.
 */

/** Ключ токена доступа к воркеру в `localStorage`. */
export const ACCESS_TOKEN_KEY = 'tidy.accessToken'

/** Хранилище, если оно доступно в этой среде, иначе `null`. */
function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/** Сохранённый токен доступа либо `null`, если его нет или хранилище недоступно. */
export function readAccessToken(): string | null {
  try {
    const value = storage()?.getItem(ACCESS_TOKEN_KEY)
    const token = value?.trim()
    return token ? token : null
  } catch {
    return null
  }
}

/**
 * Запоминает токен на устройстве. Пустой токен стирает сохранённый: иначе
 * в хранилище остался бы пробельный огрызок, который выглядит как настройка.
 */
export function saveAccessToken(token: string): void {
  const trimmed = token.trim()
  if (trimmed === '') {
    clearAccessToken()
    return
  }
  try {
    storage()?.setItem(ACCESS_TOKEN_KEY, trimmed)
  } catch {
    // Приватный режим или переполненное хранилище: токен проживёт до перезапуска.
  }
}

/** Забывает токен доступа на этом устройстве. */
export function clearAccessToken(): void {
  try {
    storage()?.removeItem(ACCESS_TOKEN_KEY)
  } catch {
    // Нечего чистить или хранилище недоступно — молча продолжаем.
  }
}

/**
 * Маскированный вид токена для интерфейса: последние 4 символа и восемь точек.
 * Короткий токен не показываем целиком — иначе маскировка раскрыла бы его.
 */
export function maskedAccessToken(token: string): string {
  const trimmed = token.trim()
  if (trimmed === '') return ''
  if (trimmed.length <= 8) return '••••••••'
  return `••••••••${trimmed.slice(-4)}`
}
