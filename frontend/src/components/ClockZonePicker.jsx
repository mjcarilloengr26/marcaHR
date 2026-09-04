import { useEffect, useRef, useState } from "react";

const STORAGE_KEY = "marca-clock-zone";

// "company" | "device" | an IANA zone name. Kept in localStorage rather than on
// the user record on purpose: "follow this device" is a per-device answer by
// definition, and someone signing in from a site laptop in another country
// wants that laptop's time, not a preference they set once at head office.
export function readClockZonePref() {
  try {
    return localStorage.getItem(STORAGE_KEY) || "company";
  } catch {
    return "company";
  }
}

export function deviceZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

// Resolves the preference to an actual zone. Falls back to company time
// whenever the stored value cannot be honoured — a zone the browser does not
// know, or storage that throws.
export function resolveClockZone(pref, companyZone) {
  if (pref === "device") return deviceZone() || companyZone;
  if (!pref || pref === "company") return companyZone;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: pref });
    return pref;
  } catch {
    return companyZone;
  }
}

// Every zone the browser knows, so a user in an unlisted country is not stuck.
// supportedValuesOf is recent; the fallback covers the places this company
// actually operates in and around.
function allZones() {
  try {
    if (typeof Intl.supportedValuesOf === "function") return Intl.supportedValuesOf("timeZone");
  } catch {
    /* fall through */
  }
  return [
    "Asia/Manila", "Asia/Singapore", "Asia/Hong_Kong", "Asia/Kuala_Lumpur", "Asia/Jakarta",
    "Asia/Bangkok", "Asia/Ho_Chi_Minh", "Asia/Tokyo", "Asia/Seoul", "Asia/Shanghai",
    "Asia/Kolkata", "Asia/Dubai", "Asia/Riyadh", "Australia/Sydney", "Pacific/Auckland",
    "Europe/London", "Europe/Paris", "America/New_York", "America/Chicago",
    "America/Denver", "America/Los_Angeles", "UTC",
  ];
}

const offsetOf = (tz) => {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" }).formatToParts(new Date());
    return parts.find((p) => p.type === "timeZoneName")?.value || "";
  } catch {
    return "";
  }
};

// A small menu hung off the header clock. Deliberately not a page in
// Administration: this is one person's view of one readout, not a company
// setting, and burying it would mean nobody finds it.
export default function ClockZonePicker({ companyZone, pref, onChange, onClose }) {
  const box = useRef(null);
  const [query, setQuery] = useState("");
  const device = deviceZone();

  useEffect(() => {
    const away = (e) => {
      if (box.current && !box.current.contains(e.target)) onClose();
    };
    const esc = (e) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [onClose]);

  const zones = allZones();
  const q = query.trim().toLowerCase();
  const matches = q ? zones.filter((z) => z.toLowerCase().includes(q)).slice(0, 40) : [];

  const pick = (value) => {
    onChange(value);
    onClose();
  };

  const Row = ({ value, label, note, active }) => (
    <button type="button" className={`zone-row${active ? " zone-row-active" : ""}`} onClick={() => pick(value)}>
      <span className="zone-row-label">{label}</span>
      {note && <span className="zone-row-note">{note}</span>}
    </button>
  );

  return (
    <div className="zone-menu" ref={box} role="dialog" aria-label="Clock timezone">
      <div className="zone-menu-head">Show the clock in</div>

      <Row
        value="company"
        label="Company time"
        note={`${companyZone} · ${offsetOf(companyZone)}`}
        active={pref === "company"}
      />
      {device && device !== companyZone && (
        <Row
          value="device"
          label="This device"
          note={`${device} · ${offsetOf(device)}`}
          active={pref === "device"}
        />
      )}
      {device && device === companyZone && (
        <div className="zone-note">This device is already on company time.</div>
      )}

      <div className="zone-menu-head" style={{ marginTop: 10 }}>Or pick a zone</div>
      <input
        type="text"
        className="zone-search"
        placeholder="Search — Dubai, Tokyo, London…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoFocus
      />
      {q && matches.length === 0 && <div className="zone-note">No zone matches that.</div>}
      <div className="zone-list">
        {matches.map((z) => (
          <Row key={z} value={z} label={z.replace(/_/g, " ")} note={offsetOf(z)} active={pref === z} />
        ))}
      </div>

      {/* The one thing someone changing this needs to know. Attendance is
          stamped server-side in company time, so a clock-in late at night in
          a zone ahead of the company can land on the company's next day. */}
      <div className="zone-warn">
        Changes what you see here only. Attendance, payroll and reports stay on company time
        ({companyZone}), because that is how the server records them.
      </div>
    </div>
  );
}
