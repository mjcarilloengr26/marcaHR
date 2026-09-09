import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";

// Customers are chosen from the register, never typed. Typing produced the
// same company several times over under slightly different spellings, with no
// email on any of them — and a statement can only be sent to a customer that
// resolves to a record.
//
// Adding one is deliberately not possible from here. A customer carries
// billing terms, a TIN and an address that belong on the customer sheet, and a
// half-filled record created in passing from an order form is exactly what
// this replaces.
export default function CustomerPicker({ value, onChange, disabled, required = true, label = "Customer" }) {
  const [customers, setCustomers] = useState([]);
  const [failed, setFailed] = useState(false);
  // Without this, the moment before the list arrives looks exactly like an
  // empty register, and the picker tells people to go and add a customer they
  // already have.
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    api
      .get("/customers/options")
      .then(setCustomers)
      .catch(() => setFailed(true))
      .finally(() => setLoaded(true));
  }, []);

  // An inactive customer on an existing record must still show, or editing
  // anything else on that record would silently repoint it.
  const missing = value && customers.length > 0 && !customers.some((c) => String(c.id) === String(value));

  return (
    <div className="form-row">
      <label>{label}</label>
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled || !loaded}
        required={required}
      >
        <option value="">{loaded ? "Select a customer…" : "Loading customers…"}</option>
        {missing && <option value={value}>(the customer on this record — no longer active)</option>}
        {customers.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
            {c.email ? "" : "  · no email"}
          </option>
        ))}
      </select>
      <span className="subtitle" style={{ fontSize: 12, display: "block" }}>
        {!loaded ? (
          "Loading…"
        ) : failed ? (
          "Could not load the customer list."
        ) : customers.length === 0 ? (
          <>
            No customers yet — add one on the <Link to="/customers">Customers</Link> page first.
          </>
        ) : (
          <>
            Not listed? Add them on the <Link to="/customers">Customers</Link> page first.
          </>
        )}
      </span>
    </div>
  );
}
