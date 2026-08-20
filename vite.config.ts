import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { cloudflare } from '@cloudflare/vite-plugin'
import { createPersistenceMiddleware } from './server/persistence.mjs'

const isVitest = Boolean(process.env.VITEST)

export default defineConfig({
  plugins: [react(), ...(isVitest ? [] : [cloudflare()]), {
    name: 'moce-persistence-api',
    configureServer(server) {
      server.middlewares.use(createPersistenceMiddleware())
    },
  }],
  server: { port: 4173 },
})
