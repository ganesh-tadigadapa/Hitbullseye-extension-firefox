// The popup may inject this script again into a tab that already has it, so only set up once
if (!globalThis.__hbAutomateLoaded) {
    globalThis.__hbAutomateLoaded = true;

    let running = false;
    let runId = 0; // bumped on every start, so a stopped run that's still sleeping can't keep going

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

    const MAX_IMAGES = 12; // per question
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

    const VULGAR_FRACTIONS = {
        "½": "1/2", "⅓": "1/3", "⅔": "2/3", "¼": "1/4", "¾": "3/4", "⅕": "1/5", "⅖": "2/5", "⅗": "3/5", "⅘": "4/5",
        "⅙": "1/6", "⅚": "5/6", "⅐": "1/7", "⅛": "1/8", "⅜": "3/8", "⅝": "5/8", "⅞": "7/8", "⅑": "1/9", "⅒": "1/10",
    };
    const SUPERSCRIPT_DIGITS = "⁰¹²³⁴⁵⁶⁷⁸⁹";
    const SUBSCRIPT_DIGITS = "₀₁₂₃₄₅₆₇₈₉";
    const plainDigits = (s, set) => [...s].map((ch) => set.indexOf(ch)).join("");

    // Plain-text math the page may use: "2⅓" -> "2 1/3", "¹⁄₃" -> "1/3", fraction slash -> "/",
    // TeX "2\frac{1}{3}" -> "2 1/3"
    function normalizeMath(text) {
        return text
            .replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (_, a, b) => fraction(a, b))
            .replace(/(\d?)\s*([½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅐⅛⅜⅝⅞⅑⅒])/g, (_, whole, f) => (whole ? `${whole} ` : " ") + VULGAR_FRACTIONS[f])
            .replace(/([⁰¹²³⁴⁵⁶⁷⁸⁹]+)\s*[⁄/]\s*([₀₁₂₃₄₅₆₇₈₉]+)/g, (_, a, b) =>
                ` ${plainDigits(a, SUPERSCRIPT_DIGITS)}/${plainDigits(b, SUBSCRIPT_DIGITS)}`
            )
            .replace(/⁄/g, "/");
    }

    // A fraction as text: " 2/7 ", or " (x+1)/(x-1) " when a part is more than one number or word, so that
    // a whole number right before it reads as a mixed fraction ("5 2/7") rather than a multiplication
    const fraction = (a, b) => {
        const wrap = (p) => (/^[\w.]+$/.test(p.trim()) ? p.trim() : `(${p.trim()})`);
        return ` ${wrap(a)}/${wrap(b)} `;
    };

    // MathML (also what MathJax 3 keeps for screen readers) as plain text
    function mathToText(node) {
        const kids = [...node.children];
        const t = (n) => (n ? mathToText(n) : "");
        switch (node.localName) {
            case "mfrac": return fraction(t(kids[0]), t(kids[1]));
            case "msqrt": return `sqrt(${kids.map(t).join("")})`;
            case "mroot": return `root${t(kids[1])}(${t(kids[0])})`;
            case "msup": return `${t(kids[0])}^(${t(kids[1])})`;
            case "msub": return `${t(kids[0])}_(${t(kids[1])})`;
            case "annotation": case "annotation-xml": return "";
            case "semantics": return t(kids[0]);
            default: return kids.length ? kids.map(t).join("") : node.textContent;
        }
    }

    // Text of an element with math kept readable: 180<sup>0</sup> -> "180^0" instead of "1800",
    // 2<sup>1</sup>/<sub>3</sub> -> "2 1/3" (a mixed fraction), stacked fractions -> "a/b", and images
    // either as their alt text or as "[image N]" when `imageIndex` says image N is attached for that <img>
    function readableText(el, imageIndex = []) {
        if (!el.querySelector || !el.querySelector("sup, sub, math, img, table, [class*=frac], script[type^='math/tex']")) {
            return normalizeMath(el.innerText || el.textContent);
        }
        const copy = el.cloneNode(true);
        // MathJax 2 keeps the TeX source in a script tag next to the rendered copy: use the source
        copy.querySelectorAll("script[type^='math/tex']").forEach((n) => n.replaceWith(` ${n.textContent} `));
        copy.querySelectorAll(".MathJax_Preview, .MathJax, .MathJax_Display, .MathJax_SVG, .MathJax_CHTML").forEach((n) => n.remove());
        copy.querySelectorAll("mjx-container").forEach((n) => {
            const math = n.querySelector("math");
            n.replaceWith(math ? ` ${mathToText(math)} ` : n.textContent);
        });
        copy.querySelectorAll("math").forEach((n) => n.replaceWith(` ${mathToText(n)} `));
        // Fractions built from elements: <span class="frac"><span>1</span><span>3</span></span>
        copy.querySelectorAll("[class*=frac]").forEach((n) => {
            const parts = [...n.children].filter((c) => c.textContent.trim() && !/^[/⁄]$/.test(c.textContent.trim()));
            if (parts.length === 2 && parts.every((c) => c.textContent.trim().length <= 20)) n.replaceWith(fraction(parts[0].textContent, parts[1].textContent));
        });
        // Fractions laid out as a two-row, one-column table (numerator over denominator)
        copy.querySelectorAll("table").forEach((n) => {
            const rows = [...n.rows];
            if (!n.querySelector("input, img") && rows.length === 2 && rows.every((r) => r.cells.length === 1 && r.textContent.trim().length <= 20)) {
                n.replaceWith(fraction(rows[0].textContent, rows[1].textContent));
            }
        });
        const imgs = [...copy.querySelectorAll("img")];
        imgs.forEach((n, k) => {
            const alt = (n.getAttribute("alt") || n.getAttribute("title") || "").trim();
            if (imageIndex[k] !== undefined) n.replaceWith(` [image ${imageIndex[k] + 1}${alt ? `: ${alt}` : ""}] `);
            else if (alt && !/^(image|img|pic|photo)?\s*\d*$/i.test(alt)) n.replaceWith(` ${alt} `);
        });
        // Mixed/simple fractions written with sup and sub: 2<sup>1</sup>/<sub>3</sub> -> "2 1/3"
        copy.querySelectorAll("sup").forEach((n) => n.replaceWith(`^{${n.textContent.trim()}}`));
        copy.querySelectorAll("sub").forEach((n) => n.replaceWith(`_{${n.textContent.trim()}}`));
        let text = copy.textContent.replace(/\^\{([^}]*)\}\s*[/⁄]?\s*_\{([^}]*)\}/g, " $1/$2");
        text = text.replace(/\^\{([^}]*)\}/g, (_, p) => (/^\w+$/.test(p) ? `^${p}` : `^(${p})`));
        text = text.replace(/_\{([^}]*)\}/g, (_, p) => (/^\w+$/.test(p) ? `_${p}` : `_(${p})`));
        return normalizeMath(text);
    }

    // `imagesOf(el)` gives the attached-image number for each <img> inside el, so an option shown as a
    // picture (often a fraction) reads "[image N]" and the AI can look at it instead of seeing nothing
    function optionText(radio, name, imagesOf = () => []) {
        const read = (el) => clean(readableText(el, imagesOf(el)));
        if (radio.id) {
            const label = document.querySelector(`label[for="${CSS.escape(radio.id)}"]`);
            if (label && read(label)) return read(label);
        }

        // Largest ancestor that holds only this one option (e.g. the option's row)
        let el = radio;
        while (el.parentElement && el.parentElement.querySelectorAll(`input[type="radio"][name="${name}"]`).length === 1) {
            el = el.parentElement;
        }
        if (read(el)) return read(el);

        // Options laid out as "<input> text <br> <input> text ..." in one container
        let text = "";
        for (let node = radio.nextSibling; node; node = node.nextSibling) {
            if (node.nodeName === "INPUT" || node.nodeName === "BR") break;
            if (node.nodeName === "IMG") {
                const [k] = imagesOf(node);
                text += k !== undefined ? ` [image ${k + 1}] ` : ` ${node.alt || ""} `;
            } else text += node.nodeType === Node.ELEMENT_NODE ? readableText(node, imagesOf(node)) : node.textContent;
        }
        return clean(text) || radio.value;
    }

    function imageToDataUrl(img) {
        try {
            // Small images are kept too: tests often show fractions and formulas as little inline pictures
            if (!img.complete || img.naturalWidth < 8 || img.naturalHeight < 8) return null;
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

        // Largest ancestor that contains this question's inputs but no other question's
        const hasOtherQuestion = (el) =>
            [...el.querySelectorAll(`input[type="radio"], ${ANSWER_BOX}`)].some((r) => !inputs.includes(r));
        let block = inputs[0].parentElement;
        while (!inputs.every((r) => block.contains(r))) block = block.parentElement;
        while (block.parentElement && block.parentElement !== document.body && !hasOtherQuestion(block.parentElement)) {
            block = block.parentElement;
        }

        // Images are attached after the question, and "[image N]" in the text marks where each one sits
        const images = [];
        const blockImages = [...block.querySelectorAll("img")];
        const imageIndex = blockImages.map((img) => {
            const dataUrl = images.length < MAX_IMAGES ? imageToDataUrl(img) : null;
            return dataUrl ? images.push(dataUrl) - 1 : undefined;
        });
        const imagesOf = (el) =>
            (el.nodeName === "IMG" ? [el] : [...el.querySelectorAll("img")]).map((img) => imageIndex[blockImages.indexOf(img)]);
        const options = target.kind === "mcq" ? target.radios.map((r) => optionText(r, name, imagesOf)) : [];
        return { text: clean(readableText(block, imageIndex)).slice(0, 8000), options, images };
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

    // Solves questions (split into parallel requests); returns an option index (or null) per question
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
        const id = ++runId;
        running = true;
        const active = () => running && id === runId;
        const delay = Math.max(time || 1, 0.3) * 1000;
        const total = countQuestions();
        let answers = {}; // question number -> option index, option letter (from a key) or number string
        const asked = new Set(); // questions already sent to the AI, so the loop below doesn't ask again

        if (key) {
            answers = parseKey(key, total);
            toast("Started attempting the test");
        } else {
            // Send every question on the page up front, split into a few requests that run at the same time
            const present = [];
            for (let i = 1; i <= total; i++) {
                const target = targetFor(i);
                if (target) present.push([i, target]);
            }
            toast(`Solving ${present.length} questions...`);
            const solveInto = async (list) => {
                const result = await solveQuestions(list.map(([i, target]) => extractQuestion(i, target)));
                list.forEach(([i], n) => {
                    asked.add(i);
                    if (result[n] !== null && result[n] !== undefined) answers[i] = result[n];
                });
            };
            try {
                await solveInto(present);
                if (HBSolver.lastModel()) toast(`Solved with ${HBSolver.lastModel()}`);
                // Questions the AI skipped get one more try, all together in a single request
                const skipped = present.filter(([i]) => answers[i] === undefined);
                if (skipped.length && active()) {
                    toast(`Retrying ${skipped.length} unanswered question(s) in one request...`);
                    await solveInto(skipped).catch((err) => toast(err.message, "error"));
                }
            } catch (err) {
                if (active()) {
                    toast(err.message, "error");
                    running = false;
                }
                return;
            }
            if (!active()) return;
        }

        let answered = 0;
        for (let i = 1; i <= total && active(); i++) {
            const target = await waitFor(() => targetFor(i), 5000);
            if (!target) {
                toast(`Q${i}: not found, skipped`, "error");
                clickSaveNext();
                await sleep(delay);
                continue;
            }
            try {
                // Questions that only appear after navigating get solved one at a time
                if (answers[i] === undefined && !key && !asked.has(i)) {
                    asked.add(i);
                    const [answer] = await solveQuestions([extractQuestion(i, target)]);
                    if (answer !== null) answers[i] = answer;
                }
                if (!active()) break;
                toast(`Q${i}: ${applyAnswer(i, target, answers[i])}`);
                answered++;
            } catch (err) {
                toast(`Q${i}: ${err.message}`, "error");
            }
            clickSaveNext();
            await sleep(delay);
        }

        if (!active()) return;
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
