import styles from './Screen.module.css'

/** Экран добавления вещи. Каркас T1: логика импорта появится в T8. */
export function AddScreen() {
  return (
    <section className={styles.screen}>
      <h1 className={styles.title}>Добавить вещь</h1>
      <form className={styles.form} onSubmit={(event) => event.preventDefault()}>
        <input
          className={styles.input}
          type="url"
          inputMode="url"
          autoComplete="off"
          placeholder="Ссылка на товар с Wildberries"
          aria-label="Ссылка на товар"
        />
        <button className={styles.button} type="submit">
          Добавить
        </button>
      </form>
    </section>
  )
}
