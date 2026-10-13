import styles from './Screen.module.css'

/** Экран образов. Каркас T1: редактор коллажа появится в T16–T18. */
export function OutfitsScreen() {
  return (
    <section className={styles.screen}>
      <h1 className={styles.title}>Образы</h1>
      <div className={styles.placeholder}>
        <p className={styles.placeholderText}>Образов пока нет</p>
      </div>
    </section>
  )
}
