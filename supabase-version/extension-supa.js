// Cliente mínimo de Supabase (Auth + REST) sin dependencias, para usarlo en el service worker y el popup.
import { CONFIG } from "./config.js";

const base = () => CONFIG.SUPABASE_URL.replace(/\/$/, "");
const headers = extra => ({ apikey: CONFIG.SUPABASE_ANON_KEY, "Content-Type": "application/json", ...extra });

async function errorText(r) {
  try { const j = await r.json(); return j.msg || j.message || j.error_description || j.error || `HTTP ${r.status}`; }
  catch { return `HTTP ${r.status}`; }
}

export async function sendCode(email) {
  const r = await fetch(`${base()}/auth/v1/otp`, { method: "POST", headers: headers(), body: JSON.stringify({ email, create_user: true }) });
  if (!r.ok) throw new Error(await errorText(r));
}

function toSession(j) {
  return { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Math.floor(Date.now() / 1000) + (j.expires_in || 3600), user: { id: j.user.id, email: j.user.email } };
}

export async function verifyCode(email, token) {
  const r = await fetch(`${base()}/auth/v1/verify`, { method: "POST", headers: headers(), body: JSON.stringify({ type: "email", email, token }) });
  if (!r.ok) throw new Error(await errorText(r));
  const session = toSession(await r.json());
  await chrome.storage.local.set({ session });
  return session;
}

let refreshing = null;
export async function getSession() {
  const { session } = await chrome.storage.local.get("session");
  if (!session) return null;
  if (session.expires_at - 120 > Date.now() / 1000) return session;
  if (!refreshing) refreshing = (async () => {
    const r = await fetch(`${base()}/auth/v1/token?grant_type=refresh_token`, { method: "POST", headers: headers(), body: JSON.stringify({ refresh_token: session.refresh_token }) });
    if (!r.ok) { if (r.status === 400 || r.status === 401) await chrome.storage.local.remove("session"); return null; }
    const fresh = toSession(await r.json());
    await chrome.storage.local.set({ session: fresh });
    return fresh;
  })().finally(() => { refreshing = null; });
  return refreshing;
}

export async function signOut() {
  const s = await getSession();
  if (s) fetch(`${base()}/auth/v1/logout`, { method: "POST", headers: headers({ Authorization: `Bearer ${s.access_token}` }) }).catch(() => {});
  await chrome.storage.local.remove(["session", "seen"]);
}

async function rest(path, { method = "GET", body, prefer } = {}) {
  const s = await getSession();
  if (!s) { const e = new Error("Tu sesión en la extensión ha caducado"); e.appAuth = true; throw e; }
  const r = await fetch(`${base()}/rest/v1/${path}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: headers({ Authorization: `Bearer ${s.access_token}`, ...(prefer ? { Prefer: prefer } : {}) }),
  });
  if (r.status === 401) { const e = new Error("Tu sesión en la extensión ha caducado"); e.appAuth = true; throw e; }
  if (!r.ok) throw new Error(await errorText(r));
  return r.status === 204 || r.headers.get("content-length") === "0" ? null : r.json();
}

export async function upsertKindleBook(b) {
  const s = await getSession();
  const rows = await rest("books?on_conflict=user_id,source_key", {
    method: "POST", prefer: "resolution=merge-duplicates,return=representation",
    body: [{ user_id: s.user.id, source: "kindle", source_key: `asin:${b.asin}`, asin: b.asin, title: b.title, author: b.author || null, cover_url: b.cover || null, last_annotated: b.lastAnnotated || null }],
  });
  return rows[0];
}

export async function existingExternalIds(bookId) {
  const out = new Set();
  for (let offset = 0; ; offset += 1000) {
    const rows = await rest(`highlights?select=external_id&book_id=eq.${bookId}&order=external_id&limit=1000&offset=${offset}`);
    rows.forEach(r => out.add(r.external_id));
    if (rows.length < 1000) return out;
  }
}

// Solo escribe los campos que vienen de Amazon: favoritos, notas propias y repasos nunca se pisan.
export async function upsertKindleHighlights(bookId, asin, items) {
  const s = await getSession();
  const rows = items.map(it => ({
    user_id: s.user.id, book_id: bookId,
    external_id: `kindle:${it.id || `${asin}:${it.location ?? ""}:${hashText(it.text || it.note)}`}`,
    text: it.text || it.note || "", kindle_note: it.text ? (it.note || null) : null,
    location: it.location, page: it.page, color: it.color, is_note: !!it.isNote,
  }));
  for (let i = 0; i < rows.length; i += 500) {
    await rest("highlights?on_conflict=user_id,external_id", { method: "POST", prefer: "resolution=merge-duplicates,return=minimal", body: rows.slice(i, i + 500) });
  }
  return rows.map(r => r.external_id);
}

function hashText(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}
