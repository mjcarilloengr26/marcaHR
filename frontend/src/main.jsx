import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App.jsx";
import { AuthProvider } from "./context/AuthContext.jsx";
import { ThemeProvider } from "./context/ThemeContext.jsx";
import { AppSettingsProvider } from "./context/AppSettingsContext.jsx";
import "./index.css";

// Which build this page is actually running. Read it from the console, or as
// window.__BUILD__ — the quickest way to tell a code problem from a stale tab.
window.__BUILD__ = { id: __BUILD_ID__, built: __BUILD_TIME__ };
console.log(`%cMARCA build ${__BUILD_ID__}%c  ${__BUILD_TIME__}`, "font-weight:bold", "color:#888");

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <ThemeProvider>
        <AppSettingsProvider>
          <AuthProvider>
            <App />
          </AuthProvider>
        </AppSettingsProvider>
      </ThemeProvider>
    </BrowserRouter>
  </React.StrictMode>
);
