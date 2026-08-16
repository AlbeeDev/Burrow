import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { GatewayProvider } from "./lib/useGateway";
import { initTheme } from "./lib/theme";

initTheme(); // saved theme before first paint, no default-theme flash

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <GatewayProvider>
      <App />
    </GatewayProvider>
  </StrictMode>,
);
