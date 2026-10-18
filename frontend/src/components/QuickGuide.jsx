import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { GUIDES, guideById, guidesFor, stepsFor } from "../config/guides";

// The quick guide: dims the page, rings the real button and points a hand at
// it, with a short card saying what it is for.
//
// It points at what is already on screen instead of describing it in a help
// page, because somebody opening this portal for the first time is looking at
// the sign-in form, not at a manual. Written for the people this is actually
// for — staff who were handed a URL and a password — so every tour is six
// steps or fewer and nothing refers to a screen they cannot open.
//
// Nothing is shown until somebody is signed in. The first version of this
// opened on the login page and walked through the form, which told whoever
// had the URL what the portal contains and which page each role lands on —
// help for the one person who does not need it yet, and a description of the
// inside of the building handed to everyone at the door.
//
// So: one tour runs by itself, once per browser, on the first page after
// signing in. It is replayable from the button in the corner, because a guide
// you cannot get back is one people sit through warily instead of closing.

// Per guide, per browser. Bumping the suffix re-runs it for everyone, which is
// what a redesign needs.
const seenKey = (id) => `marca.guide.${id}.v1`;

const hasSeen = (id) => {
  try {
    return localStorage.getItem(seenKey(id)) === "1";
  } catch {
    // Private window, or storage blocked: the guide simply offers itself again.
    return false;
  }
};
const remember = (id) => {
  try {
    localStorage.setItem(seenKey(id), "1");
  } catch {
    /* nothing to remember it with; the corner button is still there */
  }
};

export default function QuickGuide() {
  const { user } = useAuth();
  const location = useLocation();
  const [openId, setOpenId] = useState(null);
  const [index, setIndex] = useState(0);

  const role = user?.role;

  const start = useCallback((id) => {
    setIndex(0);
    setOpenId(id);
  }, []);
  const close = useCallback(() => {
    setOpenId((id) => {
      if (id) remember(id);
      return null;
    });
  }, []);

  // Only on the page somebody lands on after signing in — the Overview, or the
  // Snapshot for an admin — so it never interrupts work already under way.
  const landed = location.pathname === "/" || location.pathname === "/snapshot";
  const auto = user && landed ? "tour" : null;

  useEffect(() => {
    if (!auto || hasSeen(auto)) return;
    // Let the page finish laying out, or the hand has nothing to point at.
    const t = setTimeout(() => setOpenId((open) => open ?? auto), 900);
    return () => clearTimeout(t);
  }, [auto]);

  // Close it the moment the session ends — an idle logout can land mid-tour,
  // and a card describing the portal has no business sitting over the sign-in
  // form. What has been seen is remembered per browser, so signing back in
  // does not replay it.
  useEffect(() => {
    if (!user) setOpenId(null);
  }, [user]);

  const guide = openId ? guideById(openId) : null;
  const steps = stepsFor(guide, role);

  // The whole thing, launcher included, exists only for somebody signed in.
  if (!user) return null;

  return (
    <>
      {!guide && (
        <button
          type="button"
          className="guide-fab"
          onClick={() => start("tour")}
          title="A quick walk through this portal"
        >
          <span aria-hidden="true">👋</span> Quick guide
        </button>
      )}
      {guide && steps.length > 0 && (
        <GuideOverlay
          key={`${guide.id}-${index}`}
          guide={guide}
          steps={steps}
          index={Math.min(index, steps.length - 1)}
          role={role}
          onIndex={setIndex}
          onStart={start}
          onClose={close}
        />
      )}
    </>
  );
}

function GuideOverlay({ guide, steps, index, role, onIndex, onStart, onClose }) {
  const navigate = useNavigate();
  const location = useLocation();
  const step = steps[index];
  const last = index === steps.length - 1;
  const [rect, setRect] = useState(null);

  // Open the step's page first: the target cannot be found until it is there.
  useEffect(() => {
    if (step.route && location.pathname !== step.route) navigate(step.route);
  }, [step.route, location.pathname, navigate]);

  // Follow the target. It moves when the page scrolls or reflows, and on a
  // step that has just navigated it does not exist yet — so this polls rather
  // than listening for scroll and resize, which would miss the arrival.
  useEffect(() => {
    setRect(null);
    if (!step.target) return;
    let scrolled = false;
    const find = () => {
      const el = document.querySelector(step.target);
      if (!el) return;
      if (!scrolled) {
        scrolled = true;
        el.scrollIntoView({ block: "center", behavior: "smooth" });
      }
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) return;
      setRect((prev) =>
        prev && prev.x === r.x && prev.y === r.y && prev.w === r.width && prev.h === r.height
          ? prev
          : { x: r.x, y: r.y, w: r.width, h: r.height }
      );
    };
    find();
    const timer = setInterval(find, 300);
    return () => clearInterval(timer);
  }, [step.target, location.pathname]);

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const pad = 6;
  const visible = rect && rect.y + rect.h > 0 && rect.y < window.innerHeight;
  const hole = visible ? { x: rect.x - pad, y: rect.y - pad, w: rect.w + pad * 2, h: rect.h + pad * 2 } : null;
  // The hand sits below what it points at, unless that is low on the screen.
  const handBelow = hole ? hole.y + hole.h / 2 < window.innerHeight * 0.6 : true;
  const missing = Boolean(step.target && !rect);

  const vars = hole
    ? { "--hole-x": `${hole.x}px`, "--hole-y": `${hole.y}px`, "--hole-w": `${hole.w}px`, "--hole-h": `${hole.h}px` }
    : undefined;

  return (
    <div className="guide-layer" style={vars} role="dialog" aria-modal="true" aria-label="Quick guide">
      {hole ? (
        <>
          {/* Four panels around it rather than one overlay with a hole cut in
              it: the ringed button stays clickable, so a step can say "press
              this" and mean it. */}
          <div className="guide-shade guide-shade-top" />
          <div className="guide-shade guide-shade-bottom" />
          <div className="guide-shade guide-shade-left" />
          <div className="guide-shade guide-shade-right" />
          <div className="guide-ring" />
          <div className={`guide-hand${handBelow ? "" : " guide-hand-above"}`} aria-hidden="true">
            {handBelow ? "👆" : "👇"}
          </div>
        </>
      ) : (
        <div className="guide-shade guide-shade-all" />
      )}

      <div className={`guide-card${hole ? (handBelow ? " guide-card-below" : " guide-card-above") : " guide-card-middle"}`}>
        <div className="guide-card-head">
          <span className="subtitle" style={{ margin: 0, fontSize: 12 }}>
            Quick guide{steps.length > 1 ? ` · ${index + 1} of ${steps.length}` : ""}
          </span>
          <button type="button" className="guide-close" onClick={onClose}>
            Close guide ✕
          </button>
        </div>
        <h3 style={{ margin: 0 }}>{step.title}</h3>
        <p style={{ margin: 0 }}>{step.text}</p>
        {missing && (
          <p className="subtitle" style={{ margin: 0, fontSize: 12 }}>
            That one is not on this screen — your account may not have it.
          </p>
        )}
        {step.ask && <AskBox role={role} onStart={onStart} />}
        <div className="guide-card-foot">
          {index > 0 ? (
            <button type="button" className="btn btn-secondary" onClick={() => onIndex(index - 1)}>
              Back
            </button>
          ) : (
            <span />
          )}
          <button type="button" className="btn" onClick={() => (last ? onClose() : onIndex(index + 1))}>
            {last ? "Close guide" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}

// "Ask me anything else" — a question in plain words, answered with a tour to
// run rather than with prose. The server picks the tour; this only ever shows
// "Show me" for an id its own catalog knows, so an answer naming something
// that does not exist here cannot produce a dead button.
function AskBox({ role, onStart }) {
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const ask = async () => {
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const r = await api.post("/guide/ask", { question: q });
      const offered = r.guide_id && guideById(r.guide_id) && stepsFor(guideById(r.guide_id), role).length > 0 ? r.guide_id : null;
      setResult({ answer: r.answer, guideId: offered, ai: r.source === "ai" });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const suggestions = guidesFor(role).filter((g) => g.id !== "tour");

  return (
    <div className="guide-ask">
      <input
        ref={inputRef}
        value={question}
        maxLength={300}
        placeholder="e.g. How do I file my leave?"
        onChange={(e) => setQuestion(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            ask();
          }
        }}
        aria-label="Ask the guide"
      />
      {result ? (
        <div className="guide-answer" aria-live="polite">
          <p style={{ margin: 0 }}>
            {result.ai ? "✨ " : ""}
            {result.answer}
          </p>
          {result.guideId && (
            <button type="button" className="btn" onClick={() => onStart(result.guideId)}>
              Show me
            </button>
          )}
        </div>
      ) : error ? (
        <p className="subtitle" style={{ margin: 0, color: "var(--danger)" }}>
          {error}
        </p>
      ) : (
        <div className="guide-chips">
          {suggestions.slice(0, 4).map((g) => (
            <button key={g.id} type="button" className="guide-chip" onClick={() => onStart(g.id)}>
              {g.title}
            </button>
          ))}
        </div>
      )}
      <button type="button" className="btn btn-secondary" disabled={busy || !question.trim()} onClick={ask}>
        {busy ? "Asking…" : "Ask"}
      </button>
    </div>
  );
}

export { GUIDES };
