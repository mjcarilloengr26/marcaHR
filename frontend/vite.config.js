import { execSync } from "node:child_process";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Stamped into the bundle so a deployed page can say which build it is. Without
// it, "I reloaded and it still does X" and "you are running last week's code"
// are indistinguishable from either side.
function buildId() {
  try {
    return execSync("git rev-parse --short HEAD").toString().trim();
  } catch {
    return "unknown";
  }
}

export default defineConfig({
  define: {
    __BUILD_ID__: JSON.stringify(buildId()),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC"),
  },
  plugins: [react()],
  server: {
    // Honours the port the harness assigns via PORT, falling back to Vite's
    // usual one for a plain `npm run dev`. Hardcoding it meant two projects
    // open at once fought over the same port. Nothing here needs a fixed port:
    // the API is reached through the proxy below, so the browser only ever
    // talks to this origin.
    port: Number(process.env.PORT) || 5173,
    proxy: {
      "/api": {
        target: "http://localhost:4000",
        changeOrigin: true,
      },
    },
  },
});
