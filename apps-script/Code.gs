/**
 * Subrayados · de Gmail a Notion
 *
 * Cada 10 minutos busca en tu Gmail los correos enviados a tuusuario+kindle@gmail.com
 * con una exportación del cuaderno de Kindle (.html), y manda los subrayados a Notion:
 * base de datos «Libros de Kindle», un libro por página, capítulos como desplegables.
 *
 * No guarda nada fuera de Notion: para no duplicar, lee lo que ya hay en cada libro.
 *
 * Configuración (Configuración del proyecto → Propiedades del script):
 *   NOTION_TOKEN  clave secreta de la integración de Notion (ntn_…)
 *   NOTION_PAGE   enlace de la página de Notion donde están los libros
 * Después, ejecuta una vez la función «configurar».
 */

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const DB_TITLE = "Libros de Kindle";
const LABEL_OK = "Subrayados/Importado";
const LABEL_ERROR = "Subrayados/Error";
const MAX_RUN_MS = 5 * 60 * 1000; // Apps Script corta a los 6 minutos; lo pendiente sigue en la siguiente vuelta

/* ======================= Entradas ======================= */

/** Ejecútala una vez: comprueba la configuración, crea las etiquetas y programa la revisión cada 10 minutos. */
function configurar() {
  const cfg = config_();
  const page = notion_("GET", `/pages/${cfg.pageId}`);
  Logger.log(`Notion OK: página ${page.id}`);
  getOrCreateLabel_(LABEL_OK);
  getOrCreateLabel_(LABEL_ERROR);
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === "procesarCorreos")
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("procesarCorreos").timeBased().everyMinutes(10).create();
  Logger.log(`Listo. Manda las exportaciones de Kindle a ${kindleAddress_()} y llegarán a Notion en menos de 10 minutos.`);
  procesarCorreos();
}

/** La ejecuta el disparador cada 10 minutos. También puedes lanzarla a mano. */
function procesarCorreos() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return; // ya hay una vuelta en marcha
  const started = Date.now();
  const props = PropertiesService.getScriptProperties();
  try {
    // Solo correos tuyos (from:me) a la dirección +kindle. Se mira cada correo, no cada hilo:
    // Gmail agrupa en un hilo los correos con el mismo asunto (p. ej. reexportar un libro).
    const threads = GmailApp.search(`from:me to:${kindleAddress_()} has:attachment newer_than:30d`, 0, 50);
    let db = null;
    for (const thread of threads) {
      for (const msg of thread.getMessages()) {
        const doneKey = `hecho_${msg.getId()}`;
        if (props.getProperty(doneKey)) continue;
        if (!/\+kindle@/i.test(msg.getTo() + " " + msg.getCc())) continue;
        if (Date.now() - started > MAX_RUN_MS) return;
        const files = msg.getAttachments().filter(a => /\.html?$/i.test(a.getName()) || /html/i.test(a.getContentType()));
        let ok = true;
        for (const f of files) {
          try {
            const html = f.getDataAsString("UTF-8");
            if (!isKindleExport_(html)) continue;
            db = db || ensureDatabase_();
            const book = parseKindleExport_(html);
            const added = pushBook_(db, book, started);
            Logger.log(`«${book.title}»: ${added} subrayados nuevos`);
          } catch (e) {
            if (e && e.timeUp) return; // se retoma en la siguiente vuelta sin duplicar
            ok = false;
            Logger.log(`Error con ${f.getName()}: ${e && e.stack || e}`);
          }
        }
        props.setProperty(doneKey, ok ? "ok" : "error");
        thread.addLabel(getOrCreateLabel_(ok ? LABEL_OK : LABEL_ERROR));
        if (!ok) Logger.log("Ese correo se ha marcado con la etiqueta de error. Ejecuta «reintentarErrores» para volver a intentarlo.");
      }
    }
  } finally {
    lock.releaseLock();
  }
}

/** Para reintentar los correos que fallaron. */
function reintentarErrores() {
  const props = PropertiesService.getScriptProperties();
  Object.entries(props.getProperties()).forEach(([k, v]) => { if (k.startsWith("hecho_") && v === "error") props.deleteProperty(k); });
  const label = GmailApp.getUserLabelByName(LABEL_ERROR);
  if (label) label.getThreads().forEach(t => t.removeLabel(label));
  procesarCorreos();
}

/* ======================= Configuración ======================= */

function config_() {
  const p = PropertiesService.getScriptProperties();
  const token = (p.getProperty("NOTION_TOKEN") || "").trim();
  const pageId = pageIdFrom_(p.getProperty("NOTION_PAGE"));
  if (!token) throw new Error("Falta NOTION_TOKEN en las propiedades del script.");
  if (!pageId) throw new Error("Falta NOTION_PAGE (el enlace de la página de Notion) en las propiedades del script.");
  return { token, pageId };
}
function kindleAddress_() {
  const me = Session.getEffectiveUser().getEmail();
  return me.replace("@", "+kindle@");
}
function pageIdFrom_(input) {
  let s = String(input || "").trim().split(/[?#]/)[0];
  s = s.split("/").pop().replace(/-/g, "");
  const id = s.slice(-32);
  return /^[0-9a-f]{32}$/i.test(id) ? id : null;
}
function getOrCreateLabel_(name) { return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name); }

/* ======================= Lector del export de Kindle ======================= */

const clean_ = s => String(s || "").replace(/\s+/g, " ").trim();
const norm_ = s => clean_(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
function decode_(s) {
  return String(s || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
function hash_(str) { // cyrb53, igual que en la extensión
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
const isKindleExport_ = html => /class=["']noteHeading["']/.test(html) && /class=["']noteText["']/.test(html);

function cleanTitle_(raw) {
  let t = clean_(raw).split(/\s+--\s+/)[0];
  t = t.replace(/^_?OceanofPDF\.com_?/i, "");
  t = t.replace(/\s_\s/g, ": ").replace(/_\s/g, " ").replace(/_/g, " ").replace(/\s{2,}/g, " ");
  t = t.replace(/\s*:\s*:/g, ":").replace(/\s+:/g, ":").trim();
  return t || clean_(raw);
}

const TYPES_ = [
  ["highlight", /^(highlight|subrayado|resaltado|surlignement|markierung|evidenziazione)/i],
  ["note", /^(note|nota|notiz|remarque)/i],
  ["bookmark", /^(bookmark|marcador|lesezeichen|signet|segnalibro)/i],
];
function parseHeading_(text) {
  const h = clean_(text);
  const kind = (TYPES_.find(([, re]) => re.test(h)) || ["highlight"])[0];
  const rest = h.indexOf(" - ") >= 0 ? h.slice(h.indexOf(" - ") + 3) : "";
  const parts = rest.split(/\s+>\s+/);
  const where = parts.pop() || "";
  const section = parts.join(" › ") || null;
  const page = (where.match(/(?:page|p[aá]gina|seite|pagina)\s+([0-9ivxlcdm]+)/i) || [])[1] || null;
  const loc = (where.match(/(?:location|posici[oó]n|ubicaci[oó]n|position|posizione|emplacement)\s+([\d.,]+)/i) || [])[1];
  const location = loc ? parseInt(loc.replace(/[^\d]/g, ""), 10) : null;
  return { kind, section, page, location: isFinite(location) ? location : null };
}

function parseKindleExport_(html) {
  const pick = cls => decode_((html.match(new RegExp(`class=["']${cls}["'][^>]*>([\\s\\S]*?)</div>`)) || [])[1]);
  const rawTitle = clean_(pick("bookTitle"));
  const author = clean_(pick("authors")) || clean_(rawTitle.split(/\s+--\s+/)[1] || "");
  const title = cleanTitle_(rawTitle);
  const chapters = [], items = [];
  let chapter = null, last = null, pending = null;
  const re = /<div class=["'](sectionHeading|noteHeading|noteText)["'][^>]*>([\s\S]*?)<\/div>/g;
  let m;
  while ((m = re.exec(html))) {
    const cls = m[1], text = clean_(decode_(m[2]));
    if (cls === "sectionHeading") {
      const key = "c" + hash_(norm_(text));
      chapter = chapters.find(c => c.key === key) || { key, name: text, index: chapters.length };
      if (chapter.index === chapters.length) chapters.push(chapter);
      continue;
    }
    if (cls === "noteHeading") { pending = parseHeading_(text); continue; }
    if (!pending) continue;
    const head = pending; pending = null;
    if (head.kind === "bookmark" || !text) continue;
    if (head.kind === "note") {
      // El subrayado lleva la posición donde empieza y la nota la de donde acaba.
      const near = last && last.chapter === chapter && !last.isNote &&
        (head.location == null || last.location == null || (head.location >= last.location && head.location - last.location <= 40));
      if (near) { last.note = last.note ? `${last.note}\n${text}` : text; continue; }
      items.push(last = { text, note: "", location: head.location, page: head.page, section: head.section, chapter, isNote: true });
      continue;
    }
    items.push(last = { text, note: "", location: head.location, page: head.page, section: head.section, chapter, isNote: false });
  }
  return { key: `html:${hash_(title.toLowerCase() + "|" + author.toLowerCase())}`, title, author, chapters, items };
}

/* ======================= Notion ======================= */

let lastCall_ = 0;
function notion_(method, path, body) {
  const { token } = config_();
  for (let attempt = 0; attempt < 6; attempt++) {
    const wait = lastCall_ + 350 - Date.now(); // ~3 peticiones por segundo
    if (wait > 0) Utilities.sleep(wait);
    lastCall_ = Date.now();
    const r = UrlFetchApp.fetch(NOTION_API + path, {
      method, muteHttpExceptions: true, contentType: "application/json",
      headers: { Authorization: `Bearer ${token}`, "Notion-Version": NOTION_VERSION },
      ...(body ? { payload: JSON.stringify(body) } : {}),
    });
    const code = r.getResponseCode();
    if (code === 429 || code >= 500) { Utilities.sleep((Number(r.getHeaders()["Retry-After"]) || 2 ** attempt) * 1000); continue; }
    const j = JSON.parse(r.getContentText() || "{}");
    if (code >= 300) {
      const e = new Error(`Notion ${code}: ${j.message || j.code || "error"}`);
      e.status = code;
      throw e;
    }
    return j;
  }
  throw new Error("Notion está saturado; se reintenta en la siguiente vuelta.");
}

const rt_ = (content, annotations) => {
  const out = [], s = String(content == null ? "" : content);
  for (let i = 0; i < s.length; i += 1900) out.push({ type: "text", text: { content: s.slice(i, i + 1900) }, ...(annotations ? { annotations } : {}) });
  return out;
};
const plain_ = rich => (rich || []).map(r => r.plain_text != null ? r.plain_text : (r.text && r.text.content) || "").join("");

function listChildren_(blockId) {
  const out = [];
  let cursor = null;
  do {
    const r = notion_("GET", `/blocks/${blockId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`);
    out.push(...r.results);
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  return out;
}

/** Busca la base de datos «Libros de Kindle» en la página; si no existe, la crea. Le añade la propiedad «Clave». */
function ensureDatabase_() {
  const { pageId } = config_();
  const found = listChildren_(pageId).find(b => b.type === "child_database" && b.child_database.title === DB_TITLE);
  let db;
  if (found) {
    db = notion_("GET", `/databases/${found.id}`);
    if (!db.properties["Clave"]) notion_("PATCH", `/databases/${found.id}`, { properties: { "Clave": { rich_text: {} } } });
  } else {
    db = notion_("POST", "/databases", {
      parent: { type: "page_id", page_id: pageId },
      title: rt_(DB_TITLE),
      properties: {
        "Título": { title: {} }, "Autor": { rich_text: {} }, "Subrayados": { number: { format: "number" } },
        "Últimos subrayados": { date: {} },
        "Fuente": { select: { options: [{ name: "Kindle", color: "gray" }, { name: "My Clippings", color: "brown" }, { name: "Exportación Kindle", color: "blue" }] } },
        "Abrir en Kindle": { url: {} }, "ASIN": { rich_text: {} }, "Clave": { rich_text: {} },
      },
    });
  }
  return db.id;
}

/** Encuentra el libro por su clave o, si lo creó la extensión, por el título. */
function findBookPage_(dbId, book) {
  let r = notion_("POST", `/databases/${dbId}/query`, { filter: { property: "Clave", rich_text: { equals: book.key } }, page_size: 1 });
  if (r.results.length) return r.results[0];
  r = notion_("POST", `/databases/${dbId}/query`, { filter: { property: "Título", title: { equals: book.title } }, page_size: 5 });
  return r.results.find(p => !(p.properties["Clave"] && plain_(p.properties["Clave"].rich_text))) || null;
}

const highlightText_ = rich => {
  // La cita es el texto hasta el primer salto de línea que añadimos (nota o datos en gris).
  const segs = [];
  for (const r of rich || []) { const t = r.plain_text != null ? r.plain_text : r.text.content; if (/^\n/.test(t)) break; segs.push(t); }
  return segs.join("");
};
const metaLocation_ = rich => {
  const t = plain_(rich);
  const m = t.match(/pos\.\s*(\d+)/);
  return m ? +m[1] : null;
};

/** Reconstruye, leyendo Notion, qué hay ya en la página del libro. */
function readBookState_(pageId, chapters) {
  const top = listChildren_(pageId);
  const state = { pageId, headerId: null, chapters: {}, placed: { "": [] }, texts: {} };
  const header = top[0] && top[0].type === "paragraph" ? top[0] : null;
  if (header) state.headerId = header.id;
  let order = 0;
  for (const b of top) {
    if (b.type === "quote") {
      state.texts[hash_(norm_(highlightText_(b.quote.rich_text)))] = 1;
      state.placed[""].push({ b: b.id, l: metaLocation_(b.quote.rich_text) });
    } else if (b.type === "heading_2" && b.heading_2.is_toggleable) {
      const name = clean_(plain_(b.heading_2.rich_text));
      const key = "c" + hash_(norm_(name));
      const known = chapters.find(c => c.key === key);
      state.chapters[key] = { b: b.id, i: known ? known.index : -1, order: order++ };
      state.placed[key] = [];
      if (b.has_children) for (const q of listChildren_(b.id)) {
        if (q.type !== "quote") continue;
        state.texts[hash_(norm_(highlightText_(q.quote.rich_text)))] = 1;
        state.placed[key].push({ b: q.id, l: metaLocation_(q.quote.rich_text) });
      }
    }
  }
  return state;
}

function highlightBlock_(h) {
  const meta = [h.section || "", h.page ? `pág. ${h.page}` : "", h.location != null ? `pos. ${h.location}` : "", h.isNote ? "nota" : ""].filter(Boolean).join(" · ");
  const rich = rt_(h.text);
  if (h.note) rich.push(...rt_("\n"), ...rt_("Nota: ", { bold: true }), ...rt_(h.note));
  if (meta) rich.push(...rt_(`\n${meta}`, { color: "gray" }));
  return { object: "block", type: "quote", quote: { rich_text: rich.slice(0, 100) } };
}

function append_(parentId, blocks, after) {
  const r = notion_("PATCH", `/blocks/${parentId}/children`, { children: blocks, ...(after ? { after } : {}) });
  if (r.results && r.results.length === blocks.length) return r.results.map(b => b.id);
  const all = listChildren_(parentId).map(b => b.id); // por si la API devuelve todos los hijos
  return all.slice(after ? all.indexOf(after) + 1 : all.length - blocks.length).slice(0, blocks.length);
}

function pushBook_(dbId, book, started) {
  let page = findBookPage_(dbId, book);
  let created = false;
  if (!page) {
    page = notion_("POST", "/pages", {
      parent: { database_id: dbId },
      properties: {
        "Título": { title: rt_(book.title) }, "Autor": { rich_text: rt_(book.author || "") },
        "Fuente": { select: { name: "Exportación Kindle" } }, "Clave": { rich_text: rt_(book.key) }, "Subrayados": { number: 0 },
      },
    });
    append_(page.id, [{ object: "block", type: "paragraph", paragraph: { rich_text: rt_("Subrayados en orden de lectura. Los nuevos aparecen solos en su sitio.", { color: "gray", italic: true }) } }], null);
    created = true;
  } else if (!(page.properties["Clave"] && plain_(page.properties["Clave"].rich_text))) {
    notion_("PATCH", `/pages/${page.id}`, { properties: { "Clave": { rich_text: rt_(book.key) } } });
  }

  const state = readBookState_(page.id, book.chapters);
  const seen = {};
  const fresh = book.items
    .filter(it => {
      const t = hash_(norm_(it.text));
      if (state.texts[t] || seen[t]) return false;
      seen[t] = 1; return true;
    })
    .sort((a, b) => ((a.chapter ? a.chapter.index : -1) - (b.chapter ? b.chapter.index : -1)) || ((a.location == null ? Infinity : a.location) - (b.location == null ? Infinity : b.location)));

  let added = 0;
  const buckets = [];
  for (const it of fresh) {
    const k = it.chapter ? it.chapter.key : "";
    let bk = buckets.find(x => x.k === k);
    if (!bk) buckets.push(bk = { k, chapter: it.chapter, items: [] });
    bk.items.push(it);
  }
  for (const bk of buckets) {
    if (Date.now() - started > MAX_RUN_MS) { const e = new Error("tiempo"); e.timeUp = true; throw e; }
    let parent = page.id;
    if (bk.chapter) {
      let ch = state.chapters[bk.k];
      if (!ch) {
        // Va tras el capítulo anterior que ya exista; si no hay, tras la cabecera.
        const prev = Object.values(state.chapters).filter(c => c.i >= 0 && c.i < bk.chapter.index).sort((a, b) => b.i - a.i)[0];
        const after = prev ? prev.b : (state.placed[""].length ? null : state.headerId);
        const [id] = append_(page.id, [{ object: "block", type: "heading_2", heading_2: { rich_text: rt_(bk.chapter.name), is_toggleable: true } }], after);
        ch = state.chapters[bk.k] = { b: id, i: bk.chapter.index };
        state.placed[bk.k] = [];
      }
      parent = ch.b;
    }
    const placed = (state.placed[bk.k] || []).filter(p => p.l != null).sort((a, b) => a.l - b.l);
    const start = bk.chapter ? null : state.headerId;
    const anchorFor = loc => {
      if (loc == null) return null;
      let a = start;
      for (const p of placed) { if (p.l <= loc) a = p.b; else break; }
      return a;
    };
    const groups = [];
    for (const it of bk.items) {
      const a = anchorFor(it.location);
      const g = groups[groups.length - 1];
      if (g && g.anchor === a && g.items.length < 100) g.items.push(it); else groups.push({ anchor: a, items: [it] });
    }
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      const ids = append_(parent, g.items.map(highlightBlock_), g.anchor);
      added += ids.length;
      const lastId = ids[ids.length - 1];
      for (let gj = gi + 1; gj < groups.length; gj++) if (groups[gj].anchor === g.anchor) groups[gj].anchor = lastId;
    }
  }

  const count = Object.keys(state.texts).length + added;
  notion_("PATCH", `/pages/${page.id}`, { properties: {
    "Subrayados": { number: count },
    ...(added ? { "Últimos subrayados": { date: { start: new Date().toISOString() } } } : {}),
  } });
  return added;
}
