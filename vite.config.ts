import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const buildId = new Date().toISOString();
export default defineConfig({
  define: { __AEH_BUILD_ID__: JSON.stringify(buildId) },
  plugins: [
    react(),
    {
      name: "build-identity",
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "build.json",
          source: JSON.stringify({ buildId }),
        });
      },
    },
  ],
  server: {
    host: "127.0.0.1",
    port: 5181,
    strictPort: true,
    proxy: { "/api": "http://127.0.0.1:4381" },
  },
  build: { outDir: "web-dist", emptyOutDir: true },
});
