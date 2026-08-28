import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";

export default function Performance() {
  const { user } = useAuth();
  const isHr = user.role === "admin" || user.role === "hr";
  const [reviews, setReviews] = useState([]);
  const [cycles, setCycles] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [error, setError] = useState("");
  const [showCycleForm, setShowCycleForm] = useState(false);
  const [showReviewForm, setShowReviewForm] = useState(false);
  const [cycleForm, setCycleForm] = useState({ name: "", start_date: "", end_date: "" });
  const [editingCycleId, setEditingCycleId] = useState(null);
  const [reviewForm, setReviewForm] = useState({
    cycle_id: "",
    employee_id: "",
    rating: 3,
    goals: "",
    strengths: "",
    improvements: "",
    comments: "",
  });
  const [saving, setSaving] = useState(false);

  const loadReviews = () => api.get("/performance/reviews").then(setReviews).catch((err) => setError(err.message));

  useEffect(() => {
    loadReviews();
    api.get("/performance/cycles").then(setCycles).catch(() => {});
    if (isHr) api.get("/employees").then(setEmployees).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadCycles = () => api.get("/performance/cycles").then(setCycles).catch(() => {});

  const openNewCycle = () => {
    setEditingCycleId(null);
    setCycleForm({ name: "", start_date: "", end_date: "" });
    setShowCycleForm(true);
  };

  const openEditCycle = (c) => {
    setEditingCycleId(c.id);
    setCycleForm({ name: c.name, start_date: c.start_date || "", end_date: c.end_date || "" });
    setShowCycleForm(true);
  };

  const setCycleStatus = async (c, status) => {
    setError("");
    try {
      await api.put(`/performance/cycles/${c.id}`, { status });
      loadCycles();
    } catch (err) {
      setError(err.message);
    }
  };

  const deleteCycle = async (c) => {
    if (!confirm(`Delete the review cycle "${c.name}"?

This cannot be undone. A cycle that already has reviews against it cannot be deleted — close it instead.`)) return;
    setError("");
    try {
      await api.del(`/performance/cycles/${c.id}`);
      loadCycles();
    } catch (err) {
      setError(err.message);
    }
  };

  const addCycle = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      if (editingCycleId) {
        await api.put(`/performance/cycles/${editingCycleId}`, cycleForm);
      } else {
        await api.post("/performance/cycles", cycleForm);
      }
      setShowCycleForm(false);
      setEditingCycleId(null);
      setCycleForm({ name: "", start_date: "", end_date: "" });
      loadCycles();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const addReview = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      await api.post("/performance/reviews", { ...reviewForm, rating: Number(reviewForm.rating) });
      setShowReviewForm(false);
      setReviewForm({ cycle_id: "", employee_id: "", rating: 3, goals: "", strengths: "", improvements: "", comments: "" });
      loadReviews();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const submitReview = async (id) => {
    try {
      await api.put(`/performance/reviews/${id}/status`, { status: "submitted" });
      loadReviews();
    } catch (err) {
      setError(err.message);
    }
  };

  const acknowledgeReview = async (id) => {
    try {
      await api.put(`/performance/reviews/${id}/status`, { status: "acknowledged" });
      loadReviews();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Performance</h1>
          <p className="subtitle">{isHr ? "Manage review cycles and evaluations" : "Your performance reviews"}</p>
        </div>
        {isHr && (
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-secondary" onClick={openNewCycle}>+ Review cycle</button>
            <button className="btn" onClick={() => setShowReviewForm(true)}>+ New review</button>
          </div>
        )}
      </div>

      {error && <div className="error-banner">{error}</div>}

      {/* Cycles were creatable but never shown anywhere except the New review
          dropdown, so creating one looked like it had done nothing at all. */}
      {isHr && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h2 style={{ marginTop: 0 }}>Review cycles</h2>
          <table className="sticky-head">
            <thead>
              <tr>
                <th>Cycle</th>
                <th>Starts</th>
                <th>Ends</th>
                <th>Reviews</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {cycles.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td>{c.start_date || "—"}</td>
                  <td>{c.end_date || "—"}</td>
                  <td>{reviews.filter((r) => r.cycle_id === c.id).length}</td>
                  <td><span className={`badge badge-${c.status === "open" ? "active" : "neutral"}`}>{c.status}</span></td>
                  <td>
                    <div className="col-actions">
                      <button className="btn btn-sm btn-secondary" onClick={() => openEditCycle(c)}>Edit</button>
                      {c.status === "open" ? (
                        <button className="btn btn-sm btn-secondary" onClick={() => setCycleStatus(c, "closed")}>Close</button>
                      ) : (
                        <button className="btn btn-sm btn-secondary" onClick={() => setCycleStatus(c, "open")}>Reopen</button>
                      )}
                      <button className="btn btn-sm btn-danger" onClick={() => deleteCycle(c)}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {cycles.length === 0 && <div className="empty-state">No review cycles yet — create one to start scheduling reviews.</div>}
        </div>
      )}

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Reviews</h2>
        <table className="sticky-head">
          <thead>
            <tr>
              {isHr && <th>Employee</th>}
              <th>Cycle</th>
              <th>Reviewer</th>
              <th>Rating</th>
              <th>Comments</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {reviews.map((r) => (
              <tr key={r.id}>
                {isHr && <td>{r.employee_name}</td>}
                <td>{r.cycle_name}</td>
                <td>{r.reviewer_name || "—"}</td>
                <td>{r.rating ? `${r.rating}/5` : "—"}</td>
                <td>{r.comments || "—"}</td>
                <td><span className={`badge badge-${r.status}`}>{r.status}</span></td>
                <td>
                  {isHr && r.status === "draft" && (
                    <button className="btn btn-sm" onClick={() => submitReview(r.id)}>Submit</button>
                  )}
                  {!isHr && r.status === "submitted" && r.employee_id === user.employee_id && (
                    <button className="btn btn-sm" onClick={() => acknowledgeReview(r.id)}>Acknowledge</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {reviews.length === 0 && <div className="empty-state">No reviews yet.</div>}
      </div>

      {showCycleForm && (
        <div className="modal-backdrop" onClick={() => { setShowCycleForm(false); setEditingCycleId(null); }}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={addCycle}>
            <h2>{editingCycleId ? "Edit review cycle" : "New review cycle"}</h2>
            <div className="form-row">
              <label>Name</label>
              <input value={cycleForm.name} onChange={(e) => setCycleForm({ ...cycleForm, name: e.target.value })} required />
            </div>
            <div className="grid grid-2">
              <div className="form-row">
                <label>Start date</label>
                <input type="date" value={cycleForm.start_date} onChange={(e) => setCycleForm({ ...cycleForm, start_date: e.target.value })} />
              </div>
              <div className="form-row">
                <label>End date</label>
                <input type="date" value={cycleForm.end_date} onChange={(e) => setCycleForm({ ...cycleForm, end_date: e.target.value })} />
              </div>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => { setShowCycleForm(false); setEditingCycleId(null); }}>Cancel</button>
              <button type="submit" className="btn" disabled={saving}>{saving ? "Saving…" : editingCycleId ? "Save changes" : "Create cycle"}</button>
            </div>
          </form>
        </div>
      )}

      {showReviewForm && (
        <div className="modal-backdrop" onClick={() => setShowReviewForm(false)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={addReview}>
            <h2>New review</h2>
            <div className="grid grid-2">
              <div className="form-row">
                <label>Employee</label>
                <select value={reviewForm.employee_id} onChange={(e) => setReviewForm({ ...reviewForm, employee_id: e.target.value })} required>
                  <option value="">Select employee</option>
                  {employees.map((e) => (
                    <option key={e.id} value={e.id}>{e.first_name} {e.last_name}</option>
                  ))}
                </select>
              </div>
              <div className="form-row">
                <label>Cycle</label>
                <select value={reviewForm.cycle_id} onChange={(e) => setReviewForm({ ...reviewForm, cycle_id: e.target.value })} required>
                  <option value="">Select cycle</option>
                  {cycles.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="form-row">
              <label>Rating (1-5)</label>
              <input type="number" min="1" max="5" value={reviewForm.rating} onChange={(e) => setReviewForm({ ...reviewForm, rating: e.target.value })} />
            </div>
            <div className="form-row">
              <label>Goals</label>
              <textarea rows={2} value={reviewForm.goals} onChange={(e) => setReviewForm({ ...reviewForm, goals: e.target.value })} />
            </div>
            <div className="form-row">
              <label>Strengths</label>
              <textarea rows={2} value={reviewForm.strengths} onChange={(e) => setReviewForm({ ...reviewForm, strengths: e.target.value })} />
            </div>
            <div className="form-row">
              <label>Areas for improvement</label>
              <textarea rows={2} value={reviewForm.improvements} onChange={(e) => setReviewForm({ ...reviewForm, improvements: e.target.value })} />
            </div>
            <div className="form-row">
              <label>Comments</label>
              <textarea rows={2} value={reviewForm.comments} onChange={(e) => setReviewForm({ ...reviewForm, comments: e.target.value })} />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setShowReviewForm(false)}>Cancel</button>
              <button type="submit" className="btn" disabled={saving}>{saving ? "Saving…" : "Save review"}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
