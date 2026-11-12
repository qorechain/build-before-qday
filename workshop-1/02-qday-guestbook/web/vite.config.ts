import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The public testnet REST endpoint sends no CORS headers, so the browser reaches
// it through the dev server: /lcd/... -> https://api-testnet.qore.host/...
const proxy = {
  "/lcd": { target: "https://api-testnet.qore.host", changeOrigin: true, rewrite: (p: string) => p.replace(/^\/lcd/, "") },
};
export default defineConfig({ plugins: [react()], server: { port: 5174, proxy }, preview: { port: 4174, proxy } });
