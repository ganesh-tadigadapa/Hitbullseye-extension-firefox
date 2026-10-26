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
            exportQuestions().then(sendResponse);
            return true; // keep the channel open for the async response
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
    // Like clean, but keeps line breaks (and tabs between table cells), so a number at the end of one line and a
    // fraction starting the next don't run together into what reads as a mixed fraction
    const cleanLines = (s) =>
        (s || "").replace(/[^\S\n\t]+/g, " ").replace(/\s*\n\s*/g, "\n").replace(/[ \t]*\t[ \t]*/g, "\t").trim();
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
    // Unicode superscript/subscript characters and the plain characters they stand for
    const SUPERSCRIPTS = ["⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱ", "0123456789+-=()ni"];
    const SUBSCRIPTS = ["₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₒₓₙ", "0123456789+-=()aeoxn"];
    const plainScript = (s, [from, to]) => [...s].map((ch) => to[from.indexOf(ch)]).join("");

    // A power as text: "^2" (or "_2" for a subscript), but "^(n+1)" when it's more than one number or word, or
    // when `after` (the text that follows it) would run into it: 2ˣ3ʸ -> "2^(x)3^y", log₂8 -> "log_(2)8"
    const script = (mark, p, after = "") => `${mark}${/^\w+$/.test(p) && !/^\w/.test(after) ? p : `(${p})`}`;

    // Plain-text math the page may use: "2⅓" -> "2 1/3", "¹⁄₃" -> "1/3", fraction slash -> "/",
    // "x²" -> "x^2", "10⁻³" -> "10^(-3)", TeX "2\frac{1}{3}" -> "2 1/3"
    function normalizeMath(text) {
        // Innermost \frac first, so \frac{\frac{1}{2}}{3} -> (1/2)/3; "\frac13" is TeX shorthand for \frac{1}{3}
        for (let prev; prev !== text; ) {
            prev = text;
            text = text.replace(/\\[dt]?frac\s*(?:\{([^{}]*)\}|(\w))\s*(?:\{([^{}]*)\}|(\w))/g, (_, a, a1, b, b1) =>
                fraction(a ?? a1, b ?? b1)
            );
        }
        return text
            .replace(/[\u2061-\u2064]/g, "") // MathML's invisible operators, e.g. between 2 and 1/3 in 2⅓
            .replace(/(\d?)\s*([½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅐⅛⅜⅝⅞⅑⅒])/g, (_, whole, f) => (whole ? `${whole} ` : " ") + VULGAR_FRACTIONS[f])
            .replace(/([⁰¹²³⁴⁵⁶⁷⁸⁹]+)\s*[⁄∕/]\s*([₀₁₂₃₄₅₆₇₈₉]+)/g, (_, a, b) =>
                ` ${plainScript(a, SUPERSCRIPTS)}/${plainScript(b, SUBSCRIPTS)}`
            )
            .replace(/[⁄∕]/g, "/")
            .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱ]+(?=(\w?))/g, (s, after) => script("^", plainScript(s, SUPERSCRIPTS), after))
            .replace(/[₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₒₓₙ]+(?=(\w?))/g, (s, after) => script("_", plainScript(s, SUBSCRIPTS), after));
    }

    // A fraction as text: " 2/7 ", or " (x+1)/(x-1) " when a part is more than one number or word, so that
    // a whole number right before it reads as a mixed fraction ("5 2/7") rather than a multiplication
    const group = (p) => (/^([\w.]+|\([^()]*\))$/.test(p.trim()) ? p.trim() : `(${p.trim()})`);
    const fraction = (a, b) => ` ${group(a)}/${group(b)} `;

    // MathML (also what MathJax 3 and KaTeX keep for screen readers) as plain text
    function mathToText(node) {
        const kids = [...node.children];
        const t = (n) => (n ? mathToText(n) : "");
        switch (node.localName) {
            case "mfrac": return fraction(t(kids[0]), t(kids[1]));
            case "msqrt": return `sqrt(${kids.map(t).join("")})`;
            case "mroot": return `root${t(kids[1])}(${t(kids[0])})`;
            case "msup": return `${group(t(kids[0]))}^(${t(kids[1])})`;
            case "msub": case "munder": return `${group(t(kids[0]))}_(${t(kids[1])})`;
            case "msubsup": case "munderover": return `${group(t(kids[0]))}_(${t(kids[1])})^(${t(kids[2])})`;
            // A bar over digits marks them as recurring: 0.1(6)
            case "mover":
                return /^\d+$/.test(t(kids[0]).trim()) && /^[¯‾_―—–-]$/.test(t(kids[1]).trim()) ? `(${t(kids[0]).trim()})` : kids.map(t).join("");
            case "mfenced": {
                const [open, close, separators] = ["open", "close", "separators"].map((a) => node.getAttribute(a));
                return `${open ?? "("}${kids.map(t).join((separators ?? ",").trim().charAt(0))}${close ?? ")"}`;
            }
            case "annotation": case "annotation-xml": return "";
            case "semantics": return t(kids[0]);
            default: return kids.length ? kids.map(t).join("") : node.textContent;
        }
    }

    // MathJax 3's rendered math as MathML, so mathToText can read it. Its HTML output names elements after the
    // MathML they show (<mjx-mfrac>, <mjx-msup>...) and its SVG output says so in data-mml-node; the characters are
    // in <mjx-c> (as text, or only as a class like "mjx-c35" for "5") or in <use data-c="35">
    // (A numerator, denominator or power holds several items side by side, so it's read as one group)
    const MJX_NODE = (n) =>
        n.getAttribute("data-mml-node") ||
        (/^mjx-m(?!ath$)[a-z]+$/.test(n.localName) ? n.localName.slice(4) : null) ||
        (/^mjx-(num|den)$/.test(n.localName) || (n.localName === "mjx-script" && /^mjx-msu[bp]$/.test(n.parentElement?.localName)) ? "mrow" : null);
    function mjxToMathML(node, name = "mrow") {
        const el = document.createElementNS("http://www.w3.org/1998/Math/MathML", name);
        if (/^(mi|mn|mo|mtext|ms)$/.test(name)) {
            el.textContent = [...node.querySelectorAll("mjx-c, use[data-c], text")]
                .map((c) => {
                    const code = c.getAttribute("data-c") || (c.textContent ? null : String(c.className).match(/mjx-c([0-9A-F]+)/)?.[1]);
                    return code ? String.fromCodePoint(parseInt(code, 16)) : c.textContent;
                })
                .join("")
                .normalize("NFKC"); // math italic 𝑥 -> x
            return el;
        }
        // Its MathML children: the nearest descendants that stand for MathML elements, skipping layout wrappers
        const walk = (n) => [...n.children].flatMap((c) => (MJX_NODE(c) ? [c] : walk(c)));
        for (const c of walk(node)) el.append(mjxToMathML(c, MJX_NODE(c)));
        return el;
    }

    // Text of an element with math kept readable: 180<sup>0</sup> -> "180^0" instead of "1800",
    // 2<sup>1</sup>/<sub>3</sub> -> "2 1/3" (a mixed fraction), stacked fractions -> "a/b", and images
    // either as their alt text or as "[image N]" when `imageIndex` says image N is attached for that <img>
    function readableText(el, imageIndex = []) {
        if (!el.querySelector || !el.querySelector("sup, sub, math, mjx-container, img, svg, canvas, [data-hb-figure], table, br, [style*=border], [style*=overline], [style*=vertical-align], [class*=frac], script")) {
            return normalizeMath(el.innerText || el.textContent);
        }
        const copy = el.cloneNode(true);
        // MathJax 2 keeps the source (TeX, AsciiMath or MathML) in a script tag next to the rendered copy: use the source
        copy.querySelectorAll("script[type^='math/']").forEach((n) => {
            const mml = /mml/.test(n.type) && new DOMParser().parseFromString(n.textContent, "text/html").querySelector("math");
            n.replaceWith(` ${mml ? mathToText(mml) : n.textContent} `);
        });
        copy.querySelectorAll("script, style, noscript, template").forEach((n) => n.remove());
        // Rendered copies of math that's also kept as a source or as MathML (KaTeX's visible half repeats its MathML)
        // (MathJax 3 puts the class "MathJax" on its <mjx-container> too, but keeps no other copy, so that one stays)
        copy.querySelectorAll(".MathJax_Preview, .MathJax:not(mjx-container), .MathJax_Display, .MathJax_SVG, .MathJax_CHTML, .MathJax_MathML, .katex-html").forEach((n) => n.remove());
        // MathJax 3: its hidden MathML copy for screen readers when there is one, else the rendered math itself
        // (whose plain text runs a mixed fraction 51 1/5 together into "5115")
        copy.querySelectorAll("mjx-container").forEach((n) => {
            const math = n.querySelector("math");
            const rendered = n.querySelector("mjx-math, [data-mml-node=math]");
            n.replaceWith(` ${math ? mathToText(math) : rendered ? mathToText(mjxToMathML(rendered)) : n.textContent} `);
        });
        copy.querySelectorAll("math").forEach((n) => n.replaceWith(` ${mathToText(n)} `));
        const short = (n) => n.textContent.trim().length <= 20;
        const isSlash = (n) => /^\s*[/⁄∕]\s*$/.test(n.textContent);

        // Superscripts and subscripts styled on a span rather than written as <sup>/<sub>
        copy.querySelectorAll("[style*=vertical-align]").forEach((n) => {
            const tag = { super: "sup", sub: "sub" }[n.style.verticalAlign];
            if (!tag) return;
            const replacement = document.createElement(tag);
            replacement.append(...n.childNodes);
            n.replaceWith(replacement);
        });
        // Fractions written with sup and sub: 2<sup>1</sup>/<sub>3</sub> -> "2 1/3" (a mixed fraction). The slash can
        // also sit inside either one, or be left out when both are numbers
        copy.querySelectorAll("sup").forEach((sup) => {
            if (!copy.contains(sup)) return;
            const between = [];
            let sub = sup.nextSibling;
            while (sub && (sub.nodeType === Node.TEXT_NODE || sub.nodeName === "SPAN") && (!sub.textContent.trim() || isSlash(sub))) {
                between.push(sub);
                sub = sub.nextSibling;
            }
            if (!sub || sub.nodeName !== "SUB") return;
            const [a, b] = [sup.textContent.trim(), sub.textContent.trim()];
            const [num, den] = [a.replace(/[/⁄∕]$/, ""), b.replace(/^[/⁄∕]/, "")];
            const slashed = between.some(isSlash) || num !== a || den !== b;
            if (num && den && (slashed || (/^\d+$/.test(num) && /^\d+$/.test(den)))) {
                [...between, sub].forEach((n) => n.remove());
                sup.replaceWith(fraction(num, den));
            }
        });
        // A bar over something right after √ is the root's bar: √(a+b). Over digits right after a number
        // it marks recurring digits: 0.1(6) = 0.1666...
        const textBefore = (n) => {
            let prev = n.previousSibling;
            while (prev && !prev.textContent.trim()) prev = prev.previousSibling;
            return prev ? prev.textContent.trim() : "";
        };
        copy.querySelectorAll("[style*=border-top], [style*=overline]").forEach((n) => {
            const t = n.textContent.trim();
            if (/√$/.test(textBefore(n)) || (/\.\d*$/.test(textBefore(n)) && /^\d+$/.test(t))) n.replaceWith("(", ...n.childNodes, ")");
        });
        // Other superscripts are powers and subscripts indices: x<sup>2</sup> -> "x^2", log<sub>2</sub>8 -> "log_(2)8".
        // Innermost first, so 2<sup>2<sup>3</sup></sup> -> "2^(2^3)". A number raised just before √ is the root's
        // index: <sup>3</sup>√8 -> "root3(8)"
        const textAfter = (n) => {
            // Text after the end of a line, block or table cell doesn't run into it
            for (let x = n; x && x !== copy && !/^(P|DIV|LI|TD|TH|H\d)$/.test(x.nodeName); x = x.parentNode) {
                for (let next = x.nextSibling; next && next.nodeName !== "BR"; next = next.nextSibling) {
                    if (next.textContent) return next.textContent;
                }
            }
            return "";
        };
        [...copy.querySelectorAll("sup, sub")].reverse().forEach((n) => {
            const p = n.textContent.trim();
            const next = n.nextSibling;
            const before = n.previousSibling?.nodeType === Node.TEXT_NODE ? n.previousSibling.textContent : "";
            if (!p) {
                n.remove();
            } else if (n.nodeName === "SUP" && /^\d+\s*[/⁄∕]\s*\d+$/.test(p) && /\d\s+$/.test(before)) {
                // A raised fraction after a whole number and a space is a mixed fraction: 8 <sup>2/3</sup> -> "8 2/3"
                const [a, b] = p.split(/[/⁄∕]/);
                n.replaceWith(fraction(a, b));
            } else if (n.nodeName === "SUP" && /^\d+$/.test(p) && next?.nodeType === Node.TEXT_NODE && /^\s*√/.test(next.textContent)) {
                next.textContent = next.textContent.replace(/^\s*√\s*([\w.]+)?/, (_, x) => (x ? `(${x})` : ""));
                n.replaceWith(`root${p}`);
            } else {
                n.replaceWith(script(n.nodeName === "SUP" ? "^" : "_", p, textAfter(n)));
            }
        });
        // Fractions built from elements: <span class="frac"><span>1</span><span>3</span></span>, maybe with the whole
        // number first: <span class="mixed"><span>2</span><span>1</span><span>3</span></span>. Innermost first,
        // so a "mixed-fraction" wrapper around the whole number and a "frac" isn't read as 2/13
        [...copy.querySelectorAll("[class*=frac]")].reverse().forEach((n) => {
            const parts = [...n.children].filter((c) => c.textContent.trim() && !isSlash(c));
            const withWhole = parts.length === 3 && /^\d+$/.test(parts[0].textContent.trim());
            if ((parts.length !== 2 && !withWhole) || !parts.every(short)) return;
            const [num, den] = parts.slice(-2);
            num.replaceWith(fraction(num.textContent, den.textContent));
            n.replaceWith(...[...n.childNodes].filter((c) => c !== den && !isSlash(c)));
        });
        // Fractions laid out as a table: numerator over denominator, optionally with the whole number
        // of a mixed fraction in a cell spanning both rows
        copy.querySelectorAll("table").forEach((n) => {
            const rows = [...n.rows];
            if (n.querySelector("input, img") || rows.length !== 2 || !rows.every(short)) return;
            const [top, bottom] = rows.map((r) => [...r.cells]);
            if (top.length === 1 && bottom.length === 1) {
                n.replaceWith(fraction(top[0].textContent, bottom[0].textContent));
            } else if (top.length === 2 && top[0].rowSpan === 2 && bottom.length === 1) {
                n.replaceWith(` ${top[0].textContent.trim()} ${fraction(top[1].textContent, bottom[0].textContent)}`);
            }
        });
        // Fractions stacked with a border as the fraction bar: the numerator has a bottom border
        // or the denominator a top border
        const parts = (n) => [...n.childNodes].filter((c) => c.nodeName === "BR" || c.textContent.trim());
        [...copy.querySelectorAll("[style*=border]")].reverse().forEach((n) => {
            const parent = n.parentElement;
            if (!parent || !copy.contains(parent)) return;
            const kids = parts(parent);
            const style = n.getAttribute("style") || "";
            const isBar = (/border-bottom/.test(style) && kids[0] === n) || (/border-top/.test(style) && kids[1] === n);
            if (kids.length === 2 && isBar && kids.every(short)) parent.replaceWith(fraction(kids[0].textContent, kids[1].textContent));
        });
        // Fractions stacked with a line break: <span style="display:inline-block"><u>1</u><br>3</span>
        [...copy.querySelectorAll("br")].reverse().forEach((n) => {
            const parent = n.parentElement;
            if (!parent || !copy.contains(parent)) return;
            const kids = parts(parent);
            const stacked = /inline-block/.test(parent.getAttribute("style") || "") || kids[0]?.nodeName === "U";
            if (kids.length === 3 && kids[1] === n && stacked && short(kids[0]) && short(kids[2])) {
                parent.replaceWith(fraction(kids[0].textContent, kids[2].textContent));
            }
        });
        // textContent runs lines and blocks together ("Statement IStatement II", or "Question No. 5" and a
        // "3/4 of..." below it into the mixed fraction "5 3/4"), so keep them on lines of their own
        copy.querySelectorAll("br").forEach((n) => n.replaceWith("\n"));
        copy.querySelectorAll("p, div, li, tr, td, th, h1, h2, h3, h4, h5, h6").forEach((n) => {
            const gap = n.nodeName === "TD" || n.nodeName === "TH" ? "\t" : "\n";
            n.prepend(gap);
            n.append(gap);
        });
        // Figures (tagged by extractQuestion) become "[image N]", or UNREADABLE when they couldn't be read; a picture
        // set as an element's background gets the marker put in front of the element instead of replacing it
        const meaningful = (alt) => alt && !/^(image|img|pic|photo)?\s*\d*$/i.test(alt);
        copy.querySelectorAll("img, [data-hb-figure]").forEach((n) => {
            const alt = (n.getAttribute("alt") || n.getAttribute("title") || "").trim();
            const k = imageIndex[n.getAttribute("data-hb-figure")];
            let marker = null;
            if (k === -1) marker = meaningful(alt) ? alt : UNREADABLE;
            else if (k !== undefined) marker = `[image ${k + 1}${alt ? `: ${alt}` : ""}]`;
            else if (n.nodeName === "IMG" && meaningful(alt)) marker = alt;
            if (marker === null) return;
            if (FIGURE_TAGS.test(n.nodeName)) n.replaceWith(` ${marker} `);
            else n.prepend(` ${marker} `);
        });
        return normalizeMath(copy.textContent);
    }

    // `imageIndex` (from extractQuestion) gives the attached-image number of each figure, so an option shown as
    // a picture (often a fraction) reads "[image N]" and the AI can look at it instead of seeing nothing
    function optionText(radio, name, imageIndex = []) {
        const read = (el) => clean(readableText(el, imageIndex));
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

        // Options laid out as "<input> text <br> <input> text ..." in one container. The nodes are read together,
        // since a mixed fraction or power spans several of them: 2<sup>1</sup>/<sub>3</sub>
        const nodes = [];
        for (let node = radio.nextSibling; node && node.nodeName !== "INPUT" && node.nodeName !== "BR"; node = node.nextSibling) {
            nodes.push(node);
        }
        const option = document.createElement("span");
        option.append(...nodes.map((n) => n.cloneNode(true)));
        // Nothing readable: the page's own value ("a", "b"...) says nothing, so tell the AI the option is a picture
        return clean(readableText(option, imageIndex)) || (radio.value.length > 1 ? radio.value : UNREADABLE);
    }

    const UNREADABLE = "[picture that could not be read]";
    // Elements that are a picture themselves (the rest of the figures are pictures set as a CSS background)
    const FIGURE_TAGS = /^(IMG|SVG|CANVAS|INPUT|OBJECT|EMBED)$/i;

    // Everything in `block` the question may show as a picture, in page order: <img>, drawings (<svg>, <canvas>),
    // embedded pictures, and elements with no text whose CSS background is a picture
    function findFigures(block) {
        // (MathJax's SVG output is math, read as text, not a figure)
        const figures = [...block.querySelectorAll("img, svg, canvas, input[type=image], object, embed")].filter(
            (n) => !n.parentElement?.closest("svg") && !n.closest("mjx-container")
        );
        for (const n of block.querySelectorAll("*")) {
            if (!figures.includes(n) && !n.closest("svg") && !n.textContent.trim() && /url\(/.test(getComputedStyle(n).backgroundImage)) {
                figures.push(n);
            }
        }
        return figures.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    }

    // A figure as a PNG data URL: "" for one too small to matter (an icon or spacer), null when it can't be read
    async function figureToDataUrl(n) {
        if (n.nodeName === "IMG") return imageToDataUrl(n);
        if (n.nodeName.toLowerCase() === "svg") return svgToDataUrl(n);
        if (n.nodeName === "CANVAS") {
            try {
                return n.width < 24 || n.height < 24 ? "" : n.toDataURL("image/png");
            } catch {
                return null; // drawn from another site's pictures, can't read it
            }
        }
        const url =
            n.nodeName === "INPUT" || n.nodeName === "EMBED" ? n.src
            : n.nodeName === "OBJECT" ? n.data
            : getComputedStyle(n).backgroundImage.match(/url\(["']?(.*?)["']?\)/)?.[1];
        if (!url) return "";
        const img = new Image();
        img.src = new URL(url, location.href).href;
        return imageToDataUrl(img);
    }

    // An inline <svg> drawing as a PNG. The page's stylesheets don't come along with a copy of it, so the
    // styles that decide how it looks are written onto each of its elements first
    async function svgToDataUrl(svg) {
        const box = svg.getBoundingClientRect();
        const viewBox = svg.viewBox?.baseVal;
        const width = box.width || viewBox?.width || parseFloat(svg.getAttribute("width")) || 0;
        const height = box.height || viewBox?.height || parseFloat(svg.getAttribute("height")) || 0;
        if (width < 24 || height < 24) return ""; // an icon
        const copy = svg.cloneNode(true);
        const originals = [svg, ...svg.querySelectorAll("*")];
        [copy, ...copy.querySelectorAll("*")].forEach((c, k) => {
            const style = getComputedStyle(originals[k]);
            for (const p of ["fill", "stroke", "stroke-width", "stroke-dasharray", "opacity", "fill-opacity", "font-size", "font-family", "font-weight", "text-anchor"]) {
                c.style.setProperty(p, style.getPropertyValue(p));
            }
        });
        copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
        copy.setAttribute("width", width);
        copy.setAttribute("height", height);
        const img = new Image();
        img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(copy))}`;
        try {
            await img.decode();
            return drawImage(img);
        } catch {
            return null;
        }
    }

    // An <img> as a PNG data URL for the AI: "" for one too small to matter (a spacer or icon), null when it can't
    // be read. One the page can't hand over (from another site, or not loaded yet because its question is hidden)
    // is downloaded again by the background script, which is allowed to fetch it
    async function imageToDataUrl(img) {
        // Lazy-loading pages show a placeholder and keep the real address in a data- attribute until the
        // picture scrolls into view, which a hidden question never does
        const lazy = ["data-src", "data-original", "data-lazy-src", "data-url"].map((a) => img.getAttribute(a)).find(Boolean);
        if (lazy && new URL(lazy, location.href).href !== img.src) {
            const real = new Image();
            real.src = new URL(lazy, location.href).href;
            return imageToDataUrl(real);
        }
        if (img.complete && img.naturalWidth && (img.naturalWidth < 8 || img.naturalHeight < 8)) return "";
        const drawn = img.complete && img.naturalWidth ? drawImage(img) : null;
        if (drawn) return drawn;
        const src = img.currentSrc || img.src;
        if (!/^(https?|data|blob):/.test(src)) return null;
        try {
            const { dataUrl } = await chrome.runtime.sendMessage({ type: "fetchImage", url: src });
            if (!dataUrl) return null;
            const copy = new Image();
            copy.src = dataUrl;
            await copy.decode();
            return copy.naturalWidth < 8 || copy.naturalHeight < 8 ? "" : drawImage(copy);
        } catch {
            return null;
        }
    }

    function drawImage(img) {
        try {
            // Small images are kept too: tests often show fractions and formulas as little inline pictures.
            // A fraction picture can be only ~20px tall, too few pixels to tell a 3 from an 8: enlarge it (up to 4x)
            const scale = Math.min(4, Math.max(1, 80 / img.naturalHeight));
            const canvas = document.createElement("canvas");
            canvas.width = Math.round(img.naturalWidth * scale);
            canvas.height = Math.round(img.naturalHeight * scale);
            const ctx = canvas.getContext("2d");
            // Transparent pictures (black text on nothing) can reach the AI as black on black, so put them on white
            ctx.fillStyle = "#fff";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.imageSmoothingQuality = "high";
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            return canvas.toDataURL("image/png");
        } catch {
            return null; // cross-origin image, can't read it
        }
    }

    async function extractQuestion(i, target = targetFor(i)) {
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

        // Figures are attached after the question, and "[image N]" in the text marks where each one sits (or
        // UNREADABLE where one couldn't be read, so the AI knows something is missing). Each figure is tagged with
        // its number so the text can find it again in the copies readableText works on
        const images = [];
        const figures = findFigures(block);
        const dataUrls = await Promise.all(figures.map(figureToDataUrl));
        const imageIndex = dataUrls.map((dataUrl) => {
            if (dataUrl === null) return -1;
            return dataUrl && images.length < MAX_IMAGES ? images.push(dataUrl) - 1 : undefined;
        });
        figures.forEach((n, k) => n.setAttribute("data-hb-figure", k));
        const options = target.kind === "mcq" ? target.radios.map((r) => optionText(r, name, imageIndex)) : [];
        return { text: cleanLines(readableText(block, imageIndex)).slice(0, 8000), options, images };
    }

    async function exportQuestions() {
        const total = countQuestions();
        const parts = [];
        let missing = 0;
        for (let i = 1; i <= total; i++) {
            const target = targetFor(i);
            if (!target) {
                missing++;
                continue;
            }
            const q = await extractQuestion(i, target);
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
                const result = await solveQuestions(await Promise.all(list.map(([i, target]) => extractQuestion(i, target))));
                list.forEach(([i], n) => {
                    asked.add(i);
                    if (result[n] !== null && result[n] !== undefined) answers[i] = result[n];
                });
            };
            try {
                await solveInto(present);
                // A lite model only answers once every strong one is used up for the day, and it's less accurate
                const model = HBSolver.lastModel();
                if (/lite/.test(model || "")) toast(`Solved with ${model}: a less accurate backup. Add another Gemini key for more accurate answers`, "error");
                else if (model) toast(`Solved with ${model}`);
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
                    const [answer] = await solveQuestions([await extractQuestion(i, target)]);
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
