import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { resolve } from "path";

const naiveUiVendorPackages = [
  "@css-render/plugin-bem",
  "@css-render/vue3-ssr",
  "async-validator",
  "css-render",
  "date-fns",
  "date-fns-tz",
  "evtd",
  "lodash-es",
  "seemly",
  "treemate",
  "vdirs",
  "vooks",
  "vueuc",
];

function vendorChunk(id: string): string | undefined {
  const normalizedId = id.replaceAll("\\", "/");

  if (!normalizedId.includes("/node_modules/")) {
    return undefined;
  }

  if (normalizedId.includes("/node_modules/naive-ui/")) {
    return "naive-ui";
  }

  if (naiveUiVendorPackages.some((pkg) => normalizedId.includes(`/node_modules/${pkg}/`))) {
    return "naive-ui-vendor";
  }

  if (normalizedId.includes("/node_modules/lucide-vue-next/")) {
    return "icons";
  }

  if (normalizedId.includes("/node_modules/ansi_up/")) {
    return "ansi";
  }

  return "vendor";
}

export default defineConfig(async () => ({
  plugins: [vue()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
    host: true,
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "esnext",
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    rollupOptions: {
      output: {
        manualChunks: vendorChunk,
      },
    },
  },
}));
