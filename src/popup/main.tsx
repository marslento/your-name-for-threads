import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "../index.css";
import { t } from "../i18n/t";
import { App } from "./App";

document.title = t("extension_name");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
