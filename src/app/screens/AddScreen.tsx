import { useNavigate } from 'react-router-dom'

import { AddItemForm } from './AddItemForm'
import screenStyles from './Screen.module.css'

/**
 * Экран добавления вещи (T8). Сама форма вынесена в `AddItemForm`, чтобы её же
 * показывал пустой гардероб на `/` (решение O7 «первый экран — добавление фото»).
 */
export function AddScreen() {
  const navigate = useNavigate()

  return (
    <section className={screenStyles.screen}>
      <h1 className={screenStyles.title}>Добавить вещь</h1>
      <AddItemForm onSaved={() => navigate('/')} />
    </section>
  )
}
