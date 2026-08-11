import { useEffect, useRef } from "react";

const ACTIVITY_EVENTS = ["mousedown", "mousemove", "keydown", "scroll", "touchstart", "wheel"];

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

    const reset = () => {
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
