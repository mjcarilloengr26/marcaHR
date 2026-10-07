#!/usr/bin/env node
// One command from "changed on disk" to "running in production".
//
// The two halves of this app deploy by different mechanisms and only one of
// them follows a push. Vercel builds from the CLI; Render's service has
// Auto-Deploy switched off, so `git push` moves GitHub and nothing else. That
// asymmetry is invisible — the push succeeds, the site updates, and the API
// quietly stays on last week's code until somebody notices a route 404ing.
// It has caught us out before, which is the whole reason this file exists.
//
//   node scripts/ship.mjs                 push what is already committed, deploy both
//   node scripts/ship.mjs -m "message"    commit everything first, then the above
//   node scripts/ship.mjs --backend-only  skip the Vercel build
//   node scripts/ship.mjs --frontend-only skip Render
//   node scripts/ship.mjs --no-wait       fire the Render hook, do not wait for it
//
// It waits for Render by polling /api/health, which reports RENDER_GIT_COMMIT —
// so "deployed" means the new commit is actually answering requests, not that a
// build was accepted.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://marca-hr-backend.onrender.com";
const HEALTH = `${API}/api/health`;
const WAIT_MINUTES = 12;

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const messageAt = argv.findIndex((a) => a === "-m" || a === "--message");
const message = messageAt >= 0 ? argv[messageAt + 1] : null;
const doBackend = !flag("--frontend-only");
const doFrontend = !flag("--backend-only");

const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
const say = (s) => process.stdout.write(`${s}\n`);
const die = (s) => {
  process.stderr.write(`\n✗ ${s}\n`);
  process.exit(1);
};

// Running a shell command where the output matters to the person watching, not
// to this script: npm and vercel both report progress, and swallowing it would
// make a four-minute build look like a hang.
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: true, cwd: ROOT, ...opts });
  if (r.status !== 0) die(`${cmd} ${args.join(" ")} failed`);
};

// ---------------------------------------------------------------- commit

if (git("status", "--porcelain")) {
  if (!message) {
    say(git("status", "--short"));
    die("The working tree has changes. Pass -m \"message\" to commit them, or commit yourself first.\n" +
        "  Nothing was pushed or deployed.");
  }
  git("add", "-A");
  git("commit", "-m", message);
  say(`✓ committed`);
}

const branch = git("rev-parse", "--abbrev-ref", "HEAD");
const commit = git("rev-parse", "--short=7", "HEAD");
say(`  ${branch} @ ${commit} — ${git("log", "-1", "--pretty=%s")}`);

// ---------------------------------------------------------------- push

git("push", "origin", branch);
say(`✓ pushed to origin/${branch}`);

// ---------------------------------------------------------------- backend

if (doBackend) {
  // The hook is a secret URL — anyone holding it can trigger a deploy — so it
  // lives in the gitignored backend/.env and is never printed, not even on the
  // failure path where printing it would be most tempting.
  const envPath = join(ROOT, "backend", ".env");
  if (!existsSync(envPath)) die(`No backend/.env, so there is no deploy hook to call.`);
  const hook = (readFileSync(envPath, "utf8").match(/^RENDER_DEPLOY_HOOK=(.+)$/m) || [])[1]?.trim();
  if (!hook) {
    die("RENDER_DEPLOY_HOOK is missing from backend/.env.\n" +
        "  Render dashboard → marca-hr-backend → Settings → Deploy Hook → copy, then add the line.");
  }

  const res = await fetch(hook, { method: "POST" });
  if (!res.ok) die(`Render refused the deploy hook (HTTP ${res.status}). The hook may have been rotated.`);
  say(`✓ Render build triggered`);

  if (!flag("--no-wait")) {
    // Polling the deployed commit rather than trusting the 202. A free-plan
    // build takes two to four minutes from cold, and a failed build also
    // returns 202 — the only honest signal is the new commit answering.
    const deadline = Date.now() + WAIT_MINUTES * 60_000;
    let live = null;
    process.stdout.write("  waiting for it to answer");
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 15_000));
      process.stdout.write(".");
      try {
        const health = await fetch(HEALTH, { signal: AbortSignal.timeout(10_000) }).then((r) => r.json());
        live = health.commit;
        if (live === commit) break;
      } catch {
        // A build restarts the instance, so refused connections during the
        // window are expected rather than a failure.
      }
    }
    process.stdout.write("\n");
    if (live !== commit) {
      die(`Render is still on ${live ?? "an unknown commit"} after ${WAIT_MINUTES} minutes.\n` +
          `  The build may have failed — check the log: https://dashboard.render.com\n` +
          `  The frontend was NOT deployed, so production is unchanged and consistent.`);
    }
    say(`✓ backend live on ${commit}`);
  }
}

// ---------------------------------------------------------------- frontend

if (doFrontend) {
  // Backend first, frontend second, and this is the reason the order is fixed:
  // the frontend calls routes the backend has to already be serving. Shipping
  // them the other way round breaks production for the length of the build.
  const frontend = join(ROOT, "frontend");
  run("npx", ["vercel", "build", "--prod", "--yes"], {
    cwd: frontend,
    env: { ...process.env, VITE_API_URL: API },
  });
  run("npx", ["vercel", "deploy", "--prebuilt", "--prod", "--yes"], { cwd: frontend });
  say(`✓ frontend deployed — https://marca-group.online`);
}

say(`\nShipped ${commit}.`);
