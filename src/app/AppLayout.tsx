import {
  Archive,
  PlusCircle,
  Question,
  Sparkle,
  TShirt,
  type Icon,
} from '@phosphor-icons/react'
import { NavLink, Outlet } from 'react-router-dom'

import styles from './AppLayout.module.css'

interface Tab {
  to: string
  label: string
  end: boolean
  Icon: Icon
}

const tabs: Tab[] = [
  { to: '/', label: 'Гардероб', end: true, Icon: TShirt },
  { to: '/add', label: 'Добавить', end: false, Icon: PlusCircle },
  { to: '/outfits', label: 'Образы', end: false, Icon: Sparkle },
  { to: '/backup', label: 'Данные', end: false, Icon: Archive },
  { to: '/help', label: 'Помощь', end: false, Icon: Question },
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
            aria-label={tab.label}
            className={({ isActive }) =>
              isActive ? `${styles.tab} ${styles.tabActive}` : styles.tab
            }
          >
            {({ isActive }) => (
              <>
                <tab.Icon
                  className={styles.tabIcon}
                  size={22}
                  weight={isActive ? 'fill' : 'regular'}
                  aria-hidden="true"
                />
                <span className={styles.tabLabel}>{tab.label}</span>
              </>
            )}
          </NavLink>
        ))}
      </nav>
    </div>
  )
}
