import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { SCHEDULE } from './src/themes/schedule'

/** The easter egg schedule must name theme folders and real month-days (MM-DD). */
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
for (const { theme, from, to } of SCHEDULE) {
  if (!existsSync(resolve('src/themes', theme, 'palette.ts')) || !existsSync(resolve('src/themes', theme, 'index.tsx'))) {
    throw new Error(`src/themes/schedule.ts: no theme "${theme}" in src/themes`)
  }
  for (const date of [from, to]) {
    const [month, day] = /^\d\d-\d\d$/.test(date) ? date.split('-').map(Number) : [0, 0]
    if (!(month >= 1 && month <= 12 && day >= 1 && day <= DAYS_IN_MONTH[month - 1])) {
      throw new Error(`src/themes/schedule.ts: "${date}" is not a month-day (MM-DD)`)
    }
  }
}

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    root: resolve('src/renderer'),
    resolve: { alias: { '@shared': resolve('src/shared'), '@themes': resolve('src/themes') } },
    plugins: [react()],
    build: {
      rollupOptions: { input: { index: resolve('src/renderer/index.html') } }
    }
  }
})
