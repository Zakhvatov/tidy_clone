import screenStyles from './Screen.module.css'
import styles from './HelpScreen.module.css'

const ШАГИ_УСТАНОВКИ = [
  'Откройте «Гардероб» в Safari — это важно: «На экран Домой» есть только в нём.',
  'Нажмите кнопку «Поделиться» — квадрат со стрелкой вверх.',
  'Пролистайте список действий и выберите «На экран Домой».',
  'Проверьте название «Гардероб» и нажмите «Добавить».',
  'Готово: иконка на домашнем экране, приложение открывается в полный экран.',
]

/**
 * Экран «Установка и помощь».
 *
 * Онбординг минимальный (см. «Решения» в docs/tickets.md): ни туториалов, ни
 * карусели. Только короткая инструкция «Поделиться → На экран Домой», которую
 * иначе пришлось бы искать в README, — а телефон рядом с женой, а не ноутбук.
 */
export function HelpScreen() {
  return (
    <section className={screenStyles.screen}>
      <h1 className={screenStyles.title}>Установка и помощь</h1>
      <p className={styles.lead}>
        «Гардероб» — веб-приложение. В App Store его нет: оно ставится прямо из Safari и выглядит
        как обычная иконка на домашнем экране.
      </p>

      <section className={styles.card}>
        <h2 className={styles.cardTitle}>Как поставить на iPhone</h2>
        <ol className={styles.steps}>
          {ШАГИ_УСТАНОВКИ.map((шаг) => (
            <li key={шаг} className={styles.step}>
              {шаг}
            </li>
          ))}
        </ol>
        <p className={styles.note}>
          Вход и аккаунт не нужны. Вещи, изображения и образы хранятся только на этом телефоне.
        </p>
      </section>

      <section className={styles.card}>
        <h2 className={styles.cardTitle}>Если что-то не так</h2>
        <ul className={styles.list}>
          <li className={styles.item}>
            Нет пункта «На экран Домой» — страница открыта в другом браузере. Откройте её именно
            в Safari.
          </li>
          <li className={styles.item}>
            Пропал интернет — приложение продолжает открываться: вещи и образы лежат на телефоне.
            Сеть нужна только для добавления вещи по ссылке и для AI-версии.
          </li>
          <li className={styles.item}>
            Нужно перенести гардероб на другой телефон — сохраните файл в разделе «Копия» внизу
            экрана и импортируйте его там.
          </li>
        </ul>
      </section>
    </section>
  )
}
