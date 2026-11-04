import { parseLibrary, parseAnnotations } from "./notebook-parser.js";

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "offscreen") return;
  try {
    sendResponse(msg.kind === "library" ? parseLibrary(msg.html) : parseAnnotations(msg.html));
  } catch (e) {
    sendResponse({ error: String(e && e.message || e) });
  }
});
