import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Phase2App } from './Phase2'
import { CaptureDiagnostic } from './CaptureDiagnostic'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {window.location.hash === '#capture-test' ? <CaptureDiagnostic /> : <Phase2App />}
  </StrictMode>
)

