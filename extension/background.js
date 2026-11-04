// Sincronización automática: cada hora comprueba si han pasado 20 h desde la última y, si es así,
// lee el Notebook de Kindle con la sesión de Amazon que ya tienes abierta en Chrome y sube lo nuevo.
import { isConfigured } from "./config.js";
import * as supa from "./supa.js";

const ALARM = "subrayados-check";
const SYNC_EVERY_MS = 20 * 60 * 60 * 1000;
const PAUSE_MS = 700; // entre peticiones a Amazon, para no parecer un robot
const sleep = ms => new Promise(r => setTimeout(r, ms));

function ensureAlarm() { chrome.alarms.create(ALARM, { periodInMinutes: 60, delayInMinutes: 1 }); }
chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);
chrome.alarms.onAlarm.addListener(a => { if (a.name === ALARM) maybeSync(); });

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "background") return;
  if (msg.type === "sync-now") { runSync({ full: !!msg.full }).then(sendResponse); return true; }
});

async function maybeSync() {
  const { lastSyncAt, status } = await chrome.storage.local.get(["lastSyncAt", "status"]);
  // Si falta iniciar sesión en Amazon, reintenta cada hora: en cuanto entres, sincroniza sola.
  if (!lastSyncAt || Date.now() - lastSyncAt > SYNC_EVERY_MS || status?.state === "needs_amazon_login") runSync({});
}

let running = null;
function runSync(opts) {
  if (!running) running = doSync(opts).finally(() => { running = null; });
  return running;
}

async function setStatus(status) {
  await chrome.storage.local.set({ status: { ...status, at: Date.now() } });
  const bad = ["needs_amazon_login", "needs_app_login", "error", "parse_error"].includes(status.state);
  chrome.action.setBadgeText({ text: bad ? "!" : "" });
  if (bad) chrome.action.setBadgeBackgroundColor({ color: "#c0473a" });
}

class AmazonLoginNeeded extends Error {}

async function amazonGet(url) {
  const r = await fetch(url, { credentials: "include", redirect: "follow", cache: "no-store" });
  if (/\/ap\/signin|\/ap\/mfa/.test(r.url) || r.status === 401 || r.status === 403) throw new AmazonLoginNeeded();
  if (!r.ok) throw new Error(`Amazon respondió ${r.status}`);
  const html = await r.text();
  if (/id="ap_email"|name="signIn"/.test(html) && !/kp-notebook/.test(html)) throw new AmazonLoginNeeded();
  return html;
}

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  try {
    await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["DOM_PARSER"], justification: "Leer el HTML del Notebook de Kindle" });
  } catch (e) {
    if (!/single offscreen/i.test(String(e && e.message))) throw e;
  }
}
async function parse(kind, html) {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: "offscreen", kind, html });
  if (!res || res.error) throw new Error(`No pude leer la página de Amazon: ${res ? res.error : "sin respuesta"}`);
  return res;
}

async function fetchAnnotations(baseUrl, asin) {
  const items = [];
  let token = "", limitState = "";
  for (let page = 0; page < 300; page++) {
    const url = `${baseUrl}/notebook?asin=${encodeURIComponent(asin)}&contentLimitState=${encodeURIComponent(limitState)}&token=${encodeURIComponent(token)}`;
    const res = await parse("annotations", await amazonGet(url));
    items.push(...res.items);
    if (!res.nextToken || res.nextToken === token) break;
    token = res.nextToken; limitState = res.contentLimitState;
    await sleep(PAUSE_MS);
  }
  return items;
}

async function doSync({ full }) {
  if (!isConfigured()) { await setStatus({ state: "error", message: "Falta configurar Supabase en config.js" }); return; }
  const session = await supa.getSession();
  if (!session) { await setStatus({ state: "needs_app_login", message: "Inicia sesión en la extensión para empezar" }); return; }

  const { domain = "read.amazon.com", seen = {} } = await chrome.storage.local.get(["domain", "seen"]);
  const baseUrl = `https://${domain}`;
  const startedAt = Date.now();
  try {
    await setStatus({ state: "syncing", message: "Leyendo tu biblioteca de Kindle…" });
    let lib = await parse("library", await amazonGet(`${baseUrl}/notebook`));
    let books = lib.books;
    for (let i = 0; lib.nextToken && i < 100; i++) {
      await sleep(PAUSE_MS);
      lib = await parse("library", await amazonGet(`${baseUrl}/notebook?library=list&token=${encodeURIComponent(lib.nextToken)}`));
      books = books.concat(lib.books);
    }
    if (!books.length) {
      await chrome.storage.local.set({ diag: { where: "library", ...lib.diag } });
      await setStatus({ state: "parse_error", message: "No encontré libros en tu Notebook. Si sí tienes subrayados, Amazon ha cambiado la página: copia el diagnóstico y pásalo." });
      return;
    }

    const todo = books.filter(b => full || !b.lastAnnotated || seen[b.asin] !== b.lastAnnotated);
    let added = 0, failed = [];
    for (let i = 0; i < todo.length; i++) {
      const b = todo[i];
      await setStatus({ state: "syncing", message: `Leyendo “${b.title}” (${i + 1} de ${todo.length})…` });
      try {
        const items = await fetchAnnotations(baseUrl, b.asin);
        const row = await supa.upsertKindleBook(b);
        const before = await supa.existingExternalIds(row.id);
        const ids = await supa.upsertKindleHighlights(row.id, b.asin, items);
        added += ids.filter(id => !before.has(id)).length;
        seen[b.asin] = b.lastAnnotated || "";
        await chrome.storage.local.set({ seen });
      } catch (e) {
        if (e instanceof AmazonLoginNeeded || e.appAuth) throw e;
        failed.push(b.title);
      }
      await sleep(PAUSE_MS);
    }

    await chrome.storage.local.set({ lastSyncAt: Date.now(), lastResult: { books: books.length, checked: todo.length, added, failed, ms: Date.now() - startedAt } });
    const base = added ? `${added} subrayados nuevos` : "Sin subrayados nuevos";
    await setStatus(failed.length
      ? { state: "error", message: `${base}. No pude leer ${failed.length} libro(s): ${failed.slice(0, 3).join(", ")}` }
      : { state: "ok", message: `${base} · ${books.length} libros en tu Kindle` });
  } catch (e) {
    if (e instanceof AmazonLoginNeeded) await setStatus({ state: "needs_amazon_login", message: "Abre el Notebook de Kindle e inicia sesión en Amazon. Luego sincronizo sola." });
    else if (e.appAuth) await setStatus({ state: "needs_app_login", message: "Tu sesión en la extensión ha caducado. Vuelve a entrar." });
    else await setStatus({ state: "error", message: String(e && e.message || e) });
  }
}
