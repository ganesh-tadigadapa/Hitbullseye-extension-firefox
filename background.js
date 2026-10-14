// Chrome runs this file as a service worker; Firefox loads solver.js first via manifest "scripts"
if (typeof importScripts === "function" && !globalThis.HBSolver) importScripts("solver.js");

// Older versions tracked used-up models for all keys together; that record is no longer used
chrome.storage.local.remove("geminiExhausted");

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
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
