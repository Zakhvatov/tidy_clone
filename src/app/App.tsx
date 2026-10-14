import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'

import { AppLayout } from './AppLayout'
import { AddScreen } from './screens/AddScreen'
import { ItemScreen } from './screens/ItemScreen'
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
        <Route path="outfits" element={<OutfitsScreen />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  )
}
