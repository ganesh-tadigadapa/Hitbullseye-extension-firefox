// Shared by the background script, the content script and the popup.
// Sends multiple-choice questions to Gemini or Claude and returns the chosen option index for each.
globalThis.HBSolver = globalThis.HBSolver || (() => {
    const CLAUDE_MODEL = "claude-opus-5-5";
    // Each Gemini model has its own free-tier daily quota, so when one runs out we move to the next.
    // Fastest first, by measured speed on a 17-question aptitude set (all of these scored 17/17):
    // 3.6-flash 17s, 3-flash-preview 21s, 3.5-flash 28s. gemini-3.8-flash scored the same but took
    // about 4 minutes (and often doesn't answer at all), so it's the very last resort, after the lite
    // models (3.5-flash-lite answered 10 questions in about 1s). gemini-3.7-flash is left out: Google
    // serves it with 3.8. Pro/Argon models have no free quota. Ones this key can't use fail fast and are remembered.
    const GEMINI_MODELS = [
        "gemini-3.6-flash",
        "gemini-3-flash-preview",
        "gemini-3.5-flash",
        "gemini-2.5-flash",
        "gemini-3.5-flash-lite",
        "gemini-3.1-flash-lite",
        "gemini-2.5-flash-lite",
        "gemini-3.8-flash",
    ];

    const SYSTEM_PROMPT = `You solve multiple-choice aptitude questions (quant, reasoning, verbal, clocks, calendars, etc.) from an online practice test.
The question text was scraped from a web page, so it may include stray page text; ignore anything that is not part of the question.
Work each problem carefully and check your result against its options. Return one answer letter per question, in the same order as the questions.
Notation used in the scraped text:
- "^" marks a superscript from the page: 180^0 means 180 degrees, 21^st means 21st, x^2 means x squared.
- A whole number followed by a space and a fraction is a mixed fraction: "2 1/3" means 2 + 1/3 = 7/3, never 2 x 1/3. Options are often mixed fractions too, so compare exact values.
- "\\frac{a}{b}" is TeX for a/b; "sqrt(x)" is the square root of x.
- "[image N]" marks where attached image N (a figure, formula or fraction shown as a picture) appears in the question.`;

    // Gemini Flash reasons internally before replying, so the reply itself only needs the answers:
    // asking it to also write out its working makes the response several times longer (and slower)
    const GEMINI_INSTRUCTIONS = `For each question: solve it carefully in your reasoning, and verify the result a second way (plug the answer back in, recount, or use a different method) before choosing. If your result matches no option exactly, pick "None of these" when it is offered, otherwise the closest option.
Questions marked "numerical answer" have no options: work out the number and give it as a plain number (digits, optional minus sign and decimal point; no units, no commas; convert a fraction or mixed fraction to a decimal; round to 2 decimal places only if the question doesn't say otherwise).
Do not write out your working. Reply with only this one line (letters for multiple-choice, numbers for numerical answers):
ANSWERS: 1=B, 2=D, 3=42.5`;

    // If the current model hasn't answered by then, ask the next one too: 12s plus 2s per question.
    // A healthy model takes about 1-2s per question, and the free tier allows only ~20 requests a day
    // per model, so the backup should only start when the first model is clearly stuck.
    const backupAfterMs = (count) => 12000 + 2000 * count;

    // A request's time grows with its number of questions, so a big test is split into up to MAX_PARALLEL
    // requests sent at once. Each request counts against the free tier's 20 a day per model, so chunks
    // hold at least MIN_CHUNK questions: a 20-question test costs 2 requests, not 1 per few questions.
    const MAX_PARALLEL = 3;
    const MIN_CHUNK = 10;
    const SLOW_SKIP_MS = 30 * 60000; // a model that lost that race is skipped for 30 minutes

    class RetryableError extends Error {}
    class QuotaError extends Error {}

    function checkKey(apiKey) {
        if (!apiKey) throw new Error("Set your Gemini or Anthropic API key in the extension popup");
        if (apiKey.length > 200 || !/^[\x21-\x7e]+$/.test(apiKey)) {
            throw new Error("The API key box contains something that isn't a key. Clear it and paste only your key.");
        }
    }

    // Short rate limits (too many requests per minute) clear quickly, so wait and retry. When Google says how
    // long to wait ("retry in 33s"), wait that long: retrying sooner only hits the same limit again.
    async function withRetry(fn, maxRetries) {
        for (let attempt = 0; ; attempt++) {
            try {
                return await fn(attempt);
            } catch (err) {
                if (!(err instanceof RetryableError) || attempt >= maxRetries) throw err;
                const wait = err.wait ? Math.min(err.wait + 1000, 65000) : 5000 * 2 ** attempt;
                await new Promise((r) => setTimeout(r, wait));
            }
        }
    }

    // Free-tier daily limits reset at midnight Pacific time
    function msUntilQuotaReset() {
        const now = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
        const midnight = new Date(now);
        midnight.setHours(24, 0, 0, 0);
        return midnight - now + 60000;
    }

    async function checkResponse(res) {
        if (res.ok) return res.json();
        const body = await res.text();
        let detail = body.slice(0, 300);
        try {
            detail = JSON.parse(body).error.message || detail;
        } catch {}
        const error = `API error ${res.status}: ${detail}`;
        if (res.status === 429) {
            const wait = parseRetryDelay(body);
            // No quota at all for this model ("limit: 0"): skip it for a day
            if (/limit: 0\b/.test(body)) throw Object.assign(new QuotaError(error), { wait: 24 * 3600000 });
            // Daily limit used up (quota id "...PerDay...", or a wait of hours): skip it until the daily reset
            if (/PerDay/i.test(body) || wait > 120000) {
                throw Object.assign(new QuotaError(error), { wait: Math.max(wait, msUntilQuotaReset()) });
            }
            // Per-minute limit: it clears soon, so wait as long as Google says
            throw Object.assign(new RetryableError(error), { wait });
        }
        if (res.status >= 500) throw new RetryableError(error);
        throw Object.assign(new Error(error), { status: res.status });
    }

    function parseRetryDelay(text) {
        const delay = text.match(/"retryDelay"\s*:\s*"([\d.]+)s"/);
        if (delay) return parseFloat(delay[1]) * 1000;
        const m = text.match(/retry in ((?:[\d.]+h)?(?:[\d.]+m(?!s))?(?:[\d.]+s)?)/i);
        if (!m) return 0;
        const part = (unit) => parseFloat((m[1].match(new RegExp(`([\\d.]+)${unit}`)) || [0, 0])[1]);
        return (part("h") * 3600 + part("m(?!s)") * 60 + part("s")) * 1000;
    }

    // Remembers which Gemini models are out of quota so we don't keep asking them.
    // Quota belongs to the key's project, so this is tracked per key.
    function storageKeyFor(apiKey) {
        let hash = 5381;
        for (const ch of apiKey) hash = ((hash * 33) ^ ch.charCodeAt(0)) >>> 0;
        return `geminiExhausted_${hash.toString(36)}`;
    }

    async function exhaustedModels(apiKey) {
        try {
            const key = storageKeyFor(apiKey);
            return (await chrome.storage.local.get(key))[key] || {};
        } catch {
            return {};
        }
    }

    // Parallel requests can mark models at the same moment, so updates run one after another
    let marking = Promise.resolve();
    function markExhausted(apiKey, model, wait) {
        marking = marking.then(async () => {
            try {
                const exhausted = await exhaustedModels(apiKey);
                exhausted[model] = Date.now() + (wait || 24 * 3600000);
                await chrome.storage.local.set({ [storageKeyFor(apiKey)]: exhausted });
            } catch {}
        });
        return marking;
    }

    let lastModel = null;

    // Reads "ANSWERS: 1=B, 2=D, 3=42.5" (the last such line) into ["B", "D", "42.5"]
    function parseAnswerLine(text, count) {
        const lines = text.split("\n").filter((l) => /ANSWERS\s*:/i.test(l));
        if (!lines.length) return null;
        const answers = new Array(count).fill(null);
        const line = lines[lines.length - 1].replace(/^.*?ANSWERS\s*:/i, "");
        for (const [, n, value] of line.matchAll(/(\d+)\s*=\s*\(?(-?\d*\.?\d+(?:\s+\d+\s*\/\s*\d+|\s*\/\s*\d+)?|[A-Z])\b\)?/gi)) {
            if (n >= 1 && n <= count) answers[n - 1] = value.toUpperCase();
        }
        return answers.some(Boolean) ? answers : null;
    }

    function answerSchema(maxLetters, count) {
        return { letters: Array.from({ length: maxLetters }, (_, i) => String.fromCharCode(65 + i)), count };
    }

    // One request to one Gemini model; resolves to the answers or throws (classified by checkResponse)
    async function callGemini(apiKey, model, parts, schema, signal) {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
            method: "POST",
            signal: AbortSignal.any([signal, AbortSignal.timeout(300000)]),
            headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
            body: JSON.stringify({
                systemInstruction: { parts: [{ text: SYSTEM_PROMPT + "\n\n" + GEMINI_INSTRUCTIONS }] },
                contents: [{ role: "user", parts }],
                // Lite models don't think unless asked: on 20 aptitude questions 3.5-flash-lite scored 17/20
                // without thinking and 20/20 with it. Gemini 2.5 models take a different setting, so they keep theirs.
                generationConfig: {
                    maxOutputTokens: 32768,
                    ...(model.startsWith("gemini-2") ? {} : { thinkingConfig: { thinkingLevel: "high" } }),
                },
            }),
        });
        const data = await checkResponse(res);
        const text = (data.candidates?.[0]?.content?.parts || [])
            .filter((p) => p.text && !p.thought)
            .map((p) => p.text)
            .join("");
        const answers = parseAnswerLine(text, schema.count);
        if (!answers) {
            const reason = data.candidates?.[0]?.finishReason || data.promptFeedback?.blockReason || "no ANSWERS line";
            throw new Error(`Gemini didn't return answers (${reason})`);
        }
        return answers;
    }

    // Asks the first available model. If it hasn't answered within backupAfterMs(), the next model
    // is asked too (at most two at once) and whichever answers first wins; a model that lost the race
    // is skipped for SLOW_SKIP_MS so the next Start goes straight to a fast model with a single request.
    async function askGemini(apiKey, parts, schema, allowLite) {
        const exhausted = await exhaustedModels(apiKey);
        const models = GEMINI_MODELS.filter((m) => !(exhausted[m] > Date.now()));
        if (!models.length) {
            const next = Math.min(...GEMINI_MODELS.map((m) => exhausted[m]));
            const mins = Math.ceil((next - Date.now()) / 60000);
            throw new Error(`Every Gemini model is used up or too slow right now. Try again in ~${mins} min.`);
        }

        // Flash-lite models are less accurate, so they're only used once every stronger model is used up for
        // the day or unavailable. A stronger one that's busy gets one retry first (`allowLite` is set on
        // retries), since that often clears in seconds, but not more: waiting longer makes Start too slow.
        const isLite = (m) => m.includes("lite");
        const canLaunch = () =>
            next < models.length && inFlight.size < 2 && !(busy && !allowLite && isLite(models[next]));

        const inFlight = new Map(); // model -> { done: promise of {model, answers} or {model, err}, controller }
        let next = 0;
        let lastLaunch = 0;
        const launch = () => {
            const model = models[next++];
            const controller = new AbortController();
            const done = callGemini(apiKey, model, parts, schema, controller.signal).then(
                (answers) => ({ model, answers }),
                (err) => ({ model, err })
            );
            inFlight.set(model, { done, controller });
            lastLaunch = Date.now();
        };
        const stopAll = () => inFlight.forEach(({ controller }) => controller.abort());

        let lastError;
        let busy = false;
        let busyWait = 0; // shortest "retry in" Google gave among the busy models
        launch();
        while (inFlight.size) {
            const waiters = [...inFlight.values()].map(({ done }) => done);
            if (canLaunch()) {
                const wait = Math.max(0, backupAfterMs(schema.count) - (Date.now() - lastLaunch));
                waiters.push(new Promise((r) => setTimeout(() => r(null), wait)));
            }
            const result = await Promise.race(waiters);
            if (!result) {
                launch(); // the current model is slow: ask a backup as well
                continue;
            }
            inFlight.delete(result.model);

            if (result.answers) {
                // A model still running that was asked before the winner was too slow; one asked after it just lost
                for (const model of inFlight.keys()) {
                    if (models.indexOf(model) < models.indexOf(result.model)) await markExhausted(apiKey, model, SLOW_SKIP_MS);
                }
                stopAll();
                lastModel = result.model;
                return result.answers;
            }

            const err = (lastError = result.err);
            if (err instanceof QuotaError) {
                await markExhausted(apiKey, result.model, err.wait);
            } else if (err instanceof RetryableError) {
                // overloaded right now (503) or briefly rate limited
                if (err.wait) busyWait = busy && busyWait ? Math.min(busyWait, err.wait) : err.wait;
                busy = true;
            } else if (err.status === 404) {
                // Model doesn't exist (yet): skip it for a day instead of asking for it on every request
                await markExhausted(apiKey, result.model, 24 * 3600000);
            } else if (err.status !== 403) {
                // 403 = not available for this key, so try the next one; anything else would fail on every model
                stopAll();
                throw err;
            }
            if (canLaunch()) launch();
        }
        if (busy) {
            const error = new RetryableError("Gemini is overloaded right now (all models busy). Wait a minute and try again.");
            throw Object.assign(error, { wait: busyWait });
        }
        if (lastError instanceof QuotaError) {
            throw new Error("Daily free Gemini limit used up on every model. Try again later.");
        }
        throw lastError;
    }

    async function askClaude(apiKey, content, schema) {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            signal: AbortSignal.timeout(600000),
            headers: {
                "content-type": "application/json",
                "x-api-key": apiKey,
                "anthropic-version": "2023-06-01",
                "anthropic-beta": "server-side-fallback-2026-07-01",
                "anthropic-dangerous-direct-browser-access": "true",
            },
            body: JSON.stringify({
                model: CLAUDE_MODEL,
                max_tokens: 32000,
                fallbacks: "default",
                output_config: {
                    effort: "high",
                    format: {
                        type: "json_schema",
                        schema: {
                            type: "object",
                            properties: {
                                answers: {
                                    type: "array",
                                    description: "One per question: the option letter, or for numerical-answer questions the plain number",
                                    items: { type: "string" },
                                },
                            },
                            required: ["answers"],
                            additionalProperties: false,
                        },
                    },
                },
                system: SYSTEM_PROMPT,
                messages: [{ role: "user", content }],
            }),
        });

        const message = await checkResponse(res);
        if (message.stop_reason === "refusal") throw new Error("Claude declined these questions");
        if (message.stop_reason === "max_tokens") throw new Error("Answer was cut off");
        const textBlock = message.content.find((block) => block.type === "text");
        if (!textBlock) throw new Error("Empty response from Claude");
        lastModel = CLAUDE_MODEL;
        return JSON.parse(textBlock.text).answers;
    }

    // A numerical answer as a plain number string: "2 1/3" -> "2.33", "-7/4" -> "-1.75", "42.5 cm" -> "42.5"
    function toNumber(value) {
        const v = value.replace(/,/g, "").trim();
        const mixed = v.match(/^(-?)(\d+)\s+(\d+)\s*\/\s*(\d+)/);
        const simple = v.match(/^(-?\d*\.?\d+)\s*\/\s*(\d*\.?\d+)/);
        let n;
        if (mixed) n = (mixed[1] ? -1 : 1) * (Number(mixed[2]) + Number(mixed[3]) / Number(mixed[4]));
        else if (simple) n = Number(simple[1]) / Number(simple[2]);
        else {
            const plain = v.replace(/[^\d.-]/g, "");
            return /^-?\d*\.?\d+$/.test(plain) ? plain : null;
        }
        return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : null;
    }

    // Answers already worked out, so clicking Start again (or retaking a test) doesn't spend requests on them.
    // Keyed by a hash of the question text, its options in order, and its images.
    const CACHE_KEY = "answerCache";
    const CACHE_MAX = 3000;

    function questionHash(q) {
        const str = [q.text, ...q.options, ...(q.images || [])].join("\u0001");
        let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
        for (let i = 0; i < str.length; i++) {
            const ch = str.charCodeAt(i);
            h1 = Math.imul(h1 ^ ch, 2654435761);
            h2 = Math.imul(h2 ^ ch, 1597334677);
        }
        h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
        h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
        return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
    }

    async function readCache() {
        try {
            return (await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY] || {};
        } catch {
            return {};
        }
    }

    async function writeCache(cache) {
        try {
            const keys = Object.keys(cache);
            if (keys.length > CACHE_MAX) {
                keys.sort((a, b) => cache[a].t - cache[b].t);
                for (const k of keys.slice(0, keys.length - CACHE_MAX)) delete cache[k];
            }
            await chrome.storage.local.set({ [CACHE_KEY]: cache });
        } catch {}
    }

    // questions: [{ text, options: [string], images: [dataUrl] }]
    // Returns one option index (or null if no valid answer) per question. Saved answers are reused and
    // everything else goes to the AI in a few parallel requests (none at all if every question was answered before).
    // If only some requests fail, their questions come back null; if all fail, the first error is thrown.
    async function solveAll(questions, apiKey, maxRetries = 3) {
        checkKey(apiKey);
        const cache = await readCache();
        const hashes = questions.map(questionHash);
        const results = hashes.map((h) => (cache[h] ? cache[h].a : null));
        const todo = questions.map((q, n) => n).filter((n) => results[n] === null);
        if (!todo.length) {
            lastModel = "saved answers, no request used";
            return results;
        }
        const size = Math.max(MIN_CHUNK, Math.ceil(todo.length / MAX_PARALLEL));
        const chunks = [];
        for (let k = 0; k < todo.length; k += size) chunks.push(todo.slice(k, k + size));
        const settled = await Promise.allSettled(
            chunks.map((chunk) => requestAnswers(chunk.map((n) => questions[n]), apiKey, maxRetries))
        );
        if (settled.every((s) => s.status === "rejected")) throw settled[0].reason;
        settled.forEach((s, c) => {
            if (s.status === "rejected") return;
            chunks[c].forEach((n, k) => {
                results[n] = s.value[k];
                if (s.value[k] !== null) cache[hashes[n]] = { a: s.value[k], t: Date.now() };
            });
        });
        await writeCache(cache);
        return results;
    }

    async function requestAnswers(questions, apiKey, maxRetries) {
        const isClaude = apiKey.startsWith("sk-ant-");
        const content = [];
        questions.forEach((q, n) => {
            const options = q.options.map((opt, i) => `${String.fromCharCode(65 + i)}) ${opt}`).join("\n");
            const text = q.options.length
                ? `Question ${n + 1}:\n${q.text}\n\nOptions:\n${options}\n`
                : `Question ${n + 1} (numerical answer, no options):\n${q.text}\n`;
            content.push(isClaude ? { type: "text", text } : { text });
            for (const dataUrl of q.images || []) {
                const [, mediaType, data] = dataUrl.match(/^data:(.+?);base64,(.*)$/);
                content.push(
                    isClaude
                        ? { type: "image", source: { type: "base64", media_type: mediaType, data } }
                        : { inline_data: { mime_type: mediaType, data } }
                );
            }
        });
        const closing = `Answer all ${questions.length} question(s): give exactly ${questions.length} answer(s), in question order.`;
        content.push(isClaude ? { type: "text", text: closing } : { text: closing });

        const schema = answerSchema(Math.max(1, ...questions.map((q) => q.options.length)), questions.length);
        let answers;
        try {
            answers = await withRetry(
                (attempt) => (isClaude ? askClaude(apiKey, content, schema) : askGemini(apiKey, content, schema, attempt > 0)),
                maxRetries
            );
        } catch (err) {
            if (err.name === "TimeoutError") throw new Error("The AI took too long to answer");
            throw err;
        }
        if (!Array.isArray(answers)) throw new Error("Invalid response from the AI");

        // Multiple-choice -> option index; numerical -> number as a string; null if missing or invalid
        return questions.map((q, n) => {
            const value = typeof answers[n] === "string" ? answers[n].trim() : "";
            if (!q.options.length) {
                return toNumber(value);
            }
            const index = /^[A-Z]$/i.test(value) ? value.toUpperCase().charCodeAt(0) - 65 : -1;
            return index >= 0 && index < q.options.length ? index : null;
        });
    }

    async function solve(question, apiKey, maxRetries = 3) {
        const [index] = await solveAll([question], apiKey, maxRetries);
        if (index === null) throw new Error("Invalid answer from the AI");
        return index;
    }

    // Quick key check: lists the models the key can use instead of solving a question, so it answers in about a second
    async function testKey(apiKey) {
        checkKey(apiKey);
        const isClaude = apiKey.startsWith("sk-ant-");
        try {
            const res = isClaude
                ? await fetch("https://api.anthropic.com/v1/models?limit=1", {
                      signal: AbortSignal.timeout(10000),
                      headers: {
                          "x-api-key": apiKey,
                          "anthropic-version": "2023-06-01",
                          "anthropic-dangerous-direct-browser-access": "true",
                      },
                  })
                : await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", {
                      signal: AbortSignal.timeout(10000),
                      headers: { "x-goog-api-key": apiKey },
                  });
            await checkResponse(res);
        } catch (err) {
            if (err.name === "TimeoutError") throw new Error("No answer within 10 seconds. Check your internet and try again.");
            throw err;
        }
        return isClaude ? "Claude" : "Gemini";
    }

    return { solve, solveAll, checkKey, testKey, lastModel: () => lastModel };
})();
