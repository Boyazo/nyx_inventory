/* Google Calendar sync for build shifts.
 *
 * Each member connects their own Google account (Google Identity Services, calendar.events scope).
 * Shifts they join are written to their primary calendar with a deterministic event id, so
 * re-syncing updates the same event instead of duplicating it. Leaving a shift, or an admin
 * deleting it, removes the event on the member's next sync.
 *
 * Setup: create an OAuth "Web application" client in Google Cloud Console, add the site origin
 * (e.g. https://<user>.github.io) to Authorized JavaScript origins, enable the Google Calendar API,
 * and paste the client id below. Until then members get one-click "Add to Google Calendar" links.
 */
export const GOOGLE_CLIENT_ID = "660009158487-nobnqsqsapa5vp2pfsa921gqlgi4m7d8.apps.googleusercontent.com";

const TEAM_TIMEZONE = "America/Los_Angeles";
const SCOPE = "https://www.googleapis.com/auth/calendar.events";
const API = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const STORE_KEY = "nyx_gcal_sync";

let tokenClient = null;
let accessToken = null;
let tokenExpiresAt = 0;

function loadState() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || { connected: false, synced: {} }; }
  catch { return { connected: false, synced: {} }; }
}
function saveState(state) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* storage unavailable */ }
}

export function isConfigured() { return Boolean(GOOGLE_CLIENT_ID); }
export function isConnected() { return isConfigured() && loadState().connected; }
function hasToken() { return accessToken && Date.now() < tokenExpiresAt - 60_000; }

/* Google event ids must be base32hex (0-9, a-v), 5-1024 chars */
function eventId(shiftId) { return "shift" + String(shiftId).replace(/-/g, "").toLowerCase(); }

function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error("Could not load Google sign-in"));
    document.head.appendChild(s);
  });
}

/* Must be called from a click handler: Google opens a popup for consent / token refresh */
export async function requestToken() {
  if (!isConfigured()) throw new Error("Google Calendar sync is not configured");
  if (hasToken()) return accessToken;
  await loadGis();
  return new Promise((resolve, reject) => {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: SCOPE,
      callback: resp => {
        if (resp.error) return reject(new Error(resp.error_description || resp.error));
        accessToken = resp.access_token;
        tokenExpiresAt = Date.now() + Number(resp.expires_in || 3600) * 1000;
        const state = loadState();
        state.connected = true;
        saveState(state);
        resolve(accessToken);
      },
      error_callback: err => reject(new Error(err?.message || "Google sign-in was closed"))
    });
    tokenClient.requestAccessToken({ prompt: loadState().connected ? "" : "consent" });
  });
}

export function disconnect() {
  if (accessToken) window.google?.accounts?.oauth2?.revoke(accessToken, () => {});
  accessToken = null;
  tokenExpiresAt = 0;
  saveState({ connected: false, synced: {} });
}

function eventBody(shift) {
  const notes = (shift.notes || "").replace("[🔁 Weekly Shift]", "").trim();
  return {
    summary: `NYX Build Shift: ${shift.title}`,
    location: shift.location || "Main Shop",
    description: [`${shift.department} shift`, notes, "Synced from the NYX 11744 team workspace."].filter(Boolean).join("\n\n"),
    start: { dateTime: `${shift.shift_date}T${shift.start_time.slice(0, 5)}:00`, timeZone: TEAM_TIMEZONE },
    end: { dateTime: `${shift.shift_date}T${shift.end_time.slice(0, 5)}:00`, timeZone: TEAM_TIMEZONE },
    reminders: { useDefault: true },
    source: { title: "NYX 11744 Workspace", url: location.origin + location.pathname }
  };
}

function fingerprint(shift) {
  return [shift.title, shift.shift_date, shift.start_time, shift.end_time, shift.location, shift.department, shift.notes].join("|");
}

async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 401) { accessToken = null; throw new Error("Google session expired"); }
  return res;
}

async function upsertEvent(shift) {
  const id = eventId(shift.id);
  const body = eventBody(shift);
  let res = await api("PUT", `/${id}`, body);
  if (res.status === 404) res = await api("POST", "", { ...body, id });
  // 409 = id exists but was deleted by the user in Google; restore it by updating
  if (res.status === 409) res = await api("PUT", `/${id}`, { ...body, status: "confirmed" });
  if (!res.ok) throw new Error(`Calendar update failed (${res.status})`);
}

async function deleteEvent(shiftId) {
  const res = await api("DELETE", `/${eventId(shiftId)}`);
  if (!res.ok && res.status !== 404 && res.status !== 410) throw new Error(`Calendar delete failed (${res.status})`);
}

/* Reconcile the member's calendar with the shifts they are signed up for.
 * Only runs when a live token exists (after a click), so it never pops up on page load. */
export async function syncShifts(shifts, myName) {
  if (!isConnected() || !hasToken()) return { skipped: true };
  const state = loadState();
  const mine = shifts.filter(s => Array.isArray(s.attendees) && s.attendees.includes(myName));
  const mineIds = new Set(mine.map(s => s.id));
  let added = 0, removed = 0;

  for (const shift of mine) {
    const fp = fingerprint(shift);
    if (state.synced[shift.id] === fp) continue;
    await upsertEvent(shift);
    state.synced[shift.id] = fp;
    added++;
  }
  for (const id of Object.keys(state.synced)) {
    if (mineIds.has(id)) continue;
    await deleteEvent(id);
    delete state.synced[id];
    removed++;
  }
  saveState(state);
  return { added, removed };
}

/* Fallback link that opens a pre-filled Google Calendar event */
export function templateLink(shift) {
  const compact = (d, t) => `${d.replace(/-/g, "")}T${t.slice(0, 5).replace(":", "")}00`;
  const b = eventBody(shift);
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: b.summary,
    dates: `${compact(shift.shift_date, shift.start_time)}/${compact(shift.shift_date, shift.end_time)}`,
    ctz: TEAM_TIMEZONE,
    location: b.location,
    details: b.description
  });
  return `https://calendar.google.com/calendar/render?${params}`;
}
