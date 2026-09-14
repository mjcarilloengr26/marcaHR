import { useEffect, useLayoutEffect, useRef, useState } from "react";

// A money field that shows thousands separators while you type.
//
// `<input type="number">` looks like the right tool and is not. While a decimal
// point is being typed the field's contents are momentarily invalid — "1234."
// is not a number — and the browser reports `.value` as an empty string for the
// whole of that moment. A controlled React input writes that empty string
// straight back, so the keystroke wipes the field: typing "1234.56" leaves "56".
// It also refuses to hold a grouped value at all.
//
// So the field is a text input. What it displays is grouped (1,234,567.89);
// what it hands upward is the bare number (1234567.89), so every call site and
// the API keep working unchanged.
//
// The fiddly part is the caret. Inserting a comma shifts every character after
// it, and naively re-setting the value sends the caret to the end — so typing
// into the middle of a figure jumps you out of it. The caret is therefore
// tracked by counting the significant characters (digits and the decimal point)
// to its left, which separators do not disturb, and restored to the same count
// after formatting.

const group = (digits) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

// Formats a clean numeric string for display without disturbing a half-typed
// state: "1234." keeps its trailing point, and "1234.5" is not padded to two
// decimals while the second is still being typed.
function formatted(clean) {
  if (clean === "" || clean === "-") return clean;
  const neg = clean.startsWith("-");
  const body = neg ? clean.slice(1) : clean;
  const dot = body.indexOf(".");
  const intPart = dot === -1 ? body : body.slice(0, dot);
  const decPart = dot === -1 ? null : body.slice(dot + 1);
  return (neg ? "-" : "") + group(intPart) + (decPart === null ? "" : `.${decPart}`);
}

// Digits and the decimal point are what the caret is measured against; commas
// and the minus sign move around them.
const significant = (text) => (text.match(/[0-9.]/g) || []).length;

export default function DecimalInput({ value, onChange, decimals = 2, allowNegative = false, ...rest }) {
  const clean = value === null || value === undefined ? "" : String(value);
  const [draft, setDraft] = useState(formatted(clean));
  // The last bare value handed upward, so a prop echoing back our own keystroke
  // is not mistaken for an outside change.
  const emitted = useRef(clean);
  const node = useRef(null);
  const caret = useRef(null);

  // Follow the prop when it changes from outside — opening an edit modal, a
  // form reset, a value recalculated elsewhere — but never while the difference
  // is just this component's own last keystroke, or typing would fight itself.
  useEffect(() => {
    const incoming = value === null || value === undefined ? "" : String(value);
    if (incoming !== emitted.current) {
      setDraft(formatted(incoming));
      emitted.current = incoming;
    }
  }, [value]);

  // Put the caret back where the person left it, after React has written the
  // regrouped text. Must be layout-phase: doing it in an effect lets the
  // browser paint the caret at the end first, which reads as a jump.
  useLayoutEffect(() => {
    if (caret.current !== null && node.current) {
      node.current.setSelectionRange(caret.current, caret.current);
      caret.current = null;
    }
  });

  const handle = (e) => {
    const el = e.target;
    const typed = el.value;
    const at = el.selectionStart ?? typed.length;
    const sigBefore = significant(typed.slice(0, at));

    // Commas are separators, not decimal points — the app writes every amount
    // as 1,234.56. Spaces and a currency symbol go too, so pasting
    // "PHP 133,566.00" out of a spreadsheet works.
    let next = typed.replace(/[,\s₱$]/g, "").replace(/php/gi, "");
    if (!allowNegative) next = next.replace(/-/g, "");
    else next = next.replace(/(?!^)-/g, "");

    const pattern = allowNegative
      ? new RegExp(`^-?\\d*(\\.\\d{0,${decimals}})?$`)
      : new RegExp(`^\\d*(\\.\\d{0,${decimals}})?$`);

    if (next !== "" && !pattern.test(next)) {
      // Refuse the keystroke, but put the field back to the last good text
      // first: React will not re-render for an unchanged draft, so simply
      // returning would leave the rejected character sitting in the DOM with
      // state that disagrees, and every later keystroke would build on text
      // that keeps failing this test.
      el.value = draft;
      const back = Math.max(0, at - 1);
      el.setSelectionRange(back, back);
      return;
    }

    const shown = formatted(next);

    // Walk the formatted text until the same number of significant characters
    // has been passed, so the caret lands where the person was typing rather
    // than at the end.
    let pos = 0;
    let seen = 0;
    while (pos < shown.length && seen < sigBefore) {
      if (/[0-9.]/.test(shown[pos])) seen += 1;
      pos += 1;
    }
    caret.current = pos;

    setDraft(shown);
    emitted.current = next;
    // Keep the DOM in step when the regrouped text differs from what was typed,
    // since draft may be unchanged from React's point of view.
    if (el.value !== shown) el.value = shown;
    // Call sites already written against a plain input keep working unchanged:
    // what they receive is the bare number, never the grouped text.
    onChange({ target: { value: next } });
  };

  // A trailing point is fine to type but not to leave behind.
  const handleBlur = (e) => {
    if (emitted.current.endsWith(".")) {
      const tidied = emitted.current.slice(0, -1);
      emitted.current = tidied;
      setDraft(formatted(tidied));
      onChange({ target: { value: tidied } });
    }
    if (rest.onBlur) rest.onBlur(e);
  };

  return (
    <input {...rest} ref={node} type="text" inputMode="decimal" value={draft} onChange={handle} onBlur={handleBlur} />
  );
}
