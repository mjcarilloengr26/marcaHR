import { useEffect, useRef, useState } from "react";

// A number field that can actually be typed into.
//
// `<input type="number">` looks like the right tool and is not. While a decimal
// point is being typed the field's contents are momentarily invalid — "1234."
// is not a number — and the browser reports `.value` as an empty string for the
// whole of that moment. A controlled React input writes that empty string
// straight back, so the keystroke wipes the field: typing "1234.56" leaves "56".
// `step="0.01"` does not help; it governs validation and the spinner, not what
// `.value` returns mid-edit.
//
// So the field is a text input that only accepts number-shaped text, with the
// raw keystrokes held here and a parsed number handed upward. inputMode gives
// phones the numeric keypad they would have got from type="number".
export default function DecimalInput({
  value,
  onChange,
  decimals = 2,
  allowNegative = false,
  ...rest
}) {
  // What the person has actually typed, including half-finished states like
  // "1234." that no number can represent.
  const [draft, setDraft] = useState(value === null || value === undefined ? "" : String(value));
  const emitted = useRef(draft);
  const node = useRef(null);

  // Follow the prop when it changes from outside — opening an edit modal, a
  // form reset, a value recalculated elsewhere — but never while the difference
  // is just this component's own last keystroke, or typing would fight itself.
  useEffect(() => {
    const incoming = value === null || value === undefined ? "" : String(value);
    if (incoming !== emitted.current) {
      setDraft(incoming);
      emitted.current = incoming;
    }
  }, [value]);

  const handle = (e) => {
    // Numeric keypads in many locales send a comma for the decimal key. Taking
    // it as a decimal point costs nothing and saves the person discovering that
    // their keyboard's period key is the only one that works.
    const raw = e.target.value.replace(",", ".");

    // Digits, at most one decimal point, and a leading minus where allowed.
    const pattern = allowNegative
      ? new RegExp(`^-?\\d*(\\.\\d{0,${decimals}})?$`)
      : new RegExp(`^\\d*(\\.\\d{0,${decimals}})?$`);

    if (raw !== "" && !pattern.test(raw)) {
      // Refuse the keystroke — but put the field back to the last good text
      // first. React will not re-render for an unchanged draft, so simply
      // returning would leave the rejected character sitting in the DOM with
      // state that disagrees. Every later keystroke would then build on text
      // that keeps failing this test, and the field would look frozen.
      if (node.current) node.current.value = draft;
      return;
    }

    setDraft(raw);
    emitted.current = raw;
    // Keep the DOM in step when the sanitised text differs from what was typed
    // (a comma became a point), since draft may be unchanged from React's view.
    if (node.current && node.current.value !== raw) node.current.value = raw;
    // Call sites already written against a plain input keep working unchanged.
    onChange({ target: { value: raw } });
  };

  // A trailing point is fine to type but not to leave behind.
  const handleBlur = (e) => {
    if (draft.endsWith(".")) {
      const tidied = draft.slice(0, -1);
      setDraft(tidied);
      emitted.current = tidied;
      onChange({ target: { value: tidied } });
    }
    if (rest.onBlur) rest.onBlur(e);
  };

  return (
    <input
      {...rest}
      ref={node}
      type="text"
      inputMode="decimal"
      value={draft}
      onChange={handle}
      onBlur={handleBlur}
    />
  );
}
