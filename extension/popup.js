import { CONFIG, isConfigured } from "./config.js";
import * as supa from "./supa.js";

const app = document.getElementById("app");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const DOMAINS = ["read.amazon.com", "read.amazon.co.uk", "read.amazon.de", "read.amazon.fr", "read.amazon.it", "read.amazon.es", "read.amazon.ca", "read.amazon.com.au", "read.amazon.in", "read.amazon.co.jp", "read.amazon.com.mx", "read.amazon.com.br"];
let loginStep = { email: "", sent: false, error: "" };

function ago(ts) {
  if (!ts) return "nunca";
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return "ahora mismo";
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} días`;
}

async function render() {
  if (!isConfigured()) {
    app.innerHTML = `<h1>Subrayados</h1><p class="err">Falta configurar la extensión: rellena <code>config.js</code> con la URL y la clave anon de Supabase y recárgala.</p>`;
    return;
  }
  const session = await supa.getSession();
  if (!session) return renderLogin();
  const { status, lastSyncAt, domain = "read.amazon.com", lastResult, diag } = await chrome.storage.local.get(["status", "lastSyncAt", "domain", "lastResult", "diag"]);
  const st = status || { state: "idle", message: "Todavía no se ha sincronizado" };
  const dot = st.state === "ok" ? "ok" : st.state === "syncing" ? "busy" : st.state === "idle" ? "" : "bad";
  app.innerHTML = `
    <div class="row" style="justify-content:space-between"><h1>Subrayados</h1><a class="btn ghost" href="${esc(CONFIG.WEB_URL)}" target="_blank">Abrir app</a></div>
    <div class="status">
      <span class="eyebrow">Sincronización con Kindle</span>
      <span class="msg"><span class="dot ${dot}"></span>${esc(st.message)}</span>
      <span class="meta">Última completa: ${ago(lastSyncAt)}${lastResult ? ` · ${lastResult.checked} de ${lastResult.books} libros revisados` : ""}</span>
      ${st.state === "needs_amazon_login" ? `<a class="btn primary" style="justify-self:start;margin-top:6px" href="https://${esc(domain)}/notebook" target="_blank">Abrir el Notebook de Kindle</a>` : ""}
      ${st.state === "parse_error" && diag ? `<button class="btn" style="justify-self:start;margin-top:6px" id="diag">Copiar diagnóstico</button>` : ""}
    </div>
    <div class="row">
      <button class="btn primary" id="sync" ${st.state === "syncing" ? "disabled" : ""}>Sincronizar ahora</button>
      <button class="btn ghost" id="full" ${st.state === "syncing" ? "disabled" : ""} title="Vuelve a leer todos los libros, no solo los que tienen subrayados nuevos">Releer todo</button>
    </div>
    <hr>
    <label>Tienda de Amazon de tu Kindle
      <select id="domain">${DOMAINS.map(d => `<option ${d === domain ? "selected" : ""}>${d}</option>`).join("")}</select></label>
    <p class="meta" style="margin:0">Sincroniza sola una vez al día mientras Chrome esté abierto. Usa tu sesión de Amazon en este navegador; tu contraseña nunca sale de Amazon.</p>
    <div class="row" style="justify-content:space-between"><span class="meta">${esc(session.user.email)}</span><button class="btn ghost" id="out">Salir</button></div>`;
  document.getElementById("sync").onclick = () => chrome.runtime.sendMessage({ target: "background", type: "sync-now" });
  document.getElementById("full").onclick = () => chrome.runtime.sendMessage({ target: "background", type: "sync-now", full: true });
  document.getElementById("domain").onchange = e => chrome.storage.local.set({ domain: e.target.value, seen: {} });
  document.getElementById("out").onclick = async () => { await supa.signOut(); render(); };
  const d = document.getElementById("diag");
  if (d) d.onclick = () => navigator.clipboard.writeText(JSON.stringify(diag)).then(() => { d.textContent = "Copiado"; });
}

function renderLogin() {
  app.innerHTML = `
    <h1>Subrayados</h1>
    <p style="margin:0">Entra con tu email para que la extensión pueda guardar tus subrayados en tu biblioteca.</p>
    <form id="f" style="display:grid;gap:10px">
      <label>Email<input id="email" type="email" required autocomplete="email" value="${esc(loginStep.email)}" ${loginStep.sent ? "readonly" : ""}></label>
      ${loginStep.sent ? `<label>Código que te hemos enviado<input id="code" inputmode="numeric" autocomplete="one-time-code" required maxlength="10"></label>` : ""}
      ${loginStep.error ? `<p class="err">${esc(loginStep.error)}</p>` : ""}
      <div class="row"><button class="btn primary" type="submit">${loginStep.sent ? "Entrar" : "Enviarme un código"}</button>
      ${loginStep.sent ? `<button class="btn ghost" type="button" id="back">Cambiar email</button>` : ""}</div>
    </form>`;
  const f = document.getElementById("f");
  (loginStep.sent ? document.getElementById("code") : document.getElementById("email")).focus();
  const back = document.getElementById("back");
  if (back) back.onclick = () => { loginStep = { email: loginStep.email, sent: false, error: "" }; renderLogin(); };
  f.onsubmit = async e => {
    e.preventDefault();
    const btn = f.querySelector("button[type=submit]"); btn.disabled = true;
    try {
      if (!loginStep.sent) {
        loginStep.email = document.getElementById("email").value.trim();
        await supa.sendCode(loginStep.email);
        loginStep = { email: loginStep.email, sent: true, error: "" };
        renderLogin();
      } else {
        await supa.verifyCode(loginStep.email, document.getElementById("code").value.trim());
        loginStep = { email: "", sent: false, error: "" };
        chrome.runtime.sendMessage({ target: "background", type: "sync-now" });
        render();
      }
    } catch (err) {
      loginStep.error = loginStep.sent ? `No se pudo entrar: ${err.message}` : `No se pudo enviar el código: ${err.message}`;
      renderLogin();
    }
  };
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.status || changes.session || changes.lastSyncAt) && !document.getElementById("code")) render();
});
render();
