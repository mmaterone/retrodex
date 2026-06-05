import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const rootUrl = new URL(".", import.meta.url);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("src", rootUrl)),
      "@retrodex/contracts": fileURLToPath(
        new URL("../../packages/contracts/src/index.ts", rootUrl)
      ),
    },
  },
});
