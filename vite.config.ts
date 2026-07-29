import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createPersistenceMiddleware } from './server/persistence.mjs'

export default defineConfig({
  plugins: [react(), {
    name: 'moce-persistence-api',
    configureServer(server) {
      server.middlewares.use(createPersistenceMiddleware())
    },
  }],
  server: { port: 4173 },
})
