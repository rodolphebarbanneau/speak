import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { scheduleProblems } from './src/themes/calendar'
import { SCHEDULE } from './src/themes/schedule'

/** The easter egg schedule must name theme folders, and hold together (real dates, no two themes on the same day). */
const problems = [
  ...SCHEDULE.filter(({ theme }) => !existsSync(resolve('src/themes', theme, 'palette.ts')) || !existsSync(resolve('src/themes', theme, 'index.tsx'))).map(
    ({ theme }) => `no theme "${theme}" in src/themes`
  ),
  ...scheduleProblems()
]
if (problems.length) throw new Error(`src/themes/schedule.ts: ${problems.join('; ')}`)

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
