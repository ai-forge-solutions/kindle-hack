import { parseClippings } from "./clippings.js";
import { parseKindleExport, isKindleExport, hash } from "./kindle-export.js";

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let books = [];   // [{ book: {key, source, title, author}, items, chapters }]
let skipped = []; // nombres de archivo que no se entendieron

function show(html) { $("#out").innerHTML = html; }

// Convierte cada archivo en libros listos para enviar a Notion.
function fromFile(name, text) {
  if (isKindleExport(text)) {
    const x = parseKindleExport(text);
    if (!x.items.length) return [];
    return [{ book: { key: `html:${hash(x.title.toLowerCase() + "|" + x.author.toLowerCase())}`, source: "html", title: x.title, author: x.author }, items: x.items, chapters: x.chapters.length }];
  }
  const parsed = parseClippings(text);
  return parsed.books.map(bk => ({
    book: { key: `clip:${bk.id}`, source: "clippings", title: bk.title, author: bk.author },
    items: bk.hl.map(h => ({ ext: `clip:${h.id}`, text: h.text, note: h.isNote ? "" : h.note, location: h.locStart, page: h.page, isNote: !!h.isNote })),
    chapters: 0,
  }));
}

function preview() {
  if (!books.length) {
    show(`<p class="err">No encontré subrayados en ${skipped.length > 1 ? "esos archivos" : "ese archivo"}. Sirven las exportaciones de la app de Kindle (.html) y My Clippings.txt.</p>`);
    return;
  }
  const total = books.reduce((n, b) => n + b.items.length, 0);
  show(`<div class="panel"><span class="eyebrow">Vista previa</span>
    <p><strong>${total}</strong> subrayados en <strong>${books.length}</strong> ${books.length === 1 ? "libro" : "libros"}. Los que ya estén en Notion no se repiten.</p>
    <div class="list">${books.map(b => `<div><span>${esc(b.book.title)}${b.book.author ? ` <span class="muted">· ${esc(b.book.author)}</span>` : ""}</span><span class="meta">${b.items.length}${b.chapters ? ` · ${b.chapters} cap.` : ""}</span></div>`).join("")}</div>
    ${skipped.length ? `<p class="meta">No reconocidos: ${esc(skipped.join(", "))}</p>` : ""}
    <div class="row"><button class="btn primary" id="send">Enviar a Notion</button><button class="btn" id="reset">Empezar de nuevo</button></div></div>`);
  $("#reset").onclick = () => { books = []; skipped = []; show(""); };
  $("#send").onclick = async () => {
    $("#send").disabled = true; $("#send").textContent = "Enviando… (puede tardar unos minutos)";
    const res = await chrome.runtime.sendMessage({ target: "background", type: "import-books", books: books.map(b => ({ book: b.book, items: b.items })) });
    show(`<div class="panel"><p class="${res && res.ok ? "" : "err"}">${esc(res ? res.message : "No hubo respuesta de la extensión")}</p></div>`);
    books = []; skipped = [];
  };
}

async function readFiles(files) {
  for (const file of files) {
    const text = await file.text().catch(() => "");
    const found = text ? fromFile(file.name, text) : [];
    if (!found.length) { skipped.push(file.name); continue; }
    for (const f of found) {
      const same = books.find(b => b.book.key === f.book.key);
      if (same) same.items = f.items; else books.push(f);
    }
  }
  preview();
}

const drop = $("#drop");
drop.onclick = () => $("#file").click();
drop.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("#file").click(); } };
$("#file").onchange = e => { readFiles([...e.target.files]); e.target.value = ""; };
document.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("over"); });
document.addEventListener("dragleave", e => { if (!drop.contains(e.relatedTarget)) drop.classList.remove("over"); });
document.addEventListener("drop", e => { e.preventDefault(); drop.classList.remove("over"); readFiles([...e.dataTransfer.files]); });
