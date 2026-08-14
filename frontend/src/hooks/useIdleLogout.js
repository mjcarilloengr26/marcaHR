import { useEffect, useRef } from "react";

const ACTIVITY_EVENTS = ["mousedown", "mousemove", "keydown", "scroll", "touchstart", "wheel"];

// Timestamp of the last interaction, and the idle window in force when it was
// recorded. Persisted so the policy still applies across a browser restart:
// the in-page timer below only runs while a tab is open, so without this,
// closing the browser and returning hours later would land straight back in a
// live session without re-entering a password.
export const LAST_ACTIVITY_KEY = "hr_app_last_activity";
export const IDLE_MINUTES_KEY = "hr_app_idle_minutes";

export function markActivity() {
  try {
    localStorage.setItem(LAST_ACTIVITY_KEY, String(Date.now()));
  } catch {
    /* private mode — the in-page timer still applies for this session */
  }
}

// True when the stored last-activity is older than the idle window, i.e. the
// session should be treated as expired even though its token hasn't lapsed.
export function idleSessionExpired() {
  try {
    const last = Number(localStorage.getItem(LAST_ACTIVITY_KEY));
    if (!last) return false; // never recorded — don't sign anyone out on a guess
    const minutes = Number(localStorage.getItem(IDLE_MINUTES_KEY)) || 15;
    return Date.now() - last > minutes * 60 * 1000;
  } catch {
    return false;
  }
}

// Resets a single timeout on any mouse/keyboard/scroll/touch activity; fires
// onIdle() once that many minutes pass with none. Used by AuthContext to
// force a client-side logout when a workstation is left signed in and
// unattended — a data-security measure independent of the JWT's own (much
// longer) absolute expiry.
export function useIdleLogout({ enabled, minutes, onIdle }) {
  const timerRef = useRef(null);
  const onIdleRef = useRef(onIdle);
  onIdleRef.current = onIdle;

  useEffect(() => {
    if (!enabled || !minutes) return undefined;
    const timeoutMs = minutes * 60 * 1000;
    // Remember the window in force, so a cold start knows what to enforce.
    try {
      localStorage.setItem(IDLE_MINUTES_KEY, String(minutes));
    } catch { /* ignore */ }

    const reset = () => {
      markActivity();
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => onIdleRef.current(), timeoutMs);
    };

    reset();
    ACTIVITY_EVENTS.forEach((evt) => window.addEventListener(evt, reset, { passive: true }));

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      ACTIVITY_EVENTS.forEach((evt) => window.removeEventListener(evt, reset));
    };
  }, [enabled, minutes]);
}
