# Hitbullseye Automate Tool

A browser extension that solves tests on [hitbullseye.com](https://www.hitbullseye.com/) with AI. It reads every question on the test page, gets the answers from Google Gemini (or Anthropic Claude), and fills them in for you: it clicks the option for multiple-choice questions and types the number for numerical ones.

Works in **Firefox** and **Chrome**.

## Features

- **AI solving**: sends the whole test to the AI in a single request, so one test uses one API call.
- **Multiple-choice and numerical questions**: picks the single correct option, or types the numeric answer.
- **Best model first**: tries the strongest free Gemini model and moves down the list only when a model's daily limit is used up or it's overloaded.
- **Answer-key mode**: paste your own answers (`ABCD...` or `1=B,2=D,3=42.5`) and it fills them in without using the AI.
- **Copy questions**: copies every question in a ready-to-paste format, so you can use any AI chat (for example the Gemini or Claude app) instead of an API key.
- **Optional auto-submit**: submits the test only when every question was answered.

## Installation

### Firefox

1. Download or clone this repository.
2. Open `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on...** and select `manifest.json` from this folder.
4. Open `about:addons` → **Hitbullseye Automate Tool** → **Permissions and data**, and turn on access for `hitbullseye.com` and `generativelanguage.googleapis.com`.

Temporary add-ons are removed when Firefox closes, so repeat step 3 after restarting Firefox.

### Chrome

1. Download or clone this repository.
2. Open `chrome://extensions/` and turn on **Developer mode**.
3. Click **Load unpacked** and select this folder.

## Getting an API key

The extension works with a free **Gemini API key**:

1. Go to [aistudio.google.com/apikey](https://aistudio.google.com/apikey) and create a key.
2. Click the extension icon and paste the key into **API Key**.
3. Click **Test API key**. You should see "Key works ✅".

An Anthropic API key (`sk-ant-...`) also works; the extension detects which one you pasted.

Your key is stored only in your browser's extension storage. It is never written to these files, so never commit it to the repository.

## Usage

1. Open a test on hitbullseye.com and go to **Question 1**.
2. Click the extension icon.
3. Leave **Test Answer Key** empty to let the AI solve it.
4. Click **Start**. Progress appears in the bottom-left corner of the page (`Solving 10 questions...`, then `Q1: B`, `Q2: 42.5`, ...).
5. Review the answers and submit, or tick **Auto-submit** to have it submit automatically.

**Time** sets the pause between questions while it fills in answers.

### Without an API key

1. Click **Copy questions**.
2. Paste into any AI chat.
3. Paste the answer line it gives you (for example `1=B, 2=D, 3=42.5`) into **Test Answer Key**.
4. Click **Start**.

## Gemini models and limits

Free Gemini API keys have a daily request limit for each model. The extension tries these models in order:

`gemini-3.8-flash` → `gemini-3.7-flash` → `gemini-3.6-flash` → `gemini-3-flash-preview` → `gemini-2.5-flash` → `gemini-3.5-flash-lite` → `gemini-3.1-flash-lite` → `gemini-2.5-flash-lite`

- When a model's daily limit runs out, it is skipped until it resets. Limits are tracked separately for each API key.
- When a model is only busy for a moment, the next model is used for that test only.
- A pop-up shows which model answered (`Solved with gemini-3.8-flash`). The "lite" models are less accurate.

Check your usage at [ai.dev/rate-limit](https://ai.dev/rate-limit).

## Accuracy

Answers come from an AI model and are not guaranteed to be correct. Accuracy is best on the full Flash models and lower on questions with diagrams or on the "lite" models. Check your score after the first test.

## Troubleshooting

| Problem | Fix |
|---|---|
| Red API key box | It contains something other than a key. Clear it and paste only the key. |
| `API error 429` | That model's daily limit is used up. The extension moves to the next model; if every model is used up, wait for the reset. |
| `API error 503` | Gemini is overloaded. The extension tries the next model; otherwise wait a minute. |
| `No questions found` | Make sure the test page (`onlinetest.hitbullseye.com/online_load/...`) is the active tab. |
| Nothing happens after reloading the extension | Click **Start** again. The extension reconnects to the page by itself. |

## Project structure

| File | Purpose |
|---|---|
| `manifest.json` | Extension configuration (Manifest V3, Firefox and Chrome) |
| `solver.js` | Builds the AI request, model fallback and answer parsing |
| `content.js` | Reads questions from the test page and fills in answers |
| `background.js` | Fallback for making AI requests if the page blocks them |
| `popup/` | The extension popup |
| `toast.js` | On-page progress messages |

## License

MIT. See [LICENSE](LICENSE).
