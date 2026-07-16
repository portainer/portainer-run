import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './design-system/tokens.css'
import './design-system/styles/StatusSummaryBar.css'
import './design-system/styles/StatusHealthTree.css'
import './design-system/styles/ActionBar.css'
import './design-system/styles/ResourceDetailHeader.css'
import './design-system/styles/ResourceDetailTabs.css'
import './design-system/styles/SortableList.css'
import './app-shell.css'
import './index.css'
import { App } from './App'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
