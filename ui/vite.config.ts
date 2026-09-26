import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Built into ui/dist and served by the host (src/ui-server). `npm run qa:ui:dev`
// runs Vite with the API proxied to a host server on QA_UI_PORT.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': `http://127.0.0.1:${process.env.QA_UI_PORT ?? 4445}` },
  },
});
