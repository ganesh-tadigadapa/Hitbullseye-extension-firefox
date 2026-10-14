// Shared by the background script, the content script and the popup.
// Sends multiple-choice questions to Gemini or Claude and returns the chosen option index for each.
globalThis.HBSolver = globalThis.HBSolver || (() => {
    const CLAUDE_MODEL = "claude-opus-5-5";
    // Each Gemini model has its own free-tier daily quota, so when one runs out we move to the next
    // Free-tier models, strongest first (Pro/Argon models have no free quota).
    // Ones this key can't use fail fast and are skipped.
    const GEMINI_MODELS = [
        "gemini-3.8-flash",
        "gemini-3.7-flash",
        "gemini-3.6-flash",
        "gemini-3-flash-preview",
        "gemini-2.5-flash",
        "gemini-3.5-flash-lite",
        "gemini-3.1-flash-lite",
        "gemini-2.5-flash-lite",
    ];

    const SYSTEM_PROMPT = `You solve multiple-choice aptitude questions (quant, reasoning, verbal, clocks, calendars, etc.) from an online practice test.
The question text was scraped from a web page, so it may include stray page text; ignore anything that is not part of the question.
Work each problem carefully and check your result against its options. Return one answer letter per question, in the same order as the questions.
Notation: "^" marks a superscript from the page, so 180^0 means 180 degrees and 21^st means 21st.`;

    const GEMINI_INSTRUCTIONS = `For each question: solve it step by step, briefly. Then verify the result a second way (plug the answer back in, recount, or use a different method) before choosing. If your result matches no option exactly, pick "None of these" when it is offered, otherwise the closest option.
Questions marked "numerical answer" have no options: work out the number and give it as a plain number (digits, optional minus sign and decimal point; no units, no commas, no fractions; round to 2 decimal places only if the question doesn't say otherwise).
After all questions, end with one final line in exactly this form (letters for multiple-choice, numbers for numerical answers):
ANSWERS: 1=B, 2=D, 3=42.5`;

    class RetryableError extends Error {}
    class QuotaError extends Error {}

    function checkKey(apiKey) {
        if (!apiKey) throw new Error("Set your Gemini or Anthropic API key in the extension popup");
        if (apiKey.length > 200 || !/^[\x21-\x7e]+$/.test(apiKey)) {
            throw new Error("The API key box contains something that isn't a key. Clear it and paste only your key.");
        }
    }

    // Short rate limits (too many requests per minute) clear quickly, so back off and retry
    async function withRetry(fn, maxRetries) {
        for (let attempt = 0; ; attempt++) {
            try {
                return await fn();
            } catch (err) {
                if (!(err instanceof RetryableError) || attempt >= maxRetries) throw err;
                await new Promise((r) => setTimeout(r, 5000 * 2 ** attempt));
            }
        }
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
            // Daily quota ("retry in 7h16m") or no quota at all ("limit: 0"): waiting a few seconds won't help
            const wait = parseRetryDelay(detail);
            if (/limit: 0\b/.test(detail) || wait > 120000) throw Object.assign(new QuotaError(error), { wait });
            throw new RetryableError(error);
        }
        if (res.status >= 500) throw new RetryableError(error);
        throw Object.assign(new Error(error), { status: res.status });
    }

    function parseRetryDelay(text) {
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

    async function markExhausted(apiKey, model, wait) {
        try {
            const exhausted = await exhaustedModels(apiKey);
            exhausted[model] = Date.now() + (wait || 24 * 3600000);
            await chrome.storage.local.set({ [storageKeyFor(apiKey)]: exhausted });
        } catch {}
    }

    let lastModel = null;

    // Reads "ANSWERS: 1=B, 2=D, 3=42.5" (the last such line) into ["B", "D", "42.5"]
    function parseAnswerLine(text, count) {
        const lines = text.split("\n").filter((l) => /ANSWERS\s*:/i.test(l));
        if (!lines.length) return null;
        const answers = new Array(count).fill(null);
        const line = lines[lines.length - 1].replace(/^.*?ANSWERS\s*:/i, "");
        for (const [, n, value] of line.matchAll(/(\d+)\s*=\s*\(?(-?[\d.]+|[A-Z])\b\)?/gi)) {
            if (n >= 1 && n <= count) answers[n - 1] = value.toUpperCase();
        }
        return answers.some(Boolean) ? answers : null;
    }

    function answerSchema(maxLetters, count) {
        return { letters: Array.from({ length: maxLetters }, (_, i) => String.fromCharCode(65 + i)), count };
    }

    async function askGemini(apiKey, parts, schema) {
        const exhausted = await exhaustedModels(apiKey);
        const models = GEMINI_MODELS.filter((m) => !(exhausted[m] > Date.now()));
        if (!models.length) {
            const next = Math.min(...Object.values(exhausted));
            const mins = Math.ceil((next - Date.now()) / 60000);
            throw new Error(`Daily free Gemini limit used up on every model. Try again in ~${mins} min.`);
        }

        let lastError;
        let busy = false;
        for (const model of models) {
            try {
                const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
                    method: "POST",
                    signal: AbortSignal.timeout(300000),
                    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
                    body: JSON.stringify({
                        systemInstruction: { parts: [{ text: SYSTEM_PROMPT + "\n\n" + GEMINI_INSTRUCTIONS }] },
                        contents: [{ role: "user", parts }],
                        generationConfig: { maxOutputTokens: 32768 },
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
                lastModel = model;
                return answers;
            } catch (err) {
                lastError = err;
                if (err instanceof QuotaError) {
                    await markExhausted(apiKey, model, err.wait);
                    continue;
                }
                // Overloaded right now (503) or briefly rate limited: try the next model instead of waiting
                if (err instanceof RetryableError) {
                    busy = true;
                    continue;
                }
                // Model not available for this key: try the next one
                if (err.status === 404 || err.status === 403) continue;
                throw err;
            }
        }
        if (busy) throw new RetryableError("Gemini is overloaded right now (all models busy). Wait a minute and try again.");
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

    // questions: [{ text, options: [string], images: [dataUrl] }]
    // Returns one option index (or null if no valid answer) per question, all from a single request.
    async function solveAll(questions, apiKey, maxRetries = 3) {
        checkKey(apiKey);
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
                () => (isClaude ? askClaude(apiKey, content, schema) : askGemini(apiKey, content, schema)),
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
                const number = value.replace(/[^\d.-]/g, "");
                return /^-?\d*\.?\d+$/.test(number) ? number : null;
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

    return { solve, solveAll, checkKey, lastModel: () => lastModel };
})();
