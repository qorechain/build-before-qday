import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The public testnet REST endpoint sends no CORS headers, so the browser reaches
// it through the dev server: /lcd/... -> https://api-testnet.qore.host/...
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/lcd": {
        target: "https://api-testnet.qore.host",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/lcd/, ""),
      },
    },
  },
  preview: {
    port: 4173,
    proxy: {
      "/lcd": {
        target: "https://api-testnet.qore.host",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/lcd/, ""),
      },
    },
  },
});
