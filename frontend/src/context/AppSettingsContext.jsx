import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { translate, LOCALE_BY_LANGUAGE } from "../i18n/translations";

const AppSettingsContext = createContext(null);

const DEFAULTS = { currency_code: "PHP", language: "en", timezone: "Asia/Manila" };

// App-wide currency and language, set by an admin at Administration >
// Localization. Loaded from a public endpoint so the sign-in screen is
// already localized before anyone has a token.
export function AppSettingsProvider({ children }) {
  const [settings, setSettings] = useState(DEFAULTS);

  const load = useCallback(() => {
    api
      .get("/app-settings")
      .then((d) =>
        setSettings({
          currency_code: d.currency_code,
          language: d.language,
          timezone: d.timezone || DEFAULTS.timezone,
        })
      )
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
    const timezone = settings.timezone || DEFAULTS.timezone;
    const currency = settings.currency_code || "PHP";

    // Built once per settings change rather than per call — constructing an
    // Intl.NumberFormat is comparatively expensive and these run inside table
    // and chart render loops.
    let fmt;
    try {
      fmt = new Intl.NumberFormat(locale, {
        style: "currency",
        currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    } catch {
      fmt = new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "PHP",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    }

    // Headline tiles read better without centavos: a KPI is a magnitude, and
    // ₱12,550,200 is quicker to take in than ₱12,550,200.00. Tables and line
    // items keep the exact figure, because those are what get reconciled.
    let fmtWhole;
    try {
      fmtWhole = new Intl.NumberFormat(locale, { style: "currency", currency, maximumFractionDigits: 0 });
    } catch {
      fmtWhole = new Intl.NumberFormat("en-US", { style: "currency", currency: "PHP", maximumFractionDigits: 0 });
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

    // Centavos when there are centavos, and not otherwise. Rounding everything
    // to whole pesos made an invoice for 1,234.56 read as 1,235; forcing two
    // decimals on everything made a clean 500,000 read as 500,000.00. Neither
    // is what the figure actually is.
    //
    // A part-peso amount always shows both places, so 1,234.5 is 1,234.50
    // rather than the 1,234.5 a plain min-0/max-2 format would produce.
    const money = (n) => {
      const v = Number(n || 0);
      // Rounded before the test, or 0.1 + 0.2 style drift would make a whole
      // amount look fractional and sprout decimals it does not have.
      const rounded = Math.round(v * 100) / 100;
      return Number.isInteger(rounded) ? fmtWhole.format(rounded) : fmt2.format(rounded);
    };
    // The liquidation screens ask for this by name. It follows the same rule as
    // money(): a figure reconciled to the centavo shows its centavos, and one
    // that has none does not need .00 to prove it.
    const moneyPrecise = money;
    // For KPI tiles only. Anywhere a figure is added up or checked against a
    // document, use money().
    const moneyWhole = (n) => fmtWhole.format(Number(n || 0));

    // Compact form for chart axes (₱1.2M), where a full figure would crowd
    // the tick labels. Falls back to the plain formatter below 1000.
    const moneyCompact = (n) => {
      const v = Number(n || 0);
      const sym = money(0).replace(/[\d.,\s]/g, "");
      if (Math.abs(v) >= 1_000_000) return `${sym}${(v / 1_000_000).toFixed(v % 1_000_000 === 0 ? 0 : 1)}M`;
      if (Math.abs(v) >= 1_000) return `${sym}${(v / 1_000).toFixed(0)}k`;
      return `${sym}${v}`;
    };

    // Every screen showing a stored timestamp had its own hardcoded
    // Asia/Manila call. Centralising it means changing the setting moves all
    // of them together, rather than leaving stragglers behind in some corner.
    const formatDateTime = (dbTimestamp) => {
      if (!dbTimestamp) return "—";
      const raw = String(dbTimestamp);
      const iso = `${raw.replace(" ", "T")}${raw.endsWith("Z") ? "" : "Z"}`;
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return raw;
      return d.toLocaleString(locale, { timeZone: timezone, dateStyle: "medium", timeStyle: "short" });
    };

    return {
      ...settings,
      locale,
      timezone,
      formatDateTime,
      // Bare symbol, for labelling amount inputs so a form field reads in the
      // same currency the tables around it display.
      currencySymbol: money(0).replace(/[\d.,\s]/g, ""),
      money,
      moneyPrecise,
      moneyWhole,
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
