const express = require("express");
const { requireAuth } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");
const { answerGuideQuestion } = require("../services/guideHelp");

const router = express.Router();

// Behind the login wall, like everything else. It was briefly open, because
// the first tour ran on the sign-in page — but the catalog it answers from
// names the portal's modules, so an open endpoint would have told anybody who
// found it what this company runs and what staff can do in it.
//
// The ceiling stays even so: an answer can cost an API call, and a signed-in
// account holding Enter is as expensive as a stranger doing it. Per address,
// in memory — this runs as a single instance, and a limit that forgets itself
// on restart is the right size for the problem.
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 20;
const hits = new Map();

function overLimit(ip) {
  const now = Date.now();
  const fresh = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  fresh.push(now);
  hits.set(ip, fresh);
  // Old addresses are swept here rather than on a timer, so an idle server
  // holds nothing and there is no interval to leak.
  if (hits.size > 500) {
    for (const [key, times] of hits) if (!times.some((t) => now - t < WINDOW_MS)) hits.delete(key);
  }
  return fresh.length > MAX_PER_WINDOW;
}

router.post(
  "/ask",
  requireAuth,
  asyncHandler(async (req, res) => {
    const question = String(req.body?.question ?? "").trim().slice(0, 300);
    if (!question) return res.status(400).json({ error: "Type what you are trying to do" });
    if (overLimit(req.ip)) {
      return res.status(429).json({ error: "That is a lot of questions at once. Try again in a few minutes." });
    }
    res.json(await answerGuideQuestion(question));
  })
);

module.exports = router;
