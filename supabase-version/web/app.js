import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";
import { CONFIG, isConfigured } from "./config.js";
import { parseClippings, norm, hash, overlaps } from "./clippings.js";

/* ---------- Utilities ---------- */
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = n => String(n).padStart(2, "0");
const dayStr = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => dayStr(new Date());
const addDays = n => { const d = new Date(); d.setDate(d.getDate() + n); return dayStr(d); };
const MONTHS_ES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const fmtDate = v => { if (!v) return ""; const d = new Date(v); return isNaN(d) ? "" : `${d.getDate()} ${MONTHS_ES[d.getMonth()]} ${d.getFullYear()}`; };
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const plural = (n, one, many) => `${n.toLocaleString("es-ES")} ${n === 1 ? one : many}`;

const ICON = {
  star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z"/></svg>',
  note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M5 4h14v12l-4 4H5z"/><path d="M15 20v-4h4M8.5 9h7M8.5 12.5h5"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  undo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6L4 11l5 5"/><path d="M4 11h11a5 5 0 010 10h-3"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  left: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v12M7 11l5 5 5-5M5 20h14"/></svg>',
};

/* ---------- Data (Supabase) ---------- */
const sb = isConfigured() ? createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY) : null;
let session = null;
const state = { books: new Map(), byId: new Map(), settings: { daily_count: 10, streak: 0, last_done: null, session: null }, loaded: false };

async function fetchAll(table) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select("*").order("id").range(from, from + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) return out;
  }
}
async function load() {
  setStatus("Cargando…");
  try {
    const [books, hls, settings] = await Promise.all([
      fetchAll("books"), fetchAll("highlights"),
      sb.from("review_settings").select("*").maybeSingle(),
    ]);
    const map = new Map();
    for (const b of books) map.set(b.id, { ...b, hl: [] });
    state.byId = new Map();
    for (const h of hls) { const b = map.get(h.book_id); if (b) { b.hl.push(h); state.byId.set(h.id, h); } }
    for (const b of map.values()) sortHl(b);
    state.books = map;
    if (settings.data) state.settings = settings.data;
    state.loaded = true;
    setStatus(`<span class="dot ok"></span>${esc(session.user.email)} · <button class="btn ghost" data-act="signout" style="padding:0 4px">Salir</button>`, true);
  } catch (e) {
    setStatus(`<span class="dot warn"></span>No pude cargar tu biblioteca: ${esc(e.message)}`, true);
    state.loaded = true;
  }
  render();
}
const sortHl = b => b.hl.sort((x, y) => (x.location ?? 1e12) - (y.location ?? 1e12) || String(x.created_at).localeCompare(String(y.created_at)));
function setStatus(html, isHtml) { const el = $("#status"); if (el) el.innerHTML = isHtml ? html : esc(html); }

async function patchHl(id, patch) {
  const h = state.byId.get(id); if (!h) return;
  Object.assign(h, patch); render();
  const { error } = await sb.from("highlights").update(patch).eq("id", id);
  if (error) toast(`No se pudo guardar: ${error.message}`);
}
async function deleteHl(id) {
  const h = state.byId.get(id); if (!h) return;
  const b = state.books.get(h.book_id);
  b.hl = b.hl.filter(x => x.id !== id); state.byId.delete(id); render();
  const { error } = await sb.from("highlights").delete().eq("id", id);
  if (error) toast(`No se pudo borrar: ${error.message}`); else toast("Subrayado eliminado");
}
async function deleteBook(id) {
  const b = state.books.get(id); if (!b) return;
  state.books.delete(id); b.hl.forEach(h => state.byId.delete(h.id));
  const { error } = await sb.from("books").delete().eq("id", id);
  if (error) toast(`No se pudo borrar: ${error.message}`); else toast(`“${b.title}” eliminado`);
}
let settingsTimer = null;
function saveSettings(now) {
  clearTimeout(settingsTimer);
  const go = async () => {
    const { daily_count, streak, last_done, session: s } = state.settings;
    const { error } = await sb.from("review_settings").upsert({ user_id: session.user.id, daily_count, streak, last_done, session: s });
    if (error) toast(`No se pudo guardar el repaso: ${error.message}`);
  };
  if (now) go(); else settingsTimer = setTimeout(go, 700);
}

/* ---------- Import My Clippings.txt ---------- */
let importPreview = null;
function findBookFor(nb) {
  const key = `clip:${hash(norm(nb.title) + "|" + norm(nb.author))}`;
  for (const b of state.books.values()) if (b.source_key === key) return b;
  const t = norm(nb.title);
  for (const b of state.books.values()) if (norm(b.title) === t || (t.length > 12 && (norm(b.title).startsWith(t) || t.startsWith(norm(b.title))))) return b;
  return null;
}
const sameText = (a, b) => { const x = norm(a), y = norm(b); return x === y || x.includes(y) || y.includes(x); };
function prepareImport(txt) {
  const parsed = parseClippings(txt);
  let fresh = 0, dup = 0;
  const rows = parsed.books.map(nb => {
    const ex = findBookFor(nb); let n = 0;
    for (const h of nb.hl) { if (ex && ex.hl.some(o => sameText(o.text, h.text))) dup++; else { fresh++; n++; } }
    return { title: nb.title, fresh: n, isNew: !ex };
  }).sort((a, b) => b.fresh - a.fresh);
  importPreview = { parsed, fresh, dup, rows };
  render();
  return parsed.books.length;
}
async function commitImport() {
  if (!importPreview) return;
  const { parsed } = importPreview; importPreview = null;
  setStatus("Importando…");
  let added = 0;
  try {
    for (const nb of parsed.books) {
      let book = findBookFor(nb);
      if (!book) {
        const { data, error } = await sb.from("books").upsert({ user_id: session.user.id, source: "clippings", source_key: `clip:${hash(norm(nb.title) + "|" + norm(nb.author))}`, title: nb.title, author: nb.author || null }, { onConflict: "user_id,source_key" }).select().single();
        if (error) throw error;
        book = { ...data, hl: [] };
      }
      const rows = [];
      for (const h of nb.hl) {
        const match = book.hl.find(o => sameText(o.text, h.text) && overlaps({ locStart: o.location, locEnd: o.location }, h));
        if (match) {
          if (norm(h.text).length > norm(match.text).length && match.external_id.startsWith("clip:")) await sb.from("highlights").update({ text: h.text }).eq("id", match.id);
          continue;
        }
        if (book.hl.some(o => sameText(o.text, h.text))) continue;
        rows.push({ user_id: session.user.id, book_id: book.id, external_id: `clip:${h.id}`, text: h.text, kindle_note: h.isNote ? null : (h.note || null), location: h.locStart, page: h.page, highlighted_at: h.addedTs ? new Date(h.addedTs).toISOString() : null, is_note: !!h.isNote });
      }
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await sb.from("highlights").upsert(rows.slice(i, i + 500), { onConflict: "user_id,external_id", ignoreDuplicates: true });
        if (error) throw error;
      }
      added += rows.length;
    }
    toast(added ? `${plural(added, "subrayado nuevo importado", "subrayados nuevos importados")}` : "No había subrayados nuevos");
  } catch (e) { toast(`La importación se cortó: ${e.message}`); }
  location.hash = "#biblioteca";
  await load();
}

/* ---------- Review ---------- */
const allHighlights = () => { const out = []; for (const b of state.books.values()) for (const h of b.hl) out.push({ b, h }); return out; };
const findHl = id => { const h = state.byId.get(id); return h ? { h, b: state.books.get(h.book_id) } : null; };
function buildSession(extra) {
  const t = today(), N = state.settings.daily_count || 10;
  const prev = state.settings.session;
  const taken = new Set(extra && prev ? prev.items : []);
  const pool = allHighlights().filter(x => !x.h.discarded && !taken.has(x.h.id));
  const due = pool.filter(x => x.h.due && x.h.due <= t).sort((a, b) => a.h.due < b.h.due ? -1 : 1);
  const fresh = shuffle(pool.filter(x => !x.h.due)).sort((a, b) => (b.h.fav ? 1 : 0) - (a.h.fav ? 1 : 0));
  const later = pool.filter(x => x.h.due && x.h.due > t).sort((a, b) => a.h.due < b.h.due ? -1 : 1);
  const items = shuffle([...due, ...fresh, ...later].slice(0, extra ? 5 : N)).map(x => x.h.id);
  state.settings.session = extra && prev ? { day: t, items: [...prev.items, ...items], idx: prev.idx } : { day: t, items, idx: 0 };
  saveSettings(true);
}
const currentSession = () => { const s = state.settings.session; return s && s.day === today() ? s : null; };
function reviewAct(kind) {
  const s = currentSession(); if (!s) return;
  const f = findHl(s.items[s.idx]);
  if (f) {
    const h = f.h, base = h.interval_days || 0, patch = { reviews: (h.reviews || 0) + 1, last_reviewed: today() };
    if (kind === "keep") { patch.interval_days = Math.min(base ? Math.round(base * (h.fav ? 1.6 : 2.3)) : (h.fav ? 4 : 8), 365); patch.due = addDays(patch.interval_days); }
    if (kind === "less") { patch.interval_days = Math.min(Math.max(30, base * 5), 730); patch.due = addDays(patch.interval_days); }
    if (kind === "discard") patch.discarded = true;
    patchHl(h.id, patch);
  }
  s.idx++;
  if (s.idx >= s.items.length) finishDay();
  saveSettings(s.idx >= s.items.length);
  render();
}
function finishDay() {
  const st = state.settings, t = today();
  if (st.last_done === t) return;
  const d = new Date(); d.setDate(d.getDate() - 1);
  st.streak = st.last_done === dayStr(d) ? (st.streak || 0) + 1 : 1;
  st.last_done = t;
}

/* ---------- Export ---------- */
const kindleLink = (b, h) => b.asin ? `kindle://book?action=open&asin=${encodeURIComponent(b.asin)}${h && h.location != null ? `&location=${h.location}` : ""}` : "";
function bookMarkdown(b) {
  const live = b.hl.filter(h => !h.discarded);
  const lines = [`# ${b.title}`, "", b.author ? `**Autor:** ${b.author}  ` : "", `**Subrayados:** ${live.length}`, "", "---", ""];
  for (const h of live) {
    lines.push(h.text.split("\n").map(l => "> " + l).join("\n"));
    const meta = [h.location != null ? `pos. ${h.location}` : "", h.page ? `pág. ${h.page}` : "", h.fav ? "favorito" : ""].filter(Boolean).join(" · ");
    if (meta) lines.push(">", `> — ${meta}`);
    if (h.kindle_note) lines.push("", `**Nota en Kindle:** ${h.kindle_note}`);
    if (h.note) lines.push("", `**Nota:** ${h.note}`);
    lines.push("");
  }
  return lines.join("\n");
}
const allMarkdown = () => [...state.books.values()].sort((a, b) => a.title.localeCompare(b.title, "es")).map(bookMarkdown).join("\n\n");
function allCsv() {
  const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = [["Highlight", "Title", "Author", "URL", "Note", "Location", "Date"].join(",")];
  for (const b of state.books.values()) for (const h of b.hl) if (!h.discarded)
    rows.push([q(h.text), q(b.title), q(b.author), q(""), q([h.kindle_note, h.note].filter(Boolean).join("\n")), q(h.location ?? ""), q(h.highlighted_at ? h.highlighted_at.slice(0, 19).replace("T", " ") : "")].join(","));
  return rows.join("\n");
}
const slug = s => norm(s).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "subrayados";
function download(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: filename.endsWith(".csv") ? "text/csv" : "text/markdown" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- Views ---------- */
let route = "repaso", bookId = null, query = "", libSort = "recent", editing = null, armed = null;
let login = { email: "", sent: false, error: "", busy: false };
function parseRoute() {
  const h = location.hash.replace(/^#/, "");
  if (h.startsWith("libro-")) { route = "libro"; bookId = h.slice(6); }
  else route = ["repaso", "biblioteca", "buscar", "importar"].includes(h) ? h : "repaso";
  editing = null; armed = null;
}
function render() {
  const app = $("#app");
  if (!sb) { app.innerHTML = `<section class="login"><h1>Subrayados</h1><p class="err">Falta configurar Supabase en <code>web/config.js</code>.</p></section>`; return; }
  const signedIn = !!session;
  $("#top").hidden = !signedIn; $("#foot").hidden = !signedIn;
  if (!signedIn) { app.innerHTML = viewLogin(); const i = $(login.sent ? "#code" : "#email"); if (i) i.focus(); return; }
  document.querySelectorAll("#tabs a").forEach(a => a.setAttribute("aria-current", (a.dataset.tab === route || (route === "libro" && a.dataset.tab === "biblioteca")) ? "page" : "false"));
  const all = allHighlights();
  $("#counts").textContent = state.loaded ? `${plural(state.books.size, "libro", "libros")} · ${plural(all.filter(x => !x.h.discarded).length, "subrayado", "subrayados")}` : "";
  if (!state.loaded) { app.innerHTML = '<div class="empty"><p class="meta">Cargando tu biblioteca…</p></div>'; return; }
  if (route !== "importar" && state.books.size === 0) { app.innerHTML = viewEmpty(); return; }
  app.innerHTML = route === "repaso" ? viewReview() : route === "biblioteca" ? viewLibrary() : route === "buscar" ? viewSearch() : route === "libro" ? viewBook() : viewImport();
  if (route === "buscar") { const i = $("#q"); if (i && document.activeElement !== i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }
  if (editing) { const t = $("#note-text"); if (t) t.focus(); }
}
function viewLogin() {
  return `<section class="login"><span class="eyebrow">Subrayados</span><h1>Tus subrayados de Kindle, cada día</h1>
    <p style="margin:0;color:var(--muted)">Entra con tu email. Te enviamos un código de un solo uso.</p>
    <form data-form="login">
      <label>Email<input id="email" type="email" required autocomplete="email" value="${esc(login.email)}" ${login.sent ? "readonly" : ""}></label>
      ${login.sent ? `<label>Código<input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="10" required></label>` : ""}
      ${login.error ? `<p class="err">${esc(login.error)}</p>` : ""}
      <div class="row"><button class="btn primary" type="submit" ${login.busy ? "disabled" : ""}>${login.sent ? "Entrar" : "Enviarme un código"}</button>
      ${login.sent ? `<button class="btn ghost" type="button" data-act="login-back">Cambiar email</button>` : ""}</div>
    </form></section>`;
}
function viewEmpty() {
  return `<section class="empty"><span class="eyebrow">Tu biblioteca está vacía</span><h2>Conecta tu Kindle</h2>
    <p>Instala la extensión de Chrome y entra con este mismo email: copiará tus subrayados del Notebook de Kindle cada día. Para libros que no compraste en Amazon, importa el archivo <span class="mono">My Clippings.txt</span>.</p>
    <div class="row"><a class="btn primary" href="#importar">Importar My Clippings.txt</a><button class="btn" data-act="reload">Ya he sincronizado, recargar</button></div></section>`;
}
const hlSourceLine = h => [h.location != null ? `pos. ${h.location}` : "", h.page ? `pág. ${esc(h.page)}` : "", h.highlighted_at ? fmtDate(h.highlighted_at) : ""].filter(Boolean).join(" · ");
const notes = (h, q) => `${h.kindle_note ? `<div class="note"><b>Nota en Kindle</b>${q ? markQuery(h.kindle_note, q) : esc(h.kindle_note)}</div>` : ""}${editing === h.id ? noteEditor(h) : h.note ? `<div class="note"><b>Tu nota</b>${q ? markQuery(h.note, q) : esc(h.note)}</div>` : ""}`;
function viewReview() {
  const s = currentSession();
  const live = allHighlights().filter(x => !x.h.discarded).length;
  const N = state.settings.daily_count || 10;
  const countSel = `<label class="meta" for="daily">Por día</label> <select id="daily">${[5, 10, 15, 20, 30].map(n => `<option ${n === N ? "selected" : ""}>${n}</option>`).join("")}</select>`;
  if (!s) {
    const dueCount = allHighlights().filter(x => !x.h.discarded && x.h.due && x.h.due <= today()).length;
    return `<section class="section-head"><div><span class="eyebrow">${new Date().toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" })}</span>
      <h1>Tu repaso de hoy</h1><p>${Math.min(N, live)} subrayados de ${plural(state.books.size, "libro", "libros")}. ${dueCount ? `${plural(dueCount, "toca", "tocan")} volver hoy.` : ""}</p></div>
      <div class="row">${countSel}</div></section>
      <div class="row"><button class="btn primary" data-act="start" ${live ? "" : "disabled"}>Empezar repaso</button>
      ${state.settings.streak && state.settings.last_done ? `<span class="streak">Racha: ${plural(state.settings.streak, "día", "días")}</span>` : ""}</div>`;
  }
  while (s.idx < s.items.length && !findHl(s.items[s.idx])) s.idx++;
  if (s.idx >= s.items.length) {
    return `<section class="done-card"><span class="eyebrow">Repaso completado</span><h2>Hecho por hoy</h2>
      <p class="streak">Racha: ${plural(state.settings.streak || 1, "día seguido", "días seguidos")}</p>
      <p style="margin:0;color:var(--muted)">Los que marcaste para seguir viendo volverán dentro de unos días. Los descartados no volverán a salir.</p>
      <div class="row"><button class="btn" data-act="more">Repasar 5 más</button><a class="btn ghost" href="#biblioteca">Ir a la biblioteca</a></div></section>`;
  }
  const { b, h } = findHl(s.items[s.idx]);
  const bar = s.items.map((_, i) => `<i class="${i < s.idx ? "done" : i === s.idx ? "cur" : ""}"></i>`).join("");
  const kl = kindleLink(b, h);
  return `<section class="review">
    <div class="row" style="justify-content:space-between"><span class="eyebrow">${s.idx + 1} de ${s.items.length}</span><div class="row">${countSel}</div></div>
    <div class="progress" aria-hidden="true">${bar}</div>
    <blockquote class="quote ${h.text.length > 420 ? "long" : ""}">${esc(h.text)}</blockquote>
    <div class="src"><a class="t" href="#libro-${b.id}" style="text-decoration:none">${esc(b.title)}</a><span class="meta">${esc(b.author || "")}${b.author ? " · " : ""}${hlSourceLine(h)}${h.reviews ? ` · visto ${plural(h.reviews, "vez", "veces")}` : ""}${kl ? ` · <a class="src-kindle" href="${kl}">abrir en Kindle</a>` : ""}</span></div>
    ${notes(h)}
    <div class="actions">
      <button class="btn primary" data-act="keep">Seguir viendo</button>
      <button class="btn" data-act="less">Ver menos</button>
      <button class="btn" data-act="discard">${ICON.x}Descartar</button>
      <span class="spacer"></span>
      <button class="icon-btn ${h.fav ? "on" : ""}" data-act="fav" data-h="${h.id}" aria-pressed="${h.fav}" title="Favorito">${ICON.star}Favorito</button>
      <button class="icon-btn" data-act="note" data-h="${h.id}" title="Nota">${ICON.note}Nota</button>
    </div>
    <div class="hint"><span><kbd>Enter</kbd> seguir viendo</span><span><kbd>M</kbd> ver menos</span><span><kbd>D</kbd> descartar</span><span><kbd>F</kbd> favorito</span><span><kbd>N</kbd> nota</span></div>
  </section>`;
}
function noteEditor(h) {
  return `<form class="note-edit" data-form="note" data-h="${h.id}"><label class="eyebrow" for="note-text">Tu nota</label>
    <textarea id="note-text" placeholder="Qué te sugiere este subrayado">${esc(h.note || "")}</textarea>
    <div class="row"><button class="btn primary" type="submit">Guardar nota</button><button class="btn ghost" type="button" data-act="cancel-note">Cancelar</button></div></form>`;
}
function lastOf(b) { return Math.max(0, ...b.hl.map(h => Date.parse(h.highlighted_at || h.created_at) || 0)); }
function viewLibrary() {
  const books = [...state.books.values()];
  books.sort(libSort === "title" ? (a, b) => a.title.localeCompare(b.title, "es") : libSort === "count" ? (a, b) => b.hl.length - a.hl.length : (a, b) => lastOf(b) - lastOf(a));
  return `<section class="section-head"><div><span class="eyebrow">Biblioteca</span><h1>${plural(books.length, "libro", "libros")}</h1></div>
    <div class="row"><button class="btn" data-act="export-md">${ICON.down}Markdown</button><button class="btn" data-act="export-csv">${ICON.down}CSV</button></div></section>
    <div class="toolbar"><label class="meta" for="sort">Ordenar</label><select id="sort">
      <option value="recent" ${libSort === "recent" ? "selected" : ""}>Más recientes</option><option value="title" ${libSort === "title" ? "selected" : ""}>Título</option><option value="count" ${libSort === "count" ? "selected" : ""}>Más subrayados</option></select>
      <span class="grow"></span><button class="btn ghost" data-act="reload">Recargar</button></div>
    <ul class="list">${books.map(b => {
      const live = b.hl.filter(h => !h.discarded); const favs = live.filter(h => h.fav).length; const l = lastOf(b);
      return `<li><a class="book" href="#libro-${b.id}">${b.cover_url ? `<img class="cover" src="${esc(b.cover_url)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span class="cover"></span>`}<span class="bt">${esc(b.title)}${b.source === "clippings" ? '<span class="chip">Archivo</span>' : ""}</span>
        <span class="ba">${esc(b.author) || "Autor desconocido"}</span>
        <span class="bc"><span class="meta" style="color:var(--fg)">${live.length}</span><br><span class="meta">${favs ? `${favs} fav · ` : ""}${l ? fmtDate(l) : ""}</span></span></a></li>`;
    }).join("")}</ul>`;
}
function hlItem(b, h, showBook, q) {
  return `<li class="hl ${h.discarded ? "discarded" : ""}">
    ${showBook ? `<div class="from"><a href="#libro-${b.id}">${esc(b.title)}</a>${b.author ? ` · ${esc(b.author)}` : ""}</div>` : ""}
    <p class="q">${q ? markQuery(h.text, q) : esc(h.text)}</p>
    ${notes(h, q)}
    <div class="foot"><span class="meta">${hlSourceLine(h)}${h.due && !h.discarded ? ` · vuelve ${fmtDate(h.due + "T12:00")}` : ""}${h.discarded ? " · descartado" : ""}</span>
      <button class="icon-btn ${h.fav ? "on" : ""}" data-act="fav" data-h="${h.id}" aria-pressed="${h.fav}" title="Favorito">${ICON.star}</button>
      <button class="icon-btn" data-act="note" data-h="${h.id}" title="Tu nota">${ICON.note}</button>
      <button class="icon-btn" data-act="toggle-discard" data-h="${h.id}" title="${h.discarded ? "Volver a repasar" : "Descartar del repaso"}">${h.discarded ? ICON.undo + "Restaurar" : ICON.x}</button>
      <button class="icon-btn danger ${armed === h.id ? "arm" : ""}" data-act="del-hl" data-h="${h.id}" title="Eliminar">${ICON.trash}${armed === h.id ? "¿Eliminar?" : ""}</button>
    </div></li>`;
}
function viewBook() {
  const b = state.books.get(bookId);
  if (!b) return `<a class="back" href="#biblioteca">${ICON.left}Biblioteca</a><div class="empty"><h2>Este libro ya no está</h2></div>`;
  const live = b.hl.filter(h => !h.discarded);
  return `<a class="back" href="#biblioteca">${ICON.left}Biblioteca</a>
    <section class="section-head"><div><span class="eyebrow">${esc(b.author) || "Autor desconocido"} · ${b.source === "kindle" ? "Kindle" : "My Clippings.txt"}</span><h1>${esc(b.title)}</h1>
      <p>${plural(live.length, "subrayado", "subrayados")} · ${live.filter(h => h.fav).length} favoritos${b.hl.length - live.length ? ` · ${b.hl.length - live.length} descartados` : ""}</p></div>
      <div class="row">${kindleLink(b) ? `<a class="btn" href="${kindleLink(b)}">Abrir en Kindle</a>` : ""}<button class="btn" data-act="export-book" data-b="${b.id}">${ICON.down}Markdown</button>
      <button class="btn danger ${armed === "book" ? "arm" : ""}" data-act="del-book" data-b="${b.id}">${armed === "book" ? "Pulsa otra vez para borrar" : "Borrar libro"}</button></div></section>
    ${b.source === "kindle" && armed === "book" ? `<p class="meta">Si lo borras, la extensión lo volverá a traer en la próxima sincronización completa.</p>` : ""}
    <ul class="hls">${b.hl.map(h => hlItem(b, h, false)).join("")}</ul>`;
}
function markQuery(text, q) {
  const t = esc(text); const words = q.trim().split(/\s+/).filter(w => w.length > 1).map(w => esc(w).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return words.length ? t.replace(new RegExp(`(${words.join("|")})`, "gi"), "<mark>$1</mark>") : t;
}
function viewSearch() {
  const q = query.trim(); let results = [];
  if (q.length > 1) {
    const words = norm(q).split(" ");
    results = allHighlights().filter(({ b, h }) => { const hay = norm([h.text, h.note, h.kindle_note, b.title, b.author].join(" ")); return words.every(w => hay.includes(w)); });
  }
  const favs = allHighlights().filter(x => x.h.fav && !x.h.discarded);
  return `<section class="section-head" style="padding-bottom:12px"><div><span class="eyebrow">Buscar</span><h1>En todos tus subrayados</h1></div></section>
    <input type="search" id="q" placeholder="Una palabra, un autor, una idea…" value="${esc(query)}" aria-label="Buscar" autocomplete="off">
    <p class="meta" style="margin:12px 0">${q.length > 1 ? plural(results.length, "resultado", "resultados") : "Busca en el texto, las notas, los títulos y los autores."}</p>
    <ul class="hls">${results.slice(0, 200).map(({ b, h }) => hlItem(b, h, true, q)).join("")}</ul>
    ${!q && favs.length ? `<div class="section-head" style="padding-top:20px"><div><span class="eyebrow">Tus favoritos</span></div></div><ul class="hls">${favs.map(({ b, h }) => hlItem(b, h, true)).join("")}</ul>` : ""}`;
}
function viewImport() {
  const p = importPreview;
  return `<section class="section-head"><div><span class="eyebrow">Importar</span><h1>Desde el archivo del Kindle</h1>
    <p>Para libros que no compraste en Amazon (PDFs, EPUBs enviados al Kindle). Lo de Amazon ya lo trae la extensión. Puedes importar el mismo archivo varias veces: solo entra lo nuevo.</p></div></section>
    ${p ? `<div class="panel"><span class="eyebrow">Vista previa</span>
      <div class="stats"><div class="stat"><b>${p.fresh}</b><span>nuevos</span></div><div class="stat"><b>${p.dup}</b><span>ya los tenías</span></div><div class="stat"><b>${p.rows.length}</b><span>libros</span></div></div>
      <div class="prevlist">${p.rows.map(r => `<div><span>${esc(r.title)}${r.isNew ? '<span class="chip">Nuevo</span>' : ""}</span><span class="meta">${r.fresh ? "+" + r.fresh : "—"}</span></div>`).join("")}</div>
      <div class="row"><button class="btn primary" data-act="commit" ${p.fresh ? "" : "disabled"}>Importar ${plural(p.fresh, "subrayado", "subrayados")}</button><button class="btn ghost" data-act="cancel-import">Cancelar</button></div></div>`
    : `<div class="drop" id="drop" role="button" tabindex="0" data-act="pick"><strong>Suelta aquí My Clippings.txt</strong><span style="color:var(--muted)">o pulsa para elegir el archivo</span></div>`}
    <div class="grid2"><div class="panel"><span class="eyebrow">Cómo sacar el archivo</span><ol class="steps">
      <li>Conecta el Kindle al ordenador con el cable USB.</li>
      <li>Abre la unidad <span class="mono">Kindle</span> y entra en <span class="mono">documents</span>.</li>
      <li>Copia <span class="mono">My Clippings.txt</span> y suéltalo arriba.</li></ol></div></div>`;
}

/* ---------- Events ---------- */
let toastTimer;
function toast(msg) {
  let t = $(".toast"); if (!t) { t = document.createElement("div"); t.className = "toast"; t.setAttribute("role", "status"); document.body.appendChild(t); }
  t.textContent = msg; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.remove(), 3000);
}
let armTimer;
function arm(key) { armed = key; clearTimeout(armTimer); armTimer = setTimeout(() => { armed = null; render(); }, 3500); render(); }
const currentId = () => { const s = currentSession(); return s ? s.items[s.idx] : null; };

document.addEventListener("click", e => {
  const el = e.target.closest("[data-act]"); if (!el) return;
  const act = el.dataset.act, hid = el.dataset.h, bid = el.dataset.b;
  switch (act) {
    case "signout": sb.auth.signOut(); break;
    case "login-back": login = { email: login.email, sent: false, error: "" }; render(); break;
    case "reload": load(); break;
    case "start": buildSession(false); render(); break;
    case "more": buildSession(true); render(); break;
    case "keep": case "less": case "discard": editing = null; reviewAct(act); break;
    case "fav": { const h = state.byId.get(hid); if (h) patchHl(hid, { fav: !h.fav }); break; }
    case "note": editing = editing === hid ? null : hid; render(); break;
    case "cancel-note": editing = null; render(); break;
    case "toggle-discard": { const h = state.byId.get(hid); if (h) patchHl(hid, { discarded: !h.discarded }); break; }
    case "del-hl": if (armed !== hid) { arm(hid); break; } armed = null; deleteHl(hid); break;
    case "del-book": if (armed !== "book") { arm("book"); break; } armed = null; deleteBook(bid); location.hash = "#biblioteca"; break;
    case "pick": $("#file").click(); break;
    case "commit": commitImport(); break;
    case "cancel-import": importPreview = null; render(); break;
    case "export-md": download("subrayados.md", allMarkdown()); break;
    case "export-csv": download("subrayados.csv", allCsv()); break;
    case "export-book": { const b = state.books.get(bid); if (b) download(slug(b.title) + ".md", bookMarkdown(b)); break; }
  }
});
document.addEventListener("change", e => {
  if (e.target.id === "daily") { state.settings.daily_count = +e.target.value; saveSettings(true); render(); }
  if (e.target.id === "sort") { libSort = e.target.value; render(); }
});
document.addEventListener("input", e => { if (e.target.id === "q") { query = e.target.value; render(); } });
document.addEventListener("submit", async e => {
  const f = e.target;
  if (f.dataset.form === "note") {
    e.preventDefault();
    const hid = f.dataset.h, val = $("#note-text").value.trim();
    editing = null; patchHl(hid, { note: val || null }); toast(val ? "Nota guardada" : "Nota borrada");
  }
  if (f.dataset.form === "login") {
    e.preventDefault();
    login.busy = true; login.error = "";
    try {
      if (!login.sent) {
        login.email = $("#email").value.trim();
        const { error } = await sb.auth.signInWithOtp({ email: login.email, options: { shouldCreateUser: true } });
        if (error) throw error;
        login.sent = true;
      } else {
        const { error } = await sb.auth.verifyOtp({ email: login.email, token: $("#code").value.trim(), type: "email" });
        if (error) throw error;
      }
    } catch (err) { login.error = err.message; }
    login.busy = false; render();
  }
});
document.addEventListener("keydown", e => {
  if (route !== "repaso" || editing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement && document.activeElement.tagName)) return;
  const s = currentSession(); if (!s || s.idx >= s.items.length) return;
  const k = e.key.toLowerCase();
  if (k === "enter" && !(document.activeElement && document.activeElement.tagName === "BUTTON")) { e.preventDefault(); reviewAct("keep"); }
  else if (k === "m") reviewAct("less");
  else if (k === "d") reviewAct("discard");
  else if (k === "f") { const id = currentId(); const h = id && state.byId.get(id); if (h) patchHl(id, { fav: !h.fav }); }
  else if (k === "n") { editing = currentId(); render(); e.preventDefault(); }
});
function readFile(file) {
  if (!file) return;
  const r = new FileReader();
  r.onload = () => { if (!prepareImport(String(r.result))) { importPreview = null; render(); toast("Ese archivo no parece un My Clippings.txt de Kindle"); } };
  r.onerror = () => toast("No pude leer el archivo");
  r.readAsText(file, "utf-8");
}
$("#file").addEventListener("change", e => { readFile(e.target.files[0]); e.target.value = ""; });
document.addEventListener("dragover", e => { const d = $("#drop"); if (d) { e.preventDefault(); d.classList.add("over"); } });
document.addEventListener("dragleave", e => { const d = $("#drop"); if (d && !d.contains(e.relatedTarget)) d.classList.remove("over"); });
document.addEventListener("drop", e => { const d = $("#drop"); if (!d) return; e.preventDefault(); d.classList.remove("over"); readFile(e.dataTransfer.files[0]); });
document.addEventListener("keydown", e => { if ((e.key === "Enter" || e.key === " ") && e.target.id === "drop") { e.preventDefault(); $("#file").click(); } });
window.addEventListener("hashchange", () => { parseRoute(); render(); window.scrollTo(0, 0); });
let lastLoad = Date.now();
document.addEventListener("visibilitychange", () => { if (!document.hidden && session && Date.now() - lastLoad > 5 * 60 * 1000) { lastLoad = Date.now(); load(); } });

parseRoute();
if (sb) {
  const { data } = await sb.auth.getSession();
  session = data.session;
  sb.auth.onAuthStateChange((_event, s) => {
    const changed = (s?.user?.id || null) !== (session?.user?.id || null);
    session = s;
    if (changed) { state.loaded = false; login = { email: "", sent: false, error: "", busy: false }; render(); if (s) load(); }
  });
  render();
  if (session) load();
} else render();
