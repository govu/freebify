import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  // relative asset paths so the build also works from file:// (Electron)
  base: "./",
  plugins: [react(), tailwindcss()],
  server: {
    watch: {
      // electron-builder streams ~200MB into release/ during packaging —
      // chokidar grabbing those handles makes its rename() fail with EPERM
      ignored: ["**/release/**", "**/dist/**", "**/docs/**"],
    },
  },
})
