import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './app/App'
import { registerAppServiceWorker } from './app/sw'

import './ui/tokens.css'
import './ui/global.css'

registerAppServiceWorker()

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('Не найден корневой элемент #root')
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
