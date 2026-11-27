/// <reference types="vite/client" />

import type { DesktopApi } from '../../shared/contracts'
import type { Phase2Api } from '../../shared/phase2'

declare global {
  interface Window { vinxa: DesktopApi; vinxaPhase2: Phase2Api }
}

