const TOKEN_KEY = "hr_app_token";
// In local dev this is empty and Vite's proxy (vite.config.js) forwards /api to the backend.
// In production (e.g. Vercel), set VITE_API_URL to the deployed backend's origin.
const API_BASE = import.meta.env.VITE_API_URL || "";

// The session lives in sessionStorage, not localStorage: a localStorage token
// outlives the browser itself, so closing everything and reopening the app
// dropped you straight back into a live session without a password. Payroll
// and personnel records shouldn't be reachable that way on a shared or
// unattended machine. The trade-off is that each new tab starts signed out.
export function getToken() {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  if (token) sessionStorage.setItem(TOKEN_KEY, token);
  else sessionStorage.removeItem(TOKEN_KEY);
  // Clear any token left in localStorage by an earlier build, so an existing
  // browser doesn't keep resuming from it.
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

// Drop a pre-existing localStorage token at startup — without this, anyone
// already signed in under the old scheme would stay auto-signed-in forever.
try {
  localStorage.removeItem(TOKEN_KEY);
} catch {
  /* ignore */
}

async function request(path, { method = "GET", body, headers } = {}) {
  const token = getToken();
  const res = await fetch(`${API_BASE}/api${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 204) return null;

  const contentType = res.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await res.json() : await res.text();

  if (!res.ok) {
    const message = (data && data.error) || `Request failed (${res.status})`;
    throw new Error(message);
  }
  return data;
}

export const api = {
  get: (path) => request(path),
  post: (path, body) => request(path, { method: "POST", body }),
  put: (path, body) => request(path, { method: "PUT", body }),
  del: (path) => request(path, { method: "DELETE" }),
};

// For file downloads (e.g. Excel export) — the JSON-only `request` helper above
// can't handle a binary response, and the browser needs a real click-to-download
// flow rather than just the fetched bytes.
export async function downloadFile(path, fallbackFilename) {
  const token = getToken();
  const res = await fetch(`${API_BASE}/api${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    const contentType = res.headers.get("content-type") || "";
    const data = contentType.includes("application/json") ? await res.json() : null;
    throw new Error((data && data.error) || `Download failed (${res.status})`);
  }
  const disposition = res.headers.get("content-disposition") || "";
  const match = disposition.match(/filename="?([^"]+)"?/);
  const filename = match ? match[1] : fallbackFilename;

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
