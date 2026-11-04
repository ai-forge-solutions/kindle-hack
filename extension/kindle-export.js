// Lee el HTML de "Exportar cuaderno" de la app de Kindle (móvil o escritorio).
// Trae capítulos (sectionHeading), subrayados con página/posición/color y notas.
// Se ejecuta en una página de la extensión (necesita DOMParser).

const clean = s => String(s || "").replace(/\s+/g, " ").trim();
const norm = s => clean(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export function hash(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export const isKindleExport = html => /class=["']noteHeading["']/.test(html) && /class=["']noteText["']/.test(html);

// El título de los documentos enviados al Kindle suele ser el nombre del archivo:
// "New Sales_ Simplified_ _ The Essential Handbook for -- Mike Weinberg -- New York, 2012"
export function cleanTitle(raw) {
  let t = clean(raw).split(/\s+--\s+/)[0];
  t = t.replace(/^_?OceanofPDF\.com_?/i, "");
  t = t.replace(/\s_\s/g, ": ").replace(/_\s/g, " ").replace(/_/g, " ").replace(/\s{2,}/g, " ");
  t = t.replace(/\s*:\s*:/g, ":").replace(/\s+:/g, ":").trim();
  return t || clean(raw);
}

const TYPE = [
  ["highlight", /^(highlight|subrayado|resaltado|surlignement|markierung|evidenziazione)/i],
  ["note", /^(note|nota|notiz|remarque)/i],
  ["bookmark", /^(bookmark|marcador|lesezeichen|signet|segnalibro)/i],
];
const COLOR = /(yellow|blue|pink|orange|green|aqua|red|purple|amarillo|azul|rosa|naranja|verde|rojo|morado)/i;

function parseHeading(text) {
  const h = clean(text);
  const kind = (TYPE.find(([, re]) => re.test(h)) || ["highlight"])[0];
  const color = (h.match(COLOR) || [])[1] || null;
  const rest = h.includes(" - ") ? h.slice(h.indexOf(" - ") + 3) : "";
  const parts = rest.split(/\s+>\s+/);
  const where = parts.pop() || "";
  const section = parts.join(" › ") || null;
  const page = (where.match(/(?:page|p[aá]gina|seite|pagina)\s+([0-9ivxlcdm]+)/i) || [])[1] || null;
  const loc = (where.match(/(?:location|posici[oó]n|ubicaci[oó]n|position|posizione|emplacement)\s+([\d.,]+)/i) || [])[1];
  const location = loc ? parseInt(loc.replace(/[^\d]/g, ""), 10) : null;
  return { kind, color, section, page, location: Number.isFinite(location) ? location : null };
}

/**
 * Devuelve { title, author, rawTitle, chapters: [{key, name, index}], items: [...] }
 * items: { ext, text, note, location, page, color, section, chapter: {key,name,index} | null, isNote }
 */
export function parseKindleExport(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const rawTitle = clean(doc.querySelector(".bookTitle")?.textContent);
  const author = clean(doc.querySelector(".authors")?.textContent) || (rawTitle.split(/\s+--\s+/)[1] || "");
  const title = cleanTitle(rawTitle);
  const chapters = [];
  const items = [];
  let chapter = null, last = null;

  const nodes = doc.querySelectorAll(".sectionHeading, .noteHeading, .noteText");
  let pending = null;
  for (const el of nodes) {
    if (el.classList.contains("sectionHeading")) {
      const name = clean(el.textContent);
      chapter = { key: "c" + hash(norm(name)), name, index: chapters.length };
      if (!chapters.some(c => c.key === chapter.key)) chapters.push(chapter);
      else chapter = chapters.find(c => c.key === chapter.key);
      continue;
    }
    if (el.classList.contains("noteHeading")) { pending = parseHeading(el.textContent); continue; }
    if (!pending) continue;
    const text = clean(el.textContent);
    const head = pending; pending = null;
    if (head.kind === "bookmark" || !text) continue;
    if (head.kind === "note") {
      // Una nota va justo detrás del subrayado al que pertenece.
      // El subrayado lleva la posición donde empieza y la nota la de donde acaba.
      const near = last && last.chapter === chapter && !last.isNote &&
        (head.location == null || last.location == null || (head.location >= last.location && head.location - last.location <= 40));
      if (near) {
        last.note = last.note ? `${last.note}\n${text}` : text;
        continue;
      }
      items.push(last = { ext: "", text, note: "", location: head.location, page: head.page, color: null, section: head.section, chapter, isNote: true });
      continue;
    }
    items.push(last = { ext: "", text, note: "", location: head.location, page: head.page, color: head.color, section: head.section, chapter, isNote: false });
  }
  for (const it of items) it.ext = `html:${hash(norm(it.text))}`;
  return { title, author, rawTitle, chapters, items };
}
