import * as notion from "./notion.js";

const app = document.getElementById("app");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const DOMAINS = ["read.amazon.com", "read.amazon.co.uk", "read.amazon.de", "read.amazon.fr", "read.amazon.it", "read.amazon.es", "read.amazon.ca", "read.amazon.com.au", "read.amazon.in", "read.amazon.co.jp", "read.amazon.com.mx", "read.amazon.com.br"];
let setupError = "", setupToken = "", setupPage = "";

function ago(ts) {
  if (!ts) return "nunca";
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return "ahora mismo";
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  return h < 24 ? `hace ${h} h` : `hace ${Math.round(h / 24)} días`;
}

async function render() {
  const s = await chrome.storage.local.get(["notionToken", "notionPageId", "notionPageTitle", "notionLog", "status", "lastSyncAt", "domain", "lastResult", "diag"]);
  if (!s.notionToken || !s.notionPageId) return renderSetup();
  const st = s.status || { state: "idle", message: "Todavía no se ha sincronizado" };
  const busy = st.state === "syncing";
  const dot = st.state === "ok" ? "ok" : busy ? "busy" : st.state === "idle" ? "" : "bad";
  const domain = s.domain || "read.amazon.com";
  const dbUrl = s.notionLog && s.notionLog.databaseUrl;
  app.innerHTML = `
    <div class="row" style="justify-content:space-between"><h1>Subrayados</h1>${dbUrl ? `<a class="btn ghost" href="${esc(dbUrl)}" target="_blank">Abrir en Notion</a>` : ""}</div>
    <div class="status">
      <span class="eyebrow">Kindle → Notion</span>
      <span class="msg"><span class="dot ${dot}"></span>${esc(st.message)}</span>
      <span class="meta">Última completa: ${ago(s.lastSyncAt)}${s.lastResult ? ` · ${s.lastResult.checked} de ${s.lastResult.books} libros revisados` : ""}</span>
      ${st.state === "needs_amazon_login" ? `<a class="btn primary" style="justify-self:start;margin-top:6px" href="https://${esc(domain)}/notebook" target="_blank">Abrir el Notebook de Kindle</a>` : ""}
      ${st.state === "parse_error" && s.diag ? `<button class="btn" style="justify-self:start;margin-top:6px" id="diag">Copiar diagnóstico</button>` : ""}
    </div>
    <div class="row">
      <button class="btn primary" id="sync" ${busy ? "disabled" : ""}>Sincronizar ahora</button>
      <button class="btn ghost" id="full" ${busy ? "disabled" : ""} title="Vuelve a mirar todos los libros, no solo los que tienen subrayados nuevos">Revisar todo</button>
    </div>
    <button class="btn" id="import" style="justify-self:start" ${busy ? "disabled" : ""}>Importar exportaciones de Kindle</button>
    <hr>
    <label>Tienda de Amazon de tu Kindle
      <select id="domain">${DOMAINS.map(d => `<option ${d === domain ? "selected" : ""}>${d}</option>`).join("")}</select></label>
    <p class="meta" style="margin:0">Sincroniza sola una vez al día mientras Chrome esté abierto. Usa tu sesión de Amazon en este navegador; tu contraseña nunca sale de Amazon.</p>
    <div class="row" style="justify-content:space-between"><span class="meta">Notion: ${esc(s.notionPageTitle || "página conectada")}</span><button class="btn ghost" id="out">Desconectar</button></div>
    <p class="meta" id="confirm" hidden style="margin:0;color:var(--danger)">Pulsa otra vez para desconectar. Lo que ya está en Notion se queda; si vuelves a conectar, se crea una base de datos nueva.</p>`;
  document.getElementById("sync").onclick = () => chrome.runtime.sendMessage({ target: "background", type: "sync-now" });
  document.getElementById("full").onclick = () => chrome.runtime.sendMessage({ target: "background", type: "sync-now", full: true });
  document.getElementById("import").onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL("import.html") });
  document.getElementById("domain").onchange = e => chrome.storage.local.set({ domain: e.target.value, seen: {} });
  const out = document.getElementById("out");
  out.onclick = async () => {
    if (out.dataset.armed) {
      await chrome.storage.local.remove(["notionToken", "notionPageId", "notionPageTitle", "notionLog", "seen", "status", "lastSyncAt", "lastResult"]);
      chrome.action.setBadgeText({ text: "" });
      render();
    } else { out.dataset.armed = "1"; out.textContent = "Confirmar"; document.getElementById("confirm").hidden = false; }
  };
  const d = document.getElementById("diag");
  if (d) d.onclick = () => navigator.clipboard.writeText(JSON.stringify(s.diag)).then(() => { d.textContent = "Copiado"; });
}

function renderSetup() {
  app.innerHTML = `
    <h1>Subrayados</h1>
    <p style="margin:0">Conecta Notion para que tus subrayados de Kindle lleguen solos a una página tuya.</p>
    <ol class="steps">
      <li>En <a href="https://www.notion.so/profile/integrations" target="_blank">notion.so/profile/integrations</a> crea una integración interna y copia su clave secreta.</li>
      <li>Abre la página de Notion donde quieres los libros, menú ··· → Conexiones, y añade esa integración.</li>
      <li>Pega aquí la clave y el enlace de la página.</li>
    </ol>
    <form id="f" style="display:grid;gap:10px">
      <label>Clave secreta de la integración<input id="token" type="password" required autocomplete="off" placeholder="ntn_…" value="${esc(setupToken)}"></label>
      <label>Enlace de la página de Notion<input id="page" type="url" required placeholder="https://www.notion.so/…" value="${esc(setupPage)}"></label>
      ${setupError ? `<p class="err">${esc(setupError)}</p>` : ""}
      <div class="row"><button class="btn primary" type="submit">Conectar</button></div>
    </form>`;
  const f = document.getElementById("f");
  f.onsubmit = async e => {
    e.preventDefault();
    const btn = f.querySelector("button"); btn.disabled = true; btn.textContent = "Comprobando…";
    const token = setupToken = document.getElementById("token").value.trim();
    setupPage = document.getElementById("page").value.trim();
    const pageId = notion.pageIdFrom(setupPage);
    if (!pageId) { setupError = "Ese enlace no parece de una página de Notion. Cópialo desde Compartir → Copiar enlace."; return renderSetup(); }
    const check = await notion.checkSetup(token, pageId).catch(() => ({ ok: false, message: "No pude conectar con Notion. Revisa tu conexión." }));
    if (!check.ok) { setupError = check.message; return renderSetup(); }
    setupError = setupToken = setupPage = "";
    await notion.resetLog();
    await chrome.storage.local.set({ notionToken: token, notionPageId: pageId, notionPageTitle: check.title, seen: {} });
    chrome.runtime.sendMessage({ target: "background", type: "sync-now" });
    render();
  };
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.status || changes.lastSyncAt || changes.notionLog) && !document.getElementById("token")) render();
});
render();
