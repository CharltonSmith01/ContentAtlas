import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const API = process.env.API_URL || "http://localhost:3001";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // In dev the frontend is on :5173 and the API on :3001; proxy so the client
    // can use same-origin relative paths that also work in production.
    proxy: {
      "/api": { target: API, changeOrigin: true },
      "/uploads": { target: API, changeOrigin: true },
    },
  },
});
