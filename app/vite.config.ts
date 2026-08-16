import { execSync } from "node:child_process";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Build provenance for the settings About block. Best-effort: falls back to "unknown"
// when the build context has no .git (e.g. a docker build that excludes it).
function gitShort(): string {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

// The built app is served by the Burrow gateway from server/web, so build there.
// In dev, connect the WebSocket to the gateway (default ws://127.0.0.1:8317) via
// VITE_GATEWAY_URL; in production the app connects to its own origin.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __BUILD_COMMIT__: JSON.stringify(gitShort()),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC"),
  },
  build: {
    outDir: "../server/web",
    emptyOutDir: true,
  },
});
