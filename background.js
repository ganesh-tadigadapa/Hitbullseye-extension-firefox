// Chrome runs this file as a service worker; Firefox loads solver.js first via manifest "scripts"
if (typeof importScripts === "function" && !globalThis.HBSolver) importScripts("solver.js");

// Older versions tracked used-up models for all keys together; that record is no longer used
chrome.storage.local.remove("geminiExhausted");

// A picture from the test page that the page itself won't let the content script read (it's from another
// site, or hasn't loaded because its question is hidden), as a data URL
async function fetchImage(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get("content-type") || "image/png";
    const bytes = new Uint8Array(await res.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:${type.split(";")[0]};base64,${btoa(binary)}`;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === "fetchImage") {
        fetchImage(request.url).then(
            (dataUrl) => sendResponse({ dataUrl }),
            () => sendResponse({ dataUrl: null })
        );
        return true;
    }
    if (request.type !== "solveAll") return;
    chrome.storage.local
        .get("apiKey")
        .then(({ apiKey }) => HBSolver.solveAll(request.questions, apiKey))
        .then(
            (answers) => sendResponse({ answers }),
            (err) => sendResponse({ error: err.message || String(err) })
        );
    return true; // keep the channel open for the async response
});
