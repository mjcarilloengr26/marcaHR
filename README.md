# MARCA GROUP

A full-stack HRIS: employee records, departments, leave management, attendance,
payroll, performance reviews, an HR task board (Trello-style), and liquidation/expense
reports, with role-based access (admin / hr / employee).

- **Backend**: Node.js + Express + Postgres (Supabase), JWT auth
- **Frontend**: React (Vite) + React Router

## 1. Install Node.js

This machine doesn't have Node.js installed yet. Download and install the LTS
version from https://nodejs.org (v22.5 or later), then confirm it works:

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

Edit `.env` and set `JWT_SECRET` to a long random string (used to sign login tokens),
and `DATABASE_URL` to a Postgres connection string (see "Database (Supabase)" below).

## 4. Seed the database

This wipes and repopulates every table with sample departments,
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

## GPS attendance

When an employee clocks in or out, the app asks the browser for their location
(they'll see the standard browser permission prompt) and stores the coordinates
and GPS accuracy with the attendance record. HR/admin see a 📍 map link per punch
on the Attendance page.

**Locations** (admin/hr, under the "Locations" nav item) are named office sites —
each with coordinates and a radius — that employees get assigned to from their
profile page. When an employee has an assigned location, clock-in/out is
**enforced**, not just recorded: the request is rejected with a clear error if
they're outside that site's radius, or if location access wasn't granted at all.
Employees with no assigned location aren't geofenced — their punch is just
recorded with coordinates (if available) and no restriction.

- A single fallback office can also be set globally via `OFFICE_LAT` / `OFFICE_LNG`
  (and optional `OFFICE_RADIUS_METERS`, default 1000) in `backend/.env` — used only
  for employees who don't have a specific location assigned. Useful for a
  single-site company that doesn't need the Locations page at all.
- Browser geolocation requires HTTPS (or localhost), so this works on the
  deployed site and in local dev, but not over plain http on a LAN IP.

## Email notifications

The backend sends email notifications for:

- **Leave requests** — HR/admin get an email when one is submitted; the employee gets one when it's approved/rejected.
- **Expense/liquidation reports** — HR/admin get an email when one is submitted; the employee gets one when it's approved/rejected/reimbursed.
- **Task board cards** — the assigned employee gets an email when a card is assigned to them.
- **Performance reviews** — the employee gets an email when a review is submitted for their acknowledgement.

This is off by default: if `RESEND_API_KEY` in `.env` is blank, emails are skipped and just
logged to the backend console — nothing breaks. To send real emails:

1. Sign up free at https://resend.com and create an **API Key** (Sending access is enough).
2. In `backend/.env`, set:
   ```
   RESEND_API_KEY=re_your_api_key
   RESEND_FROM=notifications@marca-group.online
   ```
3. Restart the backend (`npm run dev`).

`marca-group.online` is already verified as a sending domain in Resend (DKIM/SPF/MX/DMARC
records live in Vercel DNS, since the domain's nameservers point there), so `RESEND_FROM` can
use any address on that domain — no need to fall back to the sandbox `onboarding@resend.dev`
address, which can only send to the account's own signup email. Deliverability uses Resend's
HTTPS API rather than raw SMTP because most PaaS
hosts (including Render's free/starter plans) block outbound SMTP ports entirely; the HTTPS API
goes out over port 443 like every other request this app makes.

"HR/admin" recipients are looked up dynamically from every `users` row with role `admin` or `hr`
(the accounts created via the Users page), so no extra config is needed for that part.

## Database (Supabase)

Data lives in Postgres on Supabase rather than a local file, so it survives Render
redeploys, restarts, and free-tier idle spin-down without needing a persistent disk.

1. Create a project at https://supabase.com (or use an existing one).
2. In the project's **Database Settings**, copy the **Session pooler** connection
   string (not the direct connection, which is IPv6-only and won't resolve from most
   hosts; not the transaction pooler, which doesn't suit a long-running Express server
   as well as session mode does). It looks like:
   `postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres`
3. URL-encode any special characters in the password (e.g. `@` → `%40`, `%` → `%25`).
4. Set that full string as `DATABASE_URL` in `backend/.env` (local) and in the Render
   dashboard (production).
5. The schema is created automatically on first boot (`db.migrate()` runs before the
   server starts listening) — no manual migration step needed.

## Deploying (Vercel + Render)

The frontend is a static build; the backend needs a host with a long-running Node
process (not a serverless platform like Vercel functions). The split that works:

- **Frontend → Vercel** (static hosting)
- **Backend → Render** (or Railway/Fly.io — anywhere with a long-running Node process)

### Backend on Render

1. Sign in at https://render.com and connect this GitHub repo.
2. Create a new **Web Service**, or use **Blueprint** and point it at this repo's
   `render.yaml` (already included at the repo root) to have Render configure it automatically.
3. If configuring manually: root directory `backend`, build command `npm install`,
   start command `npm start`.
4. Set environment variables in the Render dashboard: `JWT_SECRET` (a long random string),
   `DATABASE_URL` (the Supabase session pooler string from above),
   and optionally `RESEND_API_KEY`/`RESEND_FROM` for email notifications.
5. The service auto-seeds sample data on first boot if the `employees` table is empty
   (see `server.js`), so no manual seed step is needed for a fresh database. To reseed
   deliberately (wipes and repopulates every table), run `npm run seed` from Render's
   **Shell** tab.
6. Copy the service's URL (e.g. `https://marca-hr-backend.onrender.com`).

The free plan is sufficient — since data lives in Supabase, not on Render's disk, the
free tier's idle spin-down no longer risks losing anything (it just adds a cold-start
delay on the first request after a period of inactivity).

### Frontend on Vercel

1. In the Vercel project's settings, add an environment variable `VITE_API_URL` set to
   the Render backend URL from above (no trailing slash).
2. Redeploy — Vite bakes env vars in at build time, so a redeploy is required after
   changing `VITE_API_URL`.

The frontend already includes a `vercel.json` rewrite so client-side routes (e.g.
`/employees`) don't 404 on refresh, and `frontend/src/api/client.js` reads `VITE_API_URL`
to know where to send API requests (falling back to same-origin, for local dev where
Vite's proxy handles it instead).

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
      db.js               Postgres schema + connection (Supabase)
      seed.js             Sample data seeding script
      middleware/auth.js  JWT auth + role-check middleware
      routes/              One file per resource (employees, leave, payroll, ...)
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
