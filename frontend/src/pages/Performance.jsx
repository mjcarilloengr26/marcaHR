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

  const addCycle = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      await api.post("/performance/cycles", cycleForm);
      setShowCycleForm(false);
      setCycleForm({ name: "", start_date: "", end_date: "" });
      api.get("/performance/cycles").then(setCycles);
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
            <button className="btn btn-secondary" onClick={() => setShowCycleForm(true)}>+ Review cycle</button>
            <button className="btn" onClick={() => setShowReviewForm(true)}>+ New review</button>
          </div>
        )}
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
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
        <div className="modal-backdrop" onClick={() => setShowCycleForm(false)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={addCycle}>
            <h2>New review cycle</h2>
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
              <button type="button" className="btn btn-secondary" onClick={() => setShowCycleForm(false)}>Cancel</button>
              <button type="submit" className="btn" disabled={saving}>{saving ? "Saving…" : "Create cycle"}</button>
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
