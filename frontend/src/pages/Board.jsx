import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";

export default function Board() {
  const { user } = useAuth();
  const isHr = user.role === "admin" || user.role === "hr";
  const [columns, setColumns] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [error, setError] = useState("");
  const [dragCard, setDragCard] = useState(null); // { id, fromColumnId }
  const [showCardForm, setShowCardForm] = useState(null); // columnId or null
  const [showColumnForm, setShowColumnForm] = useState(false);
  const [cardForm, setCardForm] = useState({ title: "", description: "", employee_id: "", due_date: "" });
  const [columnName, setColumnName] = useState("");
  const [saving, setSaving] = useState(false);

  const load = () => api.get("/board").then(setColumns).catch((err) => setError(err.message));

  useEffect(() => {
    load();
    if (isHr) api.get("/employees").then(setEmployees).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleDragStart = (card) => (e) => {
    setDragCard({ id: card.id, fromColumnId: card.column_id });
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDropOnCard = (targetCard) => async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!dragCard || dragCard.id === targetCard.id) return;
    try {
      await api.put(`/board/cards/${dragCard.id}/move`, {
        column_id: targetCard.column_id,
        position: targetCard.position,
      });
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setDragCard(null);
    }
  };

  const handleDropOnColumn = (column) => async (e) => {
    e.preventDefault();
    if (!dragCard) return;
    const nextPosition = column.cards.length;
    try {
      await api.put(`/board/cards/${dragCard.id}/move`, { column_id: column.id, position: nextPosition });
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setDragCard(null);
    }
  };

  // Mobile touch browsers don't fire native HTML5 drag events at all, so
  // dragging cards between columns silently does nothing there — this select
  // is a tap-only alternative that works everywhere drag-and-drop doesn't.
  const moveCardTo = async (card, columnId) => {
    const targetColumn = columns.find((c) => c.id === Number(columnId));
    if (!targetColumn) return;
    try {
      await api.put(`/board/cards/${card.id}/move`, { column_id: targetColumn.id, position: targetColumn.cards.length });
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const addCard = async (e, columnId) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      await api.post("/board/cards", { ...cardForm, column_id: columnId, employee_id: cardForm.employee_id || null });
      setShowCardForm(null);
      setCardForm({ title: "", description: "", employee_id: "", due_date: "" });
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const deleteCard = async (id) => {
    try {
      await api.del(`/board/cards/${id}`);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const addColumn = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      await api.post("/board/columns", { name: columnName });
      setShowColumnForm(false);
      setColumnName("");
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const deleteColumn = async (id) => {
    if (!confirm("Delete this column and all its cards?")) return;
    try {
      await api.del(`/board/columns/${id}`);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>HR Task Board</h1>
          <p className="subtitle">
            {isHr ? "Drag cards between columns to update their status" : "Track your assigned tasks"}
          </p>
        </div>
        {isHr && (
          <button className="btn btn-secondary" onClick={() => setShowColumnForm(true)}>
            + Add column
          </button>
        )}
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="board">
        {columns.map((column) => (
          <div
            key={column.id}
            className="board-column"
            onDragOver={isHr ? (e) => e.preventDefault() : undefined}
            onDrop={isHr ? handleDropOnColumn(column) : undefined}
          >
            <div className="board-column-header">
              <h2>{column.name}</h2>
              <span className="board-count">{column.cards.length}</span>
              {isHr && (
                <button className="link-btn board-column-delete" onClick={() => deleteColumn(column.id)}>
                  ×
                </button>
              )}
            </div>

            {column.cards.map((card) => (
              <div
                key={card.id}
                className="board-card"
                draggable={isHr}
                onDragStart={isHr ? handleDragStart(card) : undefined}
                onDragOver={isHr ? (e) => e.preventDefault() : undefined}
                onDrop={isHr ? handleDropOnCard(card) : undefined}
              >
                <div className="board-card-title">{card.title}</div>
                {card.description && <div className="board-card-desc">{card.description}</div>}
                <div className="board-card-meta">
                  {card.employee_name && <span>{card.employee_name}</span>}
                  {card.due_date && <span>Due {card.due_date}</span>}
                </div>
                <div className="board-card-actions">
                  {isHr && (
                    <select
                      className="board-card-move"
                      value=""
                      onChange={(e) => e.target.value && moveCardTo(card, e.target.value)}
                      aria-label={`Move "${card.title}" to another column`}
                    >
                      <option value="">Move to…</option>
                      {columns
                        .filter((c) => c.id !== card.column_id)
                        .map((c) => (
                          <option key={c.id} value={c.id}>{c.name}</option>
                        ))}
                    </select>
                  )}
                  <button className="link-btn board-card-delete" onClick={() => deleteCard(card.id)}>
                    Remove
                  </button>
                </div>
              </div>
            ))}

            {showCardForm === column.id ? (
              <form className="board-card-form" onSubmit={(e) => addCard(e, column.id)}>
                <input
                  placeholder="Card title"
                  value={cardForm.title}
                  onChange={(e) => setCardForm({ ...cardForm, title: e.target.value })}
                  required
                  autoFocus
                />
                <textarea
                  placeholder="Description (optional)"
                  rows={2}
                  value={cardForm.description}
                  onChange={(e) => setCardForm({ ...cardForm, description: e.target.value })}
                />
                {isHr && (
                  <select
                    value={cardForm.employee_id}
                    onChange={(e) => setCardForm({ ...cardForm, employee_id: e.target.value })}
                  >
                    <option value="">Unassigned</option>
                    {employees.map((emp) => (
                      <option key={emp.id} value={emp.id}>
                        {emp.first_name} {emp.last_name}
                      </option>
                    ))}
                  </select>
                )}
                <input
                  type="date"
                  value={cardForm.due_date}
                  onChange={(e) => setCardForm({ ...cardForm, due_date: e.target.value })}
                />
                <div className="board-card-form-actions">
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShowCardForm(null)}>
                    Cancel
                  </button>
                  <button type="submit" className="btn btn-sm" disabled={saving}>
                    {saving ? "Adding…" : "Add card"}
                  </button>
                </div>
              </form>
            ) : (
              <button className="board-add-card" onClick={() => setShowCardForm(column.id)}>
                + Add a card
              </button>
            )}
          </div>
        ))}

        {columns.length === 0 && <div className="empty-state">No columns yet.</div>}
      </div>

      {showColumnForm && (
        <div className="modal-backdrop" onClick={() => setShowColumnForm(false)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={addColumn}>
            <h2>Add column</h2>
            <div className="form-row">
              <label>Name</label>
              <input value={columnName} onChange={(e) => setColumnName(e.target.value)} required autoFocus />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setShowColumnForm(false)}>
                Cancel
              </button>
              <button type="submit" className="btn" disabled={saving}>
                {saving ? "Adding…" : "Add column"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
