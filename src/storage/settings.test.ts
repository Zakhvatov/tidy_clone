import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ACCESS_TOKEN_KEY,
  clearAccessToken,
  maskedAccessToken,
  readAccessToken,
  saveAccessToken,
} from './settings'

describe('Настройки устройства: токен доступа (T22)', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    window.localStorage.clear()
  })

  it('сохраняет токен, обрезает пробелы и читает его обратно', () => {
    saveAccessToken('  secret-token  ')
    expect(window.localStorage.getItem(ACCESS_TOKEN_KEY)).toBe('secret-token')
    expect(readAccessToken()).toBe('secret-token')
  })

  it('пустой токен стирает сохранённый', () => {
    saveAccessToken('secret-token')
    saveAccessToken('   ')
    expect(readAccessToken()).toBeNull()
    expect(window.localStorage.getItem(ACCESS_TOKEN_KEY)).toBeNull()
  })

  it('забывает токен', () => {
    saveAccessToken('secret-token')
    clearAccessToken()
    expect(readAccessToken()).toBeNull()
  })

  it('не бросает, если localStorage недоступен', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('denied')
    })

    expect(() => saveAccessToken('secret-token')).not.toThrow()
    expect(readAccessToken()).toBeNull()
    expect(() => clearAccessToken()).not.toThrow()

    getItem.mockRestore()
    setItem.mockRestore()
    removeItem.mockRestore()
  })

  it('не бросает, если сам localStorage недоступен при обращении', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('denied')
      },
    })
    try {
      expect(() => saveAccessToken('secret-token')).not.toThrow()
      expect(readAccessToken()).toBeNull()
      expect(() => clearAccessToken()).not.toThrow()
    } finally {
      if (descriptor === undefined) delete (globalThis as { localStorage?: Storage }).localStorage
      else Object.defineProperty(globalThis, 'localStorage', descriptor)
    }
  })

  it('маскирует токен, оставляя только последние 4 символа', () => {
    expect(maskedAccessToken('abcdef12345649f6')).toBe('••••••••49f6')
    expect(maskedAccessToken('  abcdef12345649f6  ')).toBe('••••••••49f6')
    expect(maskedAccessToken('short')).toBe('••••••••')
    expect(maskedAccessToken('')).toBe('')
  })
})
