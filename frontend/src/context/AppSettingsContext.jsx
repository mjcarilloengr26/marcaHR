import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { translate, LOCALE_BY_LANGUAGE } from "../i18n/translations";

const AppSettingsContext = createContext(null);

const DEFAULTS = { currency_code: "PHP", language: "en" };

// App-wide currency and language, set by an admin at Administration >
// Localization. Loaded from a public endpoint so the sign-in screen is
// already localized before anyone has a token.
export function AppSettingsProvider({ children }) {
  const [settings, setSettings] = useState(DEFAULTS);

  const load = useCallback(() => {
    api
      .get("/app-settings")
      .then((d) => setSettings({ currency_code: d.currency_code, language: d.language }))
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
    // The Localization page fires this after saving so the change is visible
    // immediately rather than only after a reload.
    window.addEventListener("app-settings-updated", load);
    return () => window.removeEventListener("app-settings-updated", load);
  }, [load]);

  const value = useMemo(() => {
    const locale = LOCALE_BY_LANGUAGE[settings.language] || "en-US";
    const currency = settings.currency_code || "PHP";

    // Built once per settings change rather than per call — constructing an
    // Intl.NumberFormat is comparatively expensive and these run inside table
    // and chart render loops.
    let fmt;
    try {
      fmt = new Intl.NumberFormat(locale, { style: "currency", currency, maximumFractionDigits: 0 });
    } catch {
      fmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "PHP", maximumFractionDigits: 0 });
    }

    let fmt2;
    try {
      fmt2 = new Intl.NumberFormat(locale, {
        style: "currency",
        currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    } catch {
      fmt2 = new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "PHP",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    }

    const money = (n) => fmt.format(Number(n || 0));
    // Expense/liquidation figures are shown to the centavo, so they keep two
    // decimals where the rest of the app rounds to whole units.
    const moneyPrecise = (n) => fmt2.format(Number(n || 0));

    // Compact form for chart axes (₱1.2M), where a full figure would crowd
    // the tick labels. Falls back to the plain formatter below 1000.
    const moneyCompact = (n) => {
      const v = Number(n || 0);
      const sym = money(0).replace(/[\d.,\s]/g, "");
      if (Math.abs(v) >= 1_000_000) return `${sym}${(v / 1_000_000).toFixed(v % 1_000_000 === 0 ? 0 : 1)}M`;
      if (Math.abs(v) >= 1_000) return `${sym}${(v / 1_000).toFixed(0)}k`;
      return `${sym}${v}`;
    };

    return {
      ...settings,
      locale,
      // Bare symbol, for labelling amount inputs so a form field reads in the
      // same currency the tables around it display.
      currencySymbol: money(0).replace(/[\d.,\s]/g, ""),
      money,
      moneyPrecise,
      moneyCompact,
      t: (text) => translate(text, settings.language),
      refresh: load,
    };
  }, [settings, load]);

  return <AppSettingsContext.Provider value={value}>{children}</AppSettingsContext.Provider>;
}

export function useAppSettings() {
  const ctx = useContext(AppSettingsContext);
  if (!ctx) throw new Error("useAppSettings must be used within AppSettingsProvider");
  return ctx;
}
