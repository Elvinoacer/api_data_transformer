import React from "react";
import ReactDOM from "react-dom/client";
import { DemoCatalog } from "./DemoCatalog";
import "../styles/index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <DemoCatalog />
  </React.StrictMode>,
);
