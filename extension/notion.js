// Escribe los subrayados en Notion: una base de datos "Libros de Kindle" y, dentro de cada libro,
// sus subrayados como citas en orden de posición. Los nuevos se insertan en su sitio.
// Solo guardamos en local un registro mínimo de lo enviado (ids de bloques), nunca el texto.

const API = "https://api.notion.com/v1";
const VERSION = "2022-06-28";
const sleep = ms => new Promise(r => setTimeout(r, ms));

export class NotionError extends Error {
  constructor(code, message, status) { super(message); this.code = code; this.status = status; }
}

let lastCall = 0;
async function call(path, { method = "GET", body } = {}) {
  const { notionToken } = await chrome.storage.local.get("notionToken");
  if (!notionToken) throw new NotionError("no_token", "Falta conectar Notion");
  for (let attempt = 0; attempt < 6; attempt++) {
    const wait = lastCall + 350 - Date.now(); // Notion admite ~3 peticiones por segundo
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    let r;
    try {
      r = await fetch(API + path, {
        method, body: body ? JSON.stringify(body) : undefined,
        headers: { Authorization: `Bearer ${notionToken}`, "Notion-Version": VERSION, "Content-Type": "application/json" },
      });
    } catch {
      if (attempt < 2) { await sleep(1500); continue; }
      throw new NotionError("network", "No pude conectar con Notion. Revisa tu conexión.");
    }
    if (r.status === 429 || r.status >= 500) { await sleep((Number(r.headers.get("Retry-After")) || 2 ** attempt) * 1000); continue; }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new NotionError(j.code || String(r.status), j.message || `Notion respondió ${r.status}`, r.status);
    return j;
  }
  throw new NotionError("rate_limited", "Notion está saturado; lo vuelvo a intentar en la próxima sincronización");
}

/* ---------- Configuración ---------- */
export function pageIdFrom(input) {
  let s = String(input || "").trim();
  try { s = new URL(s).pathname.split("/").pop(); } catch {}
  s = s.replace(/-/g, "");
  const id = s.slice(-32);
  return /^[0-9a-f]{32}$/i.test(id) ? id : null;
}
export async function checkSetup(token, pageId) {
  const r = await fetch(`${API}/pages/${pageId}`, { headers: { Authorization: `Bearer ${token}`, "Notion-Version": VERSION } });
  if (r.ok) {
    const p = await r.json();
    const titleProp = Object.values(p.properties || {}).find(v => v.type === "title");
    return { ok: true, title: titleProp ? titleProp.title.map(t => t.plain_text).join("") : "" };
  }
  if (r.status === 401) return { ok: false, message: "Notion no acepta esa clave. Cópiala otra vez desde la integración." };
  if (r.status === 404) return { ok: false, message: "No veo esa página. Ábrela en Notion, menú ··· → Conexiones, y añade tu integración." };
  return { ok: false, message: `Notion respondió ${r.status}` };
}

/* ---------- Registro local de lo enviado ---------- */
// { databaseId, databaseUrl, books: { [key]: { pageId, headerId, title, hl: { [ext]: { b: blockId, l: location, t: textHash } } } } }
async function getLog() { const { notionLog } = await chrome.storage.local.get("notionLog"); return notionLog || { books: {} }; }
async function saveLog(log) { await chrome.storage.local.set({ notionLog: log }); }
export async function resetLog() { await chrome.storage.local.remove("notionLog"); }

export const norm = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
export function textHash(s) {
  const t = norm(s); let h = 2166136261;
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

/* ---------- Base de datos ---------- */
const rt = (content, annotations) => {
  const out = [];
  const s = String(content ?? "");
  for (let i = 0; i < s.length; i += 1900) out.push({ type: "text", text: { content: s.slice(i, i + 1900) }, ...(annotations ? { annotations } : {}) });
  return out;
};

export async function ensureDatabase() {
  const log = await getLog();
  if (log.databaseId) {
    try {
      const db = await call(`/databases/${log.databaseId}`);
      if (!db.archived && !db.in_trash) return log;
    } catch (e) { if (e.status !== 404) throw e; }
  }
  const { notionPageId } = await chrome.storage.local.get("notionPageId");
  const db = await call("/databases", {
    method: "POST",
    body: {
      parent: { type: "page_id", page_id: notionPageId },
      title: rt("Libros de Kindle"),
      properties: {
        "Título": { title: {} },
        "Autor": { rich_text: {} },
        "Subrayados": { number: { format: "number" } },
        "Últimos subrayados": { date: {} },
        "Fuente": { select: { options: [{ name: "Kindle", color: "gray" }, { name: "My Clippings", color: "brown" }] } },
        "Abrir en Kindle": { url: {} },
        "ASIN": { rich_text: {} },
      },
    },
  });
  const fresh = { databaseId: db.id, databaseUrl: db.url, books: {} }; // base nueva: se reenvía todo
  await saveLog(fresh);
  return fresh;
}


/* ---------- Bloques ---------- */
function highlightBlock(h) {
  const meta = [h.section || "", h.page ? `pág. ${h.page}` : "", h.location != null ? `pos. ${h.location}` : "", h.isNote ? "nota" : ""].filter(Boolean).join(" · ");
  const rich = [...rt(h.text)];
  if (h.note) rich.push(...rt("\n"), ...rt("Nota: ", { bold: true }), ...rt(h.note));
  if (meta) rich.push(...rt(`\n${meta}`, { color: "gray" }));
  return { object: "block", type: "quote", quote: { rich_text: rich.slice(0, 100) } };
}
const headerBlock = () => ({ object: "block", type: "paragraph", paragraph: { rich_text: rt("Subrayados en orden de lectura. Los nuevos aparecen solos en su sitio.", { color: "gray", italic: true }) } });
const chapterBlock = name => ({ object: "block", type: "heading_2", heading_2: { rich_text: rt(name), is_toggleable: true } });

async function listChildren(blockId) {
  const out = [];
  let cursor;
  do {
    const r = await call(`/blocks/${blockId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`);
    out.push(...r.results); cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  return out;
}

// Añade bloques (en orden) dentro de `parentId`, tras `after` o al final, y devuelve los ids creados.
async function append(parentId, blocks, after, knownIds) {
  const r = await call(`/blocks/${parentId}/children`, { method: "PATCH", body: { children: blocks, ...(after ? { after } : {}) } });
  if (r.results && r.results.length === blocks.length && r.results.every(b => !knownIds.has(b.id))) return r.results.map(b => b.id);
  // Por si la API devuelve la lista completa de hijos: los nuevos son los que no conocíamos, en orden.
  const all = await listChildren(parentId);
  return all.map(b => b.id).filter(id => !knownIds.has(id)).slice(0, blocks.length);
}

const SOURCE_NAME = { kindle: "Kindle", clippings: "My Clippings", html: "Exportación Kindle" };

// Título y autor solo se ponen al crear el libro: si los cambias en Notion, se respetan.
function bookProperties(b, count, domain, { created, touched }) {
  return {
    ...(created ? { "Título": { title: rt(b.title) }, "Autor": { rich_text: rt(b.author || "") } } : {}),
    "Subrayados": { number: count },
    "Fuente": { select: { name: SOURCE_NAME[b.source] || "Kindle" } },
    ...(b.asin ? { "ASIN": { rich_text: rt(b.asin) }, "Abrir en Kindle": { url: `https://${domain || "read.amazon.com"}/?asin=${b.asin}` } } : {}),
    ...(touched ? { "Últimos subrayados": { date: { start: new Date().toISOString() } } } : {}),
  };
}

/**
 * Envía un libro y sus subrayados. Solo añade los que no se habían enviado.
 * b: { key, source: "kindle"|"clippings"|"html", title, author, asin?, cover? }
 * items: [{ ext, text, note, location, page, isNote, section?, chapter?: { key, name, index } }]
 * Con capítulos, cada uno es un encabezado desplegable con sus subrayados dentro.
 * Devuelve cuántos subrayados nuevos se han añadido.
 */
export async function pushBook(b, items, { domain } = {}) {
  const log = await ensureDatabase();
  let key = b.key;
  if (!log.books[key] && b.source !== "kindle") {
    // Mismo libro ya enviado por otra vía compatible: se completa esa página.
    const compatible = ([, e]) => norm(e.title) === norm(b.title) && (b.source === "clippings" ? (e.src || "kindle") !== "html" : e.src === "html");
    const match = Object.entries(log.books).find(compatible);
    if (match) key = match[0];
  }
  let entry = log.books[key];

  const sorted = items.filter(i => (i.text || "").trim())
    .sort((x, y) => (x.chapter?.index ?? -1) - (y.chapter?.index ?? -1) || (x.location ?? Infinity) - (y.location ?? Infinity));
  const pending = () => {
    const sentTexts = new Set(entry ? Object.values(entry.hl).map(v => v.t) : []);
    const seenNow = new Set();
    return sorted.filter(i => {
      const t = textHash(i.text);
      if ((entry && entry.hl[i.ext]) || sentTexts.has(t) || seenNow.has(t)) return false;
      seenNow.add(t); return true;
    });
  };
  let fresh = pending();
  if (entry && !fresh.length) return 0;

  let created = false;
  try {
    if (!entry) { entry = await createBookPage(log, key, b, domain); created = true; }
    await insertInOrder(entry, fresh);
  } catch (e) {
    // La página se borró en Notion: se vuelve a crear con todo.
    if (entry && (e.status === 404 || /archived/i.test(e.message))) {
      delete log.books[key];
      entry = await createBookPage(log, key, b, domain); created = true;
      fresh = pending();
      await insertInOrder(entry, fresh);
    } else { log.books[key] = entry; await saveLog(log); throw e; }
  }

  log.books[key] = entry;
  await saveLog(log);
  await call(`/pages/${entry.pageId}`, { method: "PATCH", body: { properties: bookProperties(b, Object.keys(entry.hl).length, domain, { created, touched: fresh.length > 0 }) } });
  return fresh.length;
}

async function createBookPage(log, key, b, domain) {
  const page = await call("/pages", {
    method: "POST",
    body: {
      parent: { database_id: log.databaseId },
      ...(b.cover ? { cover: { type: "external", external: { url: b.cover } } } : {}),
      properties: bookProperties(b, 0, domain, { created: true, touched: true }),
    },
  });
  const [headerId] = await append(page.id, [headerBlock()], null, new Set());
  const entry = { pageId: page.id, headerId, title: b.title, src: b.source, hl: {}, chapters: {} };
  log.books[key] = entry;
  await saveLog(log);
  return entry;
}

function knownIds(entry) {
  return new Set([entry.headerId, ...Object.values(entry.hl).map(v => v.b), ...Object.values(entry.chapters || {}).map(c => c.b)]);
}

// Crea el encabezado desplegable de un capítulo en su sitio: tras el capítulo anterior que ya exista.
async function ensureChapter(entry, ch) {
  entry.chapters = entry.chapters || {};
  if (entry.chapters[ch.key]) return entry.chapters[ch.key].b;
  const before = Object.values(entry.chapters).filter(c => c.i < ch.index).sort((a, b) => b.i - a.i)[0];
  const lastFlat = Object.values(entry.hl).filter(v => !v.c).sort((a, b) => (b.l ?? -1) - (a.l ?? -1))[0];
  const after = before ? before.b : (lastFlat ? null : entry.headerId); // sin capítulos previos: tras la cabecera (o al final si hay subrayados sueltos)
  const [id] = await append(entry.pageId, [chapterBlock(ch.name)], after, knownIds(entry));
  entry.chapters[ch.key] = { b: id, i: ch.index, n: ch.name };
  return id;
}

async function insertInOrder(entry, fresh) {
  if (!fresh.length) return;
  entry.chapters = entry.chapters || {};
  // Por capítulo (o sin capítulo), cada subrayado va tras el último ya enviado con posición menor o igual.
  const buckets = new Map();
  for (const it of fresh) {
    const k = it.chapter ? it.chapter.key : "";
    if (!buckets.has(k)) buckets.set(k, { chapter: it.chapter || null, items: [] });
    buckets.get(k).items.push(it);
  }
  for (const { chapter, items } of buckets.values()) {
    const parent = chapter ? await ensureChapter(entry, chapter) : entry.pageId;
    const ck = chapter ? chapter.key : null;
    const placed = Object.values(entry.hl).filter(v => (v.c || null) === ck && v.l != null).sort((a, b) => a.l - b.l);
    const startAnchor = chapter ? null : entry.headerId; // dentro de un capítulo no hay bloque inicial: lo anterior al primero va al final
    const anchorFor = loc => {
      if (loc == null) return null;
      let a = startAnchor;
      for (const p of placed) { if (p.l <= loc) a = p.b; else break; }
      return a;
    };
    const groups = [];
    for (const it of items) {
      const a = anchorFor(it.location);
      const g = groups[groups.length - 1];
      if (g && g.anchor === a && g.items.length < 100) g.items.push(it); else groups.push({ anchor: a, items: [it] });
    }
    const known = knownIds(entry);
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      const ids = await append(parent, g.items.map(highlightBlock), g.anchor, known);
      g.items.forEach((it, i) => {
        if (!ids[i]) return;
        entry.hl[it.ext] = { b: ids[i], l: it.location ?? null, t: textHash(it.text), ...(ck ? { c: ck } : {}) };
        known.add(ids[i]);
      });
      // El siguiente grupo con el mismo ancla va detrás del último bloque de este.
      const lastId = ids[ids.length - 1];
      for (let gj = gi + 1; gj < groups.length; gj++) if (groups[gj].anchor === g.anchor) groups[gj].anchor = lastId;
    }
  }
}
