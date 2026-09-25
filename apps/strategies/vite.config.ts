import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // 3000/3001/3002 are already taken by apps/web, apps/api-local and apps/docs.
  server: {
    port: 3003,
    strictPort: true,
  },
  preview: {
    port: 3003,
  },
});
