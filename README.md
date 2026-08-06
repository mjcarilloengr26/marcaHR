# MARCA Group HR

A full-stack HRIS: employee records, departments, leave management, attendance,
payroll, performance reviews, an HR task board (Trello-style), and liquidation/expense
reports, with role-based access (admin / hr / employee).

- **Backend**: Node.js + Express + SQLite (`node:sqlite`, built into Node — no native build tools needed), JWT auth
- **Frontend**: React (Vite) + React Router

## 1. Install Node.js

This machine doesn't have Node.js installed yet. Download and install the LTS
version from https://nodejs.org (v22.5 or later — needed for the built-in `node:sqlite` module), then confirm it works:

```bash
node -v
npm -v
```

## 2. Install dependencies

From the `hr-app` folder, install both the backend and frontend packages:

```bash
cd backend
npm install
cd ../frontend
npm install
```

## 3. Configure the backend

```bash
cd backend
copy .env.example .env
```

Edit `.env` and set `JWT_SECRET` to a long random string (used to sign login tokens).

## 4. Seed the database

This creates `backend/data/hr.db` (SQLite file) with sample departments,
employees, leave/attendance/payroll/performance data, and login accounts:

```bash
cd backend
npm run seed
```

Sample logins created by the seed script:

| Role     | Email                        | Password      |
|----------|-------------------------------|---------------|
| Admin    | admin@example.com             | admin123      |
| HR       | hr@example.com                | hr123         |
| Employee | jamie.chen@example.com        | employee123   |
| Employee | morgan.lee@example.com        | employee123   |

## 5. Run the app

Open two terminals:

```bash
# Terminal 1 — backend (http://localhost:4000)
cd backend
npm run dev
```

```bash
# Terminal 2 — frontend (http://localhost:5173)
cd frontend
npm run dev
```

Visit http://localhost:5173 and log in with one of the sample accounts above.
The frontend dev server proxies `/api` requests to the backend, so no extra
configuration is needed.

## Email notifications

The backend sends email notifications for:

- **Leave requests** — HR/admin get an email when one is submitted; the employee gets one when it's approved/rejected.
- **Expense/liquidation reports** — HR/admin get an email when one is submitted; the employee gets one when it's approved/rejected/reimbursed.
- **Task board cards** — the assigned employee gets an email when a card is assigned to them.
- **Performance reviews** — the employee gets an email when a review is submitted for their acknowledgement.

This is off by default: if `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS` in `.env` are blank, emails are
skipped and just logged to the backend console — nothing breaks. To send real emails, fill in
those variables. For **Gmail**:

1. Turn on 2-Step Verification on the Google account: https://myaccount.google.com/security
2. Create an **App Password**: https://myaccount.google.com/apppasswords (choose "Mail" as the app).
   Google gives you a 16-character password — this is what goes in `SMTP_PASS`, *not* the account's
   regular login password.
3. In `backend/.env`, set:
   ```
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_USER=youraddress@gmail.com
   SMTP_PASS=the 16-character app password
   SMTP_FROM=youraddress@gmail.com
   ```
4. Restart the backend (`npm run dev`).

Any other SMTP provider works the same way — just set `SMTP_HOST`/`SMTP_PORT` to that provider's values.

"HR/admin" recipients are looked up dynamically from every `users` row with role `admin` or `hr`
(the accounts created via the Users page), so no extra config is needed for that part.

## Roles

- **admin** — full access, including managing user login accounts and roles
- **hr** — manage employees, departments, leave approvals, payroll, and performance reviews
- **employee** — view/edit own profile contact info, request leave, clock in/out, view own payslips and reviews

## Project structure

```
hr-app/
  backend/
    src/
      server.js          Express app entry point
      db.js               SQLite schema + connection
      seed.js             Sample data seeding script
      middleware/auth.js  JWT auth + role-check middleware
      routes/              One file per resource (employees, leave, payroll, ...)
    data/hr.db            SQLite database file (created after seeding)
  frontend/
    src/
      pages/               One page per feature area
      components/          Layout, route guards
      context/AuthContext  Login state, current user/employee
      api/client.js        Small fetch wrapper that attaches the JWT
```

## Resetting sample data

Re-running `npm run seed` in `backend/` wipes and re-creates all tables with
fresh sample data — useful if you want to start over.
