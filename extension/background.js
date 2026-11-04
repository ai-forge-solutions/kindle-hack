// Sincronización automática: cada hora comprueba si han pasado 20 h desde la última y, si es así,
// lee el Notebook de Kindle con la sesión de Amazon que ya tienes abierta en Chrome y manda lo nuevo a Notion.
import * as notion from "./notion.js";

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
  if (msg.type === "sync-now") { runExclusive(() => doSync({ full: !!msg.full })).then(() => sendResponse({ ok: true })); return true; }
  if (msg.type === "import-books") { runExclusive(() => doImport(msg.books)).then(r => sendResponse(r)); return true; }
});

async function maybeSync() {
  const { lastSyncAt, status } = await chrome.storage.local.get(["lastSyncAt", "status"]);
  // Si falta iniciar sesión en Amazon, reintenta cada hora: en cuanto entres, sincroniza sola.
  if (!lastSyncAt || Date.now() - lastSyncAt > SYNC_EVERY_MS || status?.state === "needs_amazon_login") runExclusive(() => doSync({}));
}

let queue = Promise.resolve();
function runExclusive(fn) { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; }

async function setStatus(status) {
  await chrome.storage.local.set({ status: { ...status, at: Date.now() } });
  const bad = ["needs_amazon_login", "needs_notion", "error", "parse_error"].includes(status.state);
  chrome.action.setBadgeText({ text: bad ? "!" : "" });
  if (bad) chrome.action.setBadgeBackgroundColor({ color: "#c0473a" });
}

class AmazonLoginNeeded extends Error {}

class AmazonUnreachable extends Error {}

async function amazonGet(url) {
  let r;
  try {
    r = await fetch(url, { credentials: "include", redirect: "follow", cache: "no-store" });
  } catch {
    // Sin sesión, Amazon redirige al login de www.amazon.*, donde la extensión no tiene permiso:
    // Chrome corta la petición con "Failed to fetch". Repetimos sin seguir redirecciones para saberlo.
    let probe = null;
    try { probe = await fetch(url, { credentials: "include", redirect: "manual", cache: "no-store" }); } catch {}
    if (probe && (probe.type === "opaqueredirect" || (probe.status >= 300 && probe.status < 400))) throw new AmazonLoginNeeded();
    throw new AmazonUnreachable(`No pude conectar con ${new URL(url).host}. Revisa tu conexión o elige otra tienda de Amazon en el desplegable.`);
  }
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

async function notionReady() {
  const { notionToken, notionPageId } = await chrome.storage.local.get(["notionToken", "notionPageId"]);
  if (notionToken && notionPageId) return true;
  await setStatus({ state: "needs_notion", message: "Conecta Notion para empezar" });
  return false;
}

function notionFailure(e) {
  if (e instanceof notion.NotionError) {
    if (e.status === 401) return { state: "needs_notion", message: "Notion ya no acepta la clave de la integración. Vuelve a conectarla." };
    if (e.status === 404 || e.code === "object_not_found") return { state: "needs_notion", message: "No puedo escribir en la página de Notion. Comprueba que sigue compartida con tu integración." };
    return { state: "error", message: `Notion: ${e.message}` };
  }
  return null;
}

async function doSync({ full }) {
  if (!(await notionReady())) return;
  const { domain = "read.amazon.com", seen = {} } = await chrome.storage.local.get(["domain", "seen"]);
  const baseUrl = `https://${domain}`;
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
    await notion.ensureDatabase();

    const todo = books.filter(b => full || !b.lastAnnotated || seen[b.asin] !== b.lastAnnotated);
    let added = 0;
    const failed = [];
    for (let i = 0; i < todo.length; i++) {
      const b = todo[i];
      await setStatus({ state: "syncing", message: `“${b.title}” (${i + 1} de ${todo.length})…` });
      try {
        const items = await fetchAnnotations(baseUrl, b.asin);
        added += await notion.pushBook(
          { key: `asin:${b.asin}`, source: "kindle", title: b.title, author: b.author, asin: b.asin, cover: b.cover },
          items.map(it => ({
            ext: `kindle:${it.id || `${b.asin}:${it.location ?? ""}:${notion.textHash(it.text || it.note)}`}`,
            text: it.text || it.note, note: it.text ? it.note : "", location: it.location, page: it.page, isNote: it.isNote,
          })),
          { domain });
        seen[b.asin] = b.lastAnnotated || "";
        await chrome.storage.local.set({ seen });
      } catch (e) {
        if (e instanceof AmazonLoginNeeded || e instanceof AmazonUnreachable || (e instanceof notion.NotionError && ([401, 404].includes(e.status) || e.code === "network"))) throw e;
        failed.push(b.title);
      }
      await sleep(PAUSE_MS);
    }

    await chrome.storage.local.set({ lastSyncAt: Date.now(), lastResult: { books: books.length, checked: todo.length, added, failed } });
    const base = added ? `${added} subrayados nuevos en Notion` : "Sin subrayados nuevos";
    await setStatus(failed.length
      ? { state: "error", message: `${base}. No pude con ${failed.length} libro(s): ${failed.slice(0, 3).join(", ")}` }
      : { state: "ok", message: `${base} · ${books.length} libros en tu Kindle` });
  } catch (e) {
    if (e instanceof AmazonLoginNeeded) await setStatus({ state: "needs_amazon_login", message: "Abre el Notebook de Kindle e inicia sesión en Amazon. Luego sincronizo sola." });
    else if (e instanceof AmazonUnreachable) await setStatus({ state: "error", message: e.message });
    else await setStatus(notionFailure(e) || { state: "error", message: `Error inesperado: ${String(e && e.message || e)}` });
  }
}

async function doImport(books) {
  if (!(await notionReady())) return { ok: false, message: "Conecta Notion primero" };
  let added = 0;
  const failed = [];
  try {
    await notion.ensureDatabase();
    for (let i = 0; i < books.length; i++) {
      const { book, items } = books[i];
      await setStatus({ state: "syncing", message: `Importando “${book.title}” (${i + 1} de ${books.length})…` });
      try {
        added += await notion.pushBook(book, items);
      } catch (e) {
        if (e instanceof notion.NotionError && ([401, 404].includes(e.status) || e.code === "network")) throw e;
        failed.push(book.title);
      }
    }
    const message = `${added} subrayados nuevos en Notion${failed.length ? `. Fallaron: ${failed.slice(0, 3).join(", ")}` : ""}`;
    await setStatus({ state: failed.length ? "error" : "ok", message });
    return { ok: !failed.length, added, message };
  } catch (e) {
    const st = notionFailure(e) || { state: "error", message: String(e && e.message || e) };
    await setStatus(st);
    return { ok: false, message: st.message };
  }
}
