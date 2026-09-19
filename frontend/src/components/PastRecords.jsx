import { useState } from "react";

// A card for records that are finished with — paid payroll, settled advances,
// reimbursed expense reports.
//
// They used to sit in the same list as the live ones, which is how a payroll
// run that had already been paid was edited and paid a second time: the row
// looked no different from the ones still waiting, and the only thing marking
// it was a badge at the far end of a wide table. Moving them behind a
// disclosure costs one click to reach the history and takes the whole class of
// mistake out of the list people work in all day.
//
// Closed rather than open by default, and the count is on the header so the
// archive still announces itself without being in the way. Nothing is hidden
// from search — each page filters both lists — and the heading says how many
// matched, so a search that only hits history never reads as no results.
export default function PastRecords({ title, count, hint, children }) {
  const [open, setOpen] = useState(false);

  // Nothing closed yet, so there is no archive to offer.
  if (!count) return null;

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <button
        type="button"
        className="link-btn"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          textAlign: "left",
          fontSize: 14,
        }}
      >
        <span aria-hidden="true" style={{ fontSize: 11, width: 10 }}>{open ? "▼" : "▶"}</span>
        <strong>{title}</strong>
        <span className="badge badge-draft">{count}</span>
      </button>
      {hint && !open && (
        <p className="subtitle" style={{ margin: "6px 0 0", fontSize: 12, paddingLeft: 18 }}>{hint}</p>
      )}
      {/* Built only once opened: a function child keeps a few hundred archived
          rows from being mapped on every render of the live list. */}
      {open && <div style={{ marginTop: 12 }}>{typeof children === "function" ? children() : children}</div>}
    </div>
  );
}
