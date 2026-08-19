const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const db = require("./db");
const seed = require("./seed");

// What a usable installation needs that the migrations don't already create.
// Migrations handle every settings row and the leave types; the task board is
// the one place left that needs starting content, because a board with no
// columns has nowhere to put a card.
const BOARD_COLUMNS = [
  ["To Do", 0],
  ["In Progress", 1],
  ["Done", 2],
];

// Long, unambiguous, and printed once. Excludes characters that get misread
// when someone copies a password off a terminal by eye.
function generatePassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  return Array.from(crypto.randomFillSync(new Uint32Array(20)))
    .map((n) => alphabet[n % alphabet.length])
    .join("");
}

function banner(lines) {
  const width = Math.max(...lines.map((l) => l.length)) + 4;
  console.log("\n" + "=".repeat(width));
  lines.forEach((l) => console.log("  " + l));
  console.log("=".repeat(width) + "\n");
}

// The demo data exists to show the system working — sample staff, sales,
// expenses — and it ships with published passwords. That is fine for a
// demonstration and unacceptable on a system holding real payroll, so it is
// opt-in rather than automatic. A customer installation that sets nothing
// gets one administrator and nothing else.
async function firstRunSetup() {
  // Keyed on users, not employees. Keying on employees meant a real
  // installation that had created an admin but no employee record looked
  // empty on the next boot and got seeded all over again.
  const { c: userCount } = await db.prepare("SELECT COUNT(*) AS c FROM users").get();
  if (userCount > 0) return;

  if (String(process.env.SEED_DEMO_DATA).toLowerCase() === "true") {
    banner([
      "SEEDING DEMONSTRATION DATA",
      "",
      "SEED_DEMO_DATA is enabled, so this database is being filled with",
      "sample employees, sales records and expense reports — including",
      "accounts whose passwords are published in the documentation.",
      "",
      "Never leave this enabled on a system holding real data.",
    ]);
    await seed();
    return;
  }

  const email = (process.env.SETUP_ADMIN_EMAIL || "admin@example.com").toLowerCase().trim();
  const supplied = process.env.SETUP_ADMIN_PASSWORD;
  const password = supplied || generatePassword();

  await db.transaction(async () => {
    await db
      .prepare("INSERT INTO users (email, password_hash, role) VALUES (?, ?, 'admin')")
      .run(email, bcrypt.hashSync(password, 10));

    for (const [name, position] of BOARD_COLUMNS) {
      await db.prepare("INSERT INTO board_columns (name, position) VALUES (?, ?)").run(name, position);
    }
  })();

  if (supplied) {
    banner([
      "ADMINISTRATOR CREATED",
      "",
      `Sign in as:  ${email}`,
      "Password:    the value of SETUP_ADMIN_PASSWORD",
    ]);
  } else {
    banner([
      "ADMINISTRATOR CREATED — COPY THIS PASSWORD NOW",
      "",
      `Sign in as:  ${email}`,
      `Password:    ${password}`,
      "",
      "This is shown once and is not stored anywhere in readable form.",
      "Change it after signing in, or set SETUP_ADMIN_PASSWORD before",
      "first boot to choose your own.",
    ]);
  }
}

module.exports = { firstRunSetup, generatePassword, BOARD_COLUMNS };
