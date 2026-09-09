import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import CopyAtlas from "../copy-atlas_1.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <CopyAtlas />
  </StrictMode>
);
