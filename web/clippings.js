// Lector del archivo My Clippings.txt que guarda el Kindle (sirve para libros que no son de Amazon).
export const norm = s => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
export function hash(str) { // cyrb53
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
/* ---------- Kindle "My Clippings.txt" parser ---------- */
const MONTHS = {ene:0,jan:0,feb:1,mar:2,abr:3,apr:3,may:4,jun:5,jul:6,ago:7,aug:7,sep:8,set:8,oct:9,nov:10,dic:11,dec:11};
function parseKindleDate(raw) {
  if (!raw) return null;
  const s = norm(raw);
  let d, m, y;
  let r = s.match(/(\d{1,2})(?:\s+de)?\s+([a-z]+)\.?(?:\s+de)?\s+(\d{4})/);
  if (r && MONTHS[r[2].slice(0, 3)] !== undefined) { d = +r[1]; m = MONTHS[r[2].slice(0, 3)]; y = +r[3]; }
  else if ((r = s.match(/([a-z]+)\s+(\d{1,2}),?\s+(\d{4})/)) && MONTHS[r[1].slice(0, 3)] !== undefined) { m = MONTHS[r[1].slice(0, 3)]; d = +r[2]; y = +r[3]; }
  else return null;
  let hh = 0, mm = 0, ss = 0;
  const t = s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm|a\.\s?m\.|p\.\s?m\.)?/);
  if (t) { hh = +t[1]; mm = +t[2]; ss = +(t[3] || 0); const ap = (t[4] || "").replace(/[.\s]/g, ""); if (ap === "pm" && hh < 12) hh += 12; if (ap === "am" && hh === 12) hh = 0; }
  const out = new Date(y, m, d, hh, mm, ss).getTime();
  return isNaN(out) ? null : out;
}
function splitTitle(line) {
  line = line.replace(/^﻿/, "").trim();
  const m = line.match(/^(.*)\(([^()]*)\)\s*$/);
  if (m && m[1].trim()) {
    let author = m[2].trim();
    const parts = author.split(",");
    if (parts.length === 2 && !/;/.test(author)) author = `${parts[1].trim()} ${parts[0].trim()}`;
    return { title: m[1].trim(), author };
  }
  return { title: line, author: "" };
}
export function parseClippings(txt) {
  txt = txt.replace(/^﻿/, "").replace(/\r/g, "");
  const blocks = txt.split(/\n?={5,}\s*\n?/);
  const raw = [];
  for (const b of blocks) {
    const lines = b.split("\n");
    while (lines.length && !lines[0].trim()) lines.shift();
    if (lines.length < 2) continue;
    const { title, author } = splitTitle(lines[0]);
    const metaLine = lines[1].replace(/^\s*-\s*/, "");
    const content = lines.slice(2).join("\n").trim();
    const ml = norm(metaLine);
    let kind = "highlight";
    if (/marcador|bookmark|lesezeichen|signet|segnalibro/.test(ml)) kind = "bookmark";
    else if (/\bnota\b|\bnote\b|notiz|remarque/.test(ml)) kind = "note";
    if (kind === "bookmark" || !content) continue;
    const loc = ml.match(/(?:location|loc\.|posicion|ubicacion|position|posizione|emplacement)\s+(\d+)(?:\s*-\s*(\d+))?/);
    const page = ml.match(/(?:page|pagina|pag\.?|seite)\s+([0-9ivxlcdm]+)/);
    const segs = metaLine.split("|");
    const addedRaw = segs.length > 1 ? segs[segs.length - 1].replace(/^\s*(added on|añadido el|agregado el|anadido el|hinzugefügt am|ajouté le)\s*/i, "").trim() : "";
    raw.push({
      title, author, kind, text: content,
      locStart: loc ? +loc[1] : null, locEnd: loc ? +(loc[2] || loc[1]) : null,
      page: page ? page[1] : null, addedTs: parseKindleDate(addedRaw), addedRaw,
    });
  }
  // group into books
  const books = new Map();
  for (const r of raw) {
    const bookId = "b" + hash(norm(r.title) + "|" + norm(r.author));
    if (!books.has(bookId)) books.set(bookId, { id: bookId, title: r.title, author: r.author, hl: [], notes: [] });
    (r.kind === "note" ? books.get(bookId).notes : books.get(bookId).hl).push(r);
  }
  for (const bk of books.values()) {
    bk.hl = dedupe(bk.hl.map(r => makeHighlight(bk.id, r)));
    for (const n of bk.notes) {
      const target = n.locStart != null && bk.hl
        .filter(h => h.locStart != null && n.locStart >= h.locStart - 1 && n.locStart <= (h.locEnd ?? h.locStart) + 1)
        .sort((a, b) => Math.abs((a.locEnd ?? a.locStart) - n.locStart) - Math.abs((b.locEnd ?? b.locStart) - n.locStart))[0];
      if (target) target.note = target.note ? target.note + "\n" + n.text : n.text;
      else bk.hl.push(Object.assign(makeHighlight(bk.id, n), { isNote: true }));
    }
    delete bk.notes;
  }
  return { books: [...books.values()], total: raw.length };
}
function makeHighlight(bookId, r) {
  return {
    id: "h" + hash(bookId + "|" + norm(r.text)), text: r.text, note: "",
    locStart: r.locStart, locEnd: r.locEnd, page: r.page, addedTs: r.addedTs || null,
    fav: false, discarded: false, due: null, interval: 0, reviews: 0,
  };
}
// Kindle keeps the old clipping when you extend a highlight: keep the longest version.
export function overlaps(a, b) {
  if (a.locStart == null || b.locStart == null) return true;
  return a.locStart <= (b.locEnd ?? b.locStart) + 2 && b.locStart <= (a.locEnd ?? a.locStart) + 2;
}
function dedupe(list) {
  const out = [];
  for (const h of list) {
    const nh = norm(h.text);
    const i = out.findIndex(o => { const no = norm(o.text); return no === nh || ((no.includes(nh) || nh.includes(no)) && overlaps(o, h)); });
    if (i === -1) { out.push(h); continue; }
    if (norm(out[i].text).length < nh.length) out[i] = Object.assign({}, h, { note: out[i].note || h.note });
  }
  return out;
}

