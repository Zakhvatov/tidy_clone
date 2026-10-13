import styles from './Screen.module.css'

/** Экран гардероба. Каркас T1: список вещей появится в T13. */
export function WardrobeScreen() {
  return (
    <section className={styles.screen}>
      <h1 className={styles.title}>Гардероб</h1>
      <div className={styles.placeholder}>
        <p className={styles.placeholderText}>Гардероб пуст</p>
      </div>
    </section>
  )
}
