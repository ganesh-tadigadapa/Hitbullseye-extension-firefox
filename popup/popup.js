document.addEventListener('DOMContentLoaded', function () {
    const start = document.getElementById("start");
    const stop = document.getElementById("stop");
    const time = document.getElementById("time");
    const ans_key = document.getElementById("test_answer_key");
    const api_key = document.getElementById("api_key");
    const test_key = document.getElementById("test_key");
    const auto_submit = document.getElementById("auto_submit");
    const copy = document.getElementById("copy_questions");
    const time_value = document.getElementById("time_value");
    time_value.innerText = time.value + "s";

    chrome.storage.local.get(["apiKey", "autoSubmit"]).then(({ apiKey, autoSubmit }) => {
        if (apiKey) api_key.value = apiKey;
        if (autoSubmit !== undefined) auto_submit.checked = autoSubmit;
    });

    api_key.addEventListener("input", function () {
        const key = api_key.value.trim();
        let valid = true;
        try {
            if (key) HBSolver.checkKey(key);
        } catch {
            valid = false;
        }
        api_key.classList.toggle("invalid", !valid);
        chrome.storage.local.set({ apiKey: key });
    });

    document.getElementById("toggle_key").addEventListener("click", function () {
        api_key.type = api_key.type === "password" ? "text" : "password";
    });

    test_key.addEventListener("click", async function () {
        status("Testing key...");
        test_key.disabled = true;
        try {
            const provider = await HBSolver.testKey(api_key.value.trim());
            status(`Key works ✅ (${provider})`, "ok");
        } catch (err) {
            status(err.message, "error");
        } finally {
            test_key.disabled = false;
        }
    });

    auto_submit.addEventListener("change", function () {
        chrome.storage.local.set({ autoSubmit: auto_submit.checked });
    });

    time.addEventListener("input", function () {
        time_value.innerText = time.value + "s";
    });

    start.addEventListener("click", async function () {
        start.disabled = true;
        const res = await sendToPage({
            message: "start",
            answer_key: ans_key.value,
            time: time.value,
            auto_submit: auto_submit.checked,
        });
        if (res.error) {
            status(res.error, "error");
            start.disabled = false;
        } else {
            status(`Running on ${res.total} questions. Watch the bottom-left of the test page.`, "ok");
        }
    });

    ans_key.addEventListener("input", function () {
        // Plain letters ("ABCD") or numbered answers ("1=B,2=D,3=42.5") for numerical questions
        ans_key.value = ans_key.value.toUpperCase().replace(/\s/g, "");
        start.disabled = false;
    });

    stop.addEventListener("click", async function () {
        await sendToPage({ message: "stop" });
        status("Stopped");
        start.disabled = false;
    });

    copy.addEventListener("click", async function () {
        const res = await sendToPage({ message: "extract" });
        if (res.error) {
            status(res.error, "error");
            return;
        }
        await navigator.clipboard.writeText(res.text);
        status(`Copied ${res.count} questions` + (res.missing ? ` (${res.missing} not found)` : ""), "ok");
    });
});

function status(text, type = "") {
    const el = document.getElementById("status");
    el.textContent = text;
    el.className = `status ${type}`;
    el.hidden = !text;
}

// Sends a message to the test page, loading the content script into the tab first if it
// isn't there (e.g. the tab was opened before the extension was reloaded), so no refresh is needed
async function sendToPage(payload) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !/^https:\/\/[^/]*hitbullseye\.com\//.test(tab.url || "")) {
        return { error: "Open the Hitbullseye test tab first, then click the extension." };
    }
    try {
        await chrome.tabs.sendMessage(tab.id, { message: "ping" });
    } catch {
        try {
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ["solver.js", "toast.js", "content.js"],
            });
        } catch (err) {
            return { error: `Couldn't load into the page: ${err.message}` };
        }
    }
    try {
        return (await chrome.tabs.sendMessage(tab.id, payload)) || { error: "No response from the page" };
    } catch (err) {
        return { error: `Couldn't reach the page: ${err.message}` };
    }
}
