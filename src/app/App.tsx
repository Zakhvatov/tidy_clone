import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'

import { AppLayout } from './AppLayout'
import { AccessScreen } from './screens/AccessScreen'
import { AddScreen } from './screens/AddScreen'
import { BackupScreen } from './screens/BackupScreen'
import { GenerationsScreen } from './screens/GenerationsScreen'
import { HelpScreen } from './screens/HelpScreen'
import { ItemScreen } from './screens/ItemScreen'
import { OutfitEditorScreen } from './screens/OutfitEditorScreen'
import { OutfitsScreen } from './screens/OutfitsScreen'
import { WardrobeScreen } from './screens/WardrobeScreen'

/** Маршруты без роутера — удобно монтировать в тестах через MemoryRouter. */
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<WardrobeScreen />} />
        <Route path="add" element={<AddScreen />} />
        <Route path="item/:id" element={<ItemScreen />} />
        <Route path="outfit/:id" element={<OutfitEditorScreen />} />
        <Route path="outfits" element={<OutfitsScreen />} />
        <Route path="generations" element={<GenerationsScreen />} />
        <Route path="backup" element={<BackupScreen />} />
        <Route path="access" element={<AccessScreen />} />
        <Route path="help" element={<HelpScreen />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export function App() {
  // GitHub Pages отдаёт приложение из подкаталога (`/tidy_clone/`), Cloudflare — с корня.
  const basename = import.meta.env.BASE_URL.replace(/\/+$/, '') || '/'

  return (
    <BrowserRouter basename={basename}>
      <AppRoutes />
    </BrowserRouter>
  )
}
