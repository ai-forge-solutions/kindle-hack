import { parseClippings } from "./clippings.js";

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let parsed = null;

function show(html) { $("#out").innerHTML = html; }

function preview() {
  const total = parsed.books.reduce((n, b) => n + b.hl.length, 0);
  show(`<div class="panel"><span class="eyebrow">Vista previa</span>
    <p><strong>${total}</strong> subrayados en <strong>${parsed.books.length}</strong> libros. Los que ya estén en Notion no se repiten.</p>
    <div class="list">${parsed.books.map(b => `<div><span>${esc(b.title)}</span><span class="meta">${b.hl.length}</span></div>`).join("")}</div>
    <div><button class="btn primary" id="send">Enviar a Notion</button></div></div>`);
  $("#send").onclick = async () => {
    $("#send").disabled = true; $("#send").textContent = "Enviando… (puede tardar unos minutos)";
    const res = await chrome.runtime.sendMessage({ target: "background", type: "import-clippings", books: parsed.books });
    show(`<div class="panel"><p class="${res && res.ok ? "" : "err"}">${esc(res ? res.message : "No hubo respuesta de la extensión")}</p></div>`);
  };
}

function readFile(file) {
  if (!file) return;
  const r = new FileReader();
  r.onload = () => {
    parsed = parseClippings(String(r.result));
    if (!parsed.books.length) { show(`<p class="err">Ese archivo no parece un My Clippings.txt de Kindle.</p>`); return; }
    preview();
  };
  r.onerror = () => show(`<p class="err">No pude leer el archivo.</p>`);
  r.readAsText(file, "utf-8");
}

const drop = $("#drop");
drop.onclick = () => $("#file").click();
drop.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("#file").click(); } };
$("#file").onchange = e => { readFile(e.target.files[0]); e.target.value = ""; };
document.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("over"); });
document.addEventListener("dragleave", e => { if (!drop.contains(e.relatedTarget)) drop.classList.remove("over"); });
document.addEventListener("drop", e => { e.preventDefault(); drop.classList.remove("over"); readFile(e.dataTransfer.files[0]); });
