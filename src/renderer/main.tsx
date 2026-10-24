import "./ipc/install-entry";
import { signalShellReady } from "./ipc/install";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("root container missing");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
);

// 兩個影格後外殼已實際繪製，再請外殼顯示視窗。
requestAnimationFrame(() => requestAnimationFrame(signalShellReady));
