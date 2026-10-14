import { NavLink, Outlet } from 'react-router-dom'

import styles from './AppLayout.module.css'

const tabs = [
  { to: '/', label: 'Гардероб', end: true },
  { to: '/add', label: 'Добавить', end: false },
  { to: '/outfits', label: 'Образы', end: false },
  { to: '/backup', label: 'Копия', end: false },
  { to: '/help', label: 'Помощь', end: false },
]

/** Общий каркас приложения: область экрана + нижняя навигация. */
export function AppLayout() {
  return (
    <div className={styles.shell}>
      <main className={styles.content}>
        <Outlet />
      </main>
      <nav className={styles.tabs} aria-label="Основная навигация">
        {tabs.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.end}
            className={({ isActive }) =>
              isActive ? `${styles.tab} ${styles.tabActive}` : styles.tab
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>
    </div>
  )
}
