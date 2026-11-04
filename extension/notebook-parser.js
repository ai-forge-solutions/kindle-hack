// Lee el HTML del Notebook de Kindle (read.amazon.*/notebook).
// Amazon no documenta esta página: si cambia su estructura, este es el único archivo que hay que tocar.
// Se ejecuta en el documento offscreen porque el service worker no tiene DOMParser.

const txt = el => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");
const AUTHOR_PREFIX = /^\s*(by|de|por|von|par|di|door|da|av|przez|著者|作者)\s*[:：]\s*/i;

export function parseLibrary(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const nodes = [...doc.querySelectorAll(".kp-notebook-library-each-book")];
  const books = nodes.map(el => {
    const asin = el.id || el.getAttribute("data-asin") || "";
    const title = txt(el.querySelector("h2"));
    const author = txt(el.querySelector("p")).replace(AUTHOR_PREFIX, "");
    const img = el.querySelector("img");
    const lastAnnotated = el.querySelector('input[id^="kp-notebook-annotated-date"]')?.value || "";
    return { asin, title, author, cover: img ? img.getAttribute("src") || "" : "", lastAnnotated };
  }).filter(b => b.asin && b.title);
  const nextToken = doc.querySelector(".kp-notebook-library-next-page-start")?.value || "";
  return { books, nextToken, diag: diagnose(doc) };
}

const COLORS = [
  ["yellow", /yellow|amarill|gelb|jaune|giall/i],
  ["blue", /blue|azul|blau|bleu|blu\b/i],
  ["pink", /pink|rosa|rose/i],
  ["orange", /orange|naranja|arancio/i],
];

export function parseAnnotations(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  let rows = [...doc.querySelectorAll(".kp-notebook-row-separator")];
  if (!rows.length) rows = [...doc.querySelectorAll("#kp-notebook-annotations > div[id]")];
  const items = [];
  for (const row of rows) {
    const text = txt(row.querySelector("#highlight"));
    const note = txt(row.querySelector("#note"));
    if (!text && !note) continue;
    const header = txt(row.querySelector("#annotationHighlightHeader")) || txt(row.querySelector("#annotationNoteHeader"));
    const locRaw = row.querySelector("#kp-annotation-location")?.value || (header.match(/(?:location|posici[oó]n|position|posizione|ubicaci[oó]n)\s*[:：]?\s*([\d.,]+)/i) || [])[1] || "";
    const location = parseInt(String(locRaw).replace(/[^\d]/g, ""), 10);
    const page = (header.match(/(?:page|p[aá]gina|seite|pagina)\s*[:：]?\s*([0-9ivxlcdm]+)/i) || [])[1] || null;
    const color = (COLORS.find(([, re]) => re.test(header)) || [null])[0];
    const id = annotationId(row);
    items.push({ id, text, note, location: Number.isFinite(location) ? location : null, page, color, isNote: !text });
  }
  return {
    items,
    nextToken: doc.querySelector(".kp-notebook-annotations-next-page-start")?.value || "",
    contentLimitState: doc.querySelector(".kp-notebook-content-limit-state")?.value || "",
    diag: diagnose(doc),
  };
}

// El id de Amazon puede estar en la fila, en un contenedor por encima o en "highlight-<id>".
function annotationId(row) {
  const generic = /^(highlight|note|kp-notebook-annotations|annotationHighlightHeader|annotationNoteHeader)$/;
  for (let el = row; el && el.id !== "kp-notebook-annotations" && el.tagName !== "BODY"; el = el.parentElement) {
    if (el.id && !generic.test(el.id)) return el.id;
  }
  const inner = row.querySelector('[id^="highlight-"], [id^="note-"]');
  return inner ? inner.id.replace(/^(highlight|note)-/, "") : "";
}

// Solo cuenta selectores conocidos; no incluye títulos ni texto, para poder compartirlo sin exponer nada.
function diagnose(doc) {
  const sel = [".kp-notebook-library-each-book", "#kp-notebook-library", "#kp-notebook-annotations",
    ".kp-notebook-row-separator", "#highlight", "#note", "#annotationHighlightHeader", "#kp-annotation-location",
    ".kp-notebook-annotations-next-page-start", ".kp-notebook-content-limit-state", "#ap_email", "form[name=signIn]"];
  return Object.fromEntries(sel.map(s => [s, doc.querySelectorAll(s).length]));
}
