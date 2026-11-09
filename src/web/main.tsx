import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import { AppBoundary } from "./error-boundary.js";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <AppBoundary>
    <App />
  </AppBoundary>,
);
