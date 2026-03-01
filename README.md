<div align="center">

# 🚀 Prompt2Code

### AI-powered code generation, chat, and inline completions — right inside VS Code

[![Version](https://img.shields.io/visual-studio-marketplace/v/SujayBabuThota.prompt2code?style=flat-square&color=4285f4&label=Marketplace)](https://marketplace.visualstudio.com/items?itemName=SujayBabuThota.prompt2code)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/SujayBabuThota.prompt2code?style=flat-square&color=3dc965)](https://marketplace.visualstudio.com/items?itemName=SujayBabuThota.prompt2code)
[![Rating](https://img.shields.io/visual-studio-marketplace/r/SujayBabuThota.prompt2code?style=flat-square&color=f4b942)](https://marketplace.visualstudio.com/items?itemName=SujayBabuThota.prompt2code)
[![License: MIT](https://img.shields.io/badge/License-MIT-lightgrey?style=flat-square)](LICENSE)

**Write a comment. Get working code.**

</div>

---

## ✨ What is Prompt2Code?

Prompt2Code brings the power of large language models directly into your editor. Describe what you want in plain English — as a comment, a chat message, or a prompt — and Prompt2Code generates production-ready code on the spot.

No context switching. No copy-pasting from a browser. Just you and your editor.

---

## 🎯 Core Features

### 💬 AI Chat Sidebar

An intelligent chat panel built into the VS Code sidebar — similar to GitHub Copilot Chat.

- **Ask Mode** — ask any coding question and get instant answers
- **Agent Mode** — describe a feature and the AI creates + integrates files across your project
- **Plan Mode** — break complex tasks into steps before generating code

Open it from the Activity Bar or run `Prompt2Code: Open Chat`.

---

### ⚡ Comment → Code Generation

Write your intent as a comment, then press `Ctrl+Shift+G` (`Cmd+Shift+G` on Mac). The extension replaces the comment with generated code instantly.

```html
<!-- create a responsive pricing page with 3 tiers and full CSS -->
```

```javascript
// generate a debounce function with TypeScript types
```

```css
/* build a glassmorphism card with hover animation */
```

---

### 🧠 Inline AI Completions

Copilot-style suggestions appear as you type. Press `Tab` to accept.

```javascript
function calculateTotal(items) {
  return items.reduce(          // ← AI suggests the full implementation
```

---

### 🗂️ Multi-File Agent

Describe a component or feature and the Agent automatically:

1. Creates new files with correct folder structure
2. Writes the component or module
3. Integrates it into existing files (imports, routes, exports)

> Example: *"Create a reusable Modal component and add it to App.jsx"*

---

### 🖼️ Image → Code

Attach a screenshot or mockup and describe what you need. The AI interprets the image and generates matching code.

---

## 🚀 Getting Started

### 1 — Sign In

Click **Sign in with Google** in the chat panel to activate the extension.

### 2 — Add an API Key *(optional but recommended)*

Go to the **Settings** (⚙️) inside the chat panel and paste your API key for any supported provider:

| Provider | Where to get a key |
|---|---|
| **Groq** | [console.groq.com](https://console.groq.com) — fast & free tier |
| **OpenAI** | [platform.openai.com](https://platform.openai.com) |
| **Anthropic** | [console.anthropic.com](https://console.anthropic.com) |
| **Google Gemini** | [aistudio.google.com](https://aistudio.google.com) |

### 3 — Start Coding

- Open any file and write a prompt comment → `Ctrl+Shift+G`
- Or open the chat sidebar and start a conversation

---

## 💡 Example Prompts

```
<!-- create a modern login page with glassmorphism card and full CSS -->
```

```
// build an Express REST API with CRUD routes for a User model
```

```
/* generate a responsive navbar with mobile hamburger menu */
```

```
Create a React dashboard with charts using recharts, 
integrate it into App.tsx with a /dashboard route
```

---

## ⌨️ Commands

| Command | Shortcut | Description |
|---|---|---|
| `Prompt2Code: Open Chat` | — | Open the AI chat panel |
| `Prompt2Code: Generate Code` | `Ctrl+Shift+G` | Generate from prompt comment |
| `Prompt2Code: Enable Inline Suggestions` | — | Turn on Tab completions |
| `Prompt2Code: Disable Inline Suggestions` | — | Turn off Tab completions |

---

## 🔧 Settings

| Setting | Default | Description |
|---|---|---|
| `prompt2code.model` | `llama-3.3-70b-versatile` | Active AI model |
| `prompt2code.maxTokens` | `4096` | Max response length |
| `prompt2code.temperature` | `0.3` | Creativity (0 = precise, 1 = creative) |
| `prompt2code.enableInlineCompletions` | `true` | Toggle inline suggestions |
| `prompt2code.debounceMs` | `400` | Inline completion delay (ms) |

---

## 🌐 Supported Languages

| Category | Languages |
|---|---|
| Web | HTML, CSS, SCSS, JavaScript, TypeScript |
| Frameworks | React (JSX/TSX), Next.js, Vue |
| Backend | Node.js, Python, Java |
| Other | JSON, Markdown, Shell |

---

## 🔒 Privacy

- You sign in with Google for personalization only — no code is stored on our servers
- API calls go **directly** from your machine to the AI provider you choose
- Your API keys are stored locally in VS Code's encrypted secret storage
- No telemetry beyond what VS Code itself collects

---

## 🐛 Issues & Feedback

Found a bug or have a feature request?
→ [Open an issue on GitHub](https://github.com/Sujay149/Prompt2Code/issues)

---

## 📄 License

[MIT](LICENSE) © Sujay Babu Thota