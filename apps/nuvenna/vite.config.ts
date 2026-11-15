import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  base: "/nuvenna/",
  plugins: [react(), tailwindcss()],
  build: { outDir: "../dist/web", emptyOutDir: true },
  // Development: the API runs as its own process on port 3000.
  server: { proxy: { "/nuvenna/api": "http://localhost:3000" } },
});
