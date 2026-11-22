import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  plugins: [react()],
  base: './',
  build: { outDir: '../src/admin/web-next', emptyOutDir: true, chunkSizeWarningLimit: 300 },
})
