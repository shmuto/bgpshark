import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: '/bgpshark/',
  build: {
    outDir: 'dist',
  },
  // Vite handles SPA fallback automatically with appType: 'spa' (default)
})
