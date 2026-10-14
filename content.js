// The popup may inject this script again into a tab that already has it, so only set up once
if (!globalThis.__hbAutomateLoaded) {
    globalThis.__hbAutomateLoaded = true;

    let running = false;

    chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
        if (request.message === "ping") {
            sendResponse({ ok: true });
            return;
        }
        if (!window.location.href.includes("onlinetest.hitbullseye.com/online_load")) {
            toast("Please open the test page", "error");
            sendResponse({ error: "This isn't a test page. Open a test first." });
            return;
        }

        if (request.message === "extract") {
            sendResponse(exportQuestions());
        } else if (request.message === "start") {
            if (running) {
                sendResponse({ error: "Already running" });
                return;
            }
            const total = countQuestions();
            if (!total) {
                sendResponse({ error: "No questions found on this page" });
                return;
            }
            attempt(request.answer_key, Number(request.time), request.auto_submit);
            sendResponse({ ok: true, total });
        } else if (request.message === "stop") {
            if (running) {
                running = false;
                toast("Stopped attempting the test");
            }
            sendResponse({ ok: true });
        }
    });

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
    const radiosFor = (i) => [...document.querySelectorAll(`input[type="radio"][name="radio_${i}"]`)];

    const ANSWER_BOX = 'input:not([type]), input[type="text"], input[type="number"], input[type="tel"], textarea';

    function currentQuestionNumber() {
        const m = (document.body.innerText || document.body.textContent).match(/Question No\.?\s*:?\s*(\d+)/i);
        return m ? parseInt(m[1], 10) : null;
    }

    // Answer box for a numerical (type-in) question: one named after the question number,
    // or else the visible box in the test area while that question is on screen
    function answerBoxFor(i) {
        const boxes = [...document.querySelectorAll(ANSWER_BOX)].filter((el) => !el.disabled);
        const named = boxes.find((el) => new RegExp(`(^|\\D)${i}$`).test(el.name || el.id || ""));
        if (named) return named;
        if (currentQuestionNumber() !== i) return null;
        const area = document.querySelector(".onlineTestLeftDiv") || document.getElementById("main_div") || document.body;
        const visible = boxes.filter((el) => area.contains(el) && el.offsetParent !== null);
        return visible[0] || null;
    }

    // What to answer for question i: its option radios, or its numerical answer box
    function targetFor(i) {
        const radios = radiosFor(i);
        if (radios.length) return { kind: "mcq", radios };
        const box = answerBoxFor(i);
        return box ? { kind: "numeric", box } : null;
    }

    // Sets an input's value the way typing would, so the page's own listeners notice it
    function fillBox(box, value) {
        const proto = box instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value").set.call(box, value);
        for (const type of ["input", "keyup", "change"]) box.dispatchEvent(new Event(type, { bubbles: true }));
    }

    async function waitFor(fn, timeout) {
        const end = Date.now() + timeout;
        while (Date.now() < end) {
            const result = fn();
            if (result) return result;
            await sleep(200);
        }
        return null;
    }

    function countQuestions() {
        let max = 0;
        document.querySelectorAll('input[type="radio"][name^="radio_"]').forEach((r) => {
            const n = parseInt(r.name.slice("radio_".length), 10);
            if (n > max) max = n;
        });
        const total = (document.body.innerText || document.body.textContent).match(/Total Questions\s*:\s*(\d+)/i);
        return Math.max(max, total ? parseInt(total[1], 10) : 0);
    }

    // Text of an element with superscripts/subscripts kept readable: 180<sup>0</sup> -> "180^0" instead of "1800"
    function readableText(el) {
        if (!el.querySelector || !el.querySelector("sup, sub")) return el.innerText || el.textContent;
        const copy = el.cloneNode(true);
        copy.querySelectorAll("sup").forEach((n) => n.replaceWith(`^${n.textContent}`));
        copy.querySelectorAll("sub").forEach((n) => n.replaceWith(`_${n.textContent}`));
        return copy.textContent;
    }

    function optionText(radio, name) {
        if (radio.id) {
            const label = document.querySelector(`label[for="${CSS.escape(radio.id)}"]`);
            if (label && clean(label.textContent)) return clean(readableText(label));
        }

        // Largest ancestor that holds only this one option (e.g. the option's row)
        let el = radio;
        while (el.parentElement && el.parentElement.querySelectorAll(`input[type="radio"][name="${name}"]`).length === 1) {
            el = el.parentElement;
        }
        if (clean(el.textContent)) return clean(readableText(el));

        // Options laid out as "<input> text <br> <input> text ..." in one container
        let text = "";
        for (let node = radio.nextSibling; node; node = node.nextSibling) {
            if (node.nodeName === "INPUT" || node.nodeName === "BR") break;
            text += node.textContent;
        }
        return clean(text) || radio.value;
    }

    function imageToDataUrl(img) {
        try {
            if (!img.complete || img.naturalWidth < 40 || img.naturalHeight < 20) return null;
            const canvas = document.createElement("canvas");
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            canvas.getContext("2d").drawImage(img, 0, 0);
            return canvas.toDataURL("image/png");
        } catch {
            return null; // cross-origin image, can't read it
        }
    }

    function extractQuestion(i, target = targetFor(i)) {
        const name = `radio_${i}`;
        const inputs = target.kind === "mcq" ? target.radios : [target.box];
        const options = target.kind === "mcq" ? target.radios.map((r) => optionText(r, name)) : [];

        // Largest ancestor that contains this question's inputs but no other question's
        const hasOtherQuestion = (el) =>
            [...el.querySelectorAll(`input[type="radio"], ${ANSWER_BOX}`)].some((r) => !inputs.includes(r));
        let block = inputs[0].parentElement;
        while (!inputs.every((r) => block.contains(r))) block = block.parentElement;
        while (block.parentElement && block.parentElement !== document.body && !hasOtherQuestion(block.parentElement)) {
            block = block.parentElement;
        }

        const images = [...block.querySelectorAll("img")].map(imageToDataUrl).filter(Boolean).slice(0, 4);
        return { text: clean(readableText(block)).slice(0, 8000), options, images };
    }

    function exportQuestions() {
        const total = countQuestions();
        const parts = [];
        let missing = 0;
        for (let i = 1; i <= total; i++) {
            const target = targetFor(i);
            if (!target) {
                missing++;
                continue;
            }
            const q = extractQuestion(i, target);
            const diagram = q.images.length ? " [has a diagram, not included]" : "";
            if (target.kind === "mcq") {
                const options = q.options.map((opt, j) => `${String.fromCharCode(65 + j)}) ${opt}`).join("\n");
                parts.push(`Q${i}${diagram}\n${q.text}\nOptions:\n${options}`);
            } else {
                parts.push(`Q${i} (numerical answer, type a number)${diagram}\n${q.text}`);
            }
        }
        if (!parts.length) return { error: "No questions found on this page" };
        const text =
            `Solve these ${parts.length} questions. Work each one out, then end your reply with the answers ` +
            `as one line, e.g. 1=B, 2=D, 3=42.5 (a letter for multiple-choice, a plain number for numerical answers)\n\n` +
            parts.join("\n\n");
        return { text, count: parts.length, missing };
    }

    // The background script may still be starting up, so retry a few times before giving up
    async function askBackground(payload) {
        for (let attempt = 0; ; attempt++) {
            try {
                const response = await chrome.runtime.sendMessage(payload);
                if (!response) throw new Error("no response from extension");
                if (response.error) throw new Error(response.error);
                return response.answers;
            } catch (err) {
                if (!/receiving end does not exist|could not establish connection/i.test(err.message) || attempt >= 4) throw err;
                await sleep(1000 * (attempt + 1));
            }
        }
    }

    // Solves questions in one request; returns an option index (or null) per question
    async function solveQuestions(questions) {
        const { apiKey } = await chrome.storage.local.get("apiKey");
        try {
            return await HBSolver.solveAll(questions, apiKey);
        } catch (err) {
            // TypeError means the request itself was blocked (CORS / page CSP), so let the background script make it
            if (!(err instanceof TypeError)) throw err;
            return askBackground({ type: "solveAll", questions });
        }
    }

    function findByText(selector, pattern) {
        return [...document.querySelectorAll(selector)].find((el) => pattern.test(clean(el.textContent || el.value)));
    }

    function clickSaveNext() {
        const btn =
            document.querySelector("#main_div > div.tableWidthPercent > div.onlineTestLeftDiv > div.qnav > span.saveNextButton > a") ||
            findByText("a, button, input[type=button], input[type=submit]", /save\s*&\s*next/i);
        if (btn) btn.click();
    }

    async function submitTest() {
        const submit = document.querySelector("#activator") || findByText("a, button, input[type=button]", /submit test/i);
        if (!submit) return;
        submit.click();
        const confirm = await waitFor(() => document.querySelector('input[name="rd"][value="Y"]'), 3000);
        if (confirm) confirm.click();
    }

    // Answer key from the popup: letters for multiple-choice ("ABCD") or, when it contains
    // numbers, "1=B, 2=D, 3=42.5" style entries
    function parseKey(key, total) {
        const answers = {};
        if (/=/.test(key)) {
            for (const [, n, value] of key.matchAll(/(\d+)=(-?[\d.]+|[A-Z])/gi)) answers[n] = value.toUpperCase();
        } else {
            for (let i = 1; i <= total; i++) if (key[i - 1]) answers[i] = key[i - 1].toUpperCase();
        }
        return answers;
    }

    function applyAnswer(i, target, answer) {
        if (target.kind === "mcq") {
            const index = typeof answer === "string" && /^[A-Z]$/.test(answer) ? answer.charCodeAt(0) - 65 : answer;
            const radio = target.radios[index];
            if (typeof index !== "number" || !radio) throw new Error("no valid answer, skipped");
            radio.click();
            return String.fromCharCode(65 + index);
        }
        if (answer === undefined || answer === null || !/^-?\d*\.?\d+$/.test(String(answer))) {
            throw new Error("no valid number, skipped");
        }
        fillBox(target.box, String(answer));
        return String(answer);
    }

    const attempt = async (key, time, autoSubmit) => {
        running = true;
        const delay = Math.max(time || 1, 0.3) * 1000;
        const total = countQuestions();
        let answers = {}; // question number -> option index, option letter (from a key) or number string

        if (key) {
            answers = parseKey(key, total);
            toast("Started attempting the test");
        } else {
            // Send every question on the page in one request, so a whole test uses one API call
            const present = [];
            for (let i = 1; i <= total; i++) {
                const target = targetFor(i);
                if (target) present.push([i, target]);
            }
            toast(`Solving ${present.length} questions... (can take up to a minute)`);
            try {
                const result = await solveQuestions(present.map(([i, target]) => extractQuestion(i, target)));
                if (HBSolver.lastModel()) toast(`Solved with ${HBSolver.lastModel()}`);
                present.forEach(([i], n) => {
                    if (result[n] !== null && result[n] !== undefined) answers[i] = result[n];
                });
            } catch (err) {
                toast(err.message, "error");
                running = false;
                return;
            }
            if (!running) return;
        }

        let answered = 0;
        for (let i = 1; i <= total && running; i++) {
            const target = await waitFor(() => targetFor(i), 5000);
            if (!target) {
                toast(`Q${i}: not found, skipped`, "error");
                clickSaveNext();
                await sleep(delay);
                continue;
            }
            try {
                // Questions that only appear after navigating get solved one at a time
                if (answers[i] === undefined && !key) {
                    const [answer] = await solveQuestions([extractQuestion(i, target)]);
                    if (answer !== null) answers[i] = answer;
                }
                if (!running) break;
                toast(`Q${i}: ${applyAnswer(i, target, answers[i])}`);
                answered++;
            } catch (err) {
                toast(`Q${i}: ${err.message}`, "error");
            }
            clickSaveNext();
            await sleep(delay);
        }

        if (!running) return;
        running = false;
        toast(`Finished: answered ${answered} of ${total}`);
        if (autoSubmit && answered === total) {
            await sleep(1000);
            await submitTest();
        } else if (autoSubmit) {
            toast("Not submitting: some questions were skipped", "error");
        }
    };

}
