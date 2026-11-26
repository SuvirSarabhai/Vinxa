import { contextBridge } from 'electron'

contextBridge.exposeInMainWorld('vinxa', {
  platform: process.platform
})

