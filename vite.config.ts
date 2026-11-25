import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'

// Vercel exposes the commit being built. The same value is embedded in the
// bundle and written to /version.json so the running app can detect a newer
// deployment without asking for a reload on every visit.
const buildVersion = process.env.VERCEL_GIT_COMMIT_SHA || process.env.VERCEL_DEPLOYMENT_ID || `local-${Date.now()}`

function versionFile(): Plugin {
  return {
    name: 'palatto-version-file',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ version: buildVersion }) })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  define: { __APP_BUILD_ID__: JSON.stringify(buildVersion) },
  plugins: [react(), tailwindcss(), versionFile()],
})
