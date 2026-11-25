import { defineConfig } from "vite";

/** Local static page only; no app server stores chat context. */
export default defineConfig({
  server: {
    port: 5173,
    host: "127.0.0.1",
  },
});
