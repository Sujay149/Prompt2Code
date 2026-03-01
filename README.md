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

Follow these steps to go from zero to generating code in under 2 minutes.

---

### Step 1 — Install the Extension

1. Open VS Code
2. Press `Ctrl+Shift+X` to open the Extensions panel
3. Search for **Prompt2Code**
4. Click **Install**

Or install from the command line:

```bash
code --install-extension SujayBabuThota.prompt2code
```

---

### Step 2 — Open the Chat Panel

After installation, look for the **rocket icon** (🚀) in the Activity Bar on the left side of VS Code.

Click it to open the Prompt2Code chat sidebar.

> **Can't see it?** Run the command: `Ctrl+Shift+P` → type `Prompt2Code: Open Chat` → press Enter

---

### Step 3 — Sign In with Google

The first time you open the panel, you'll see a **Sign in with Google** screen.

1. Click **Sign in with Google**
2. A browser window opens — choose your Google account
3. Grant the requested permissions
4. The browser shows ✅ — switch back to VS Code

You're now signed in. The chat panel becomes active.

---

### Step 4 — Get a Free API Key *(takes 1 minute)*

Prompt2Code works with multiple AI providers. **Groq is recommended for new users** — it's fast, free, and requires no credit card.

#### Get a Groq API key (free):

1. Go to [console.groq.com](https://console.groq.com)
2. Sign up or sign in
3. Click **API Keys** → **Create API Key**
4. Copy the key (starts with `gsk_...`)

#### Add it to Prompt2Code:

1. Click the **⚙️ Settings** icon inside the chat panel
2. Find **Groq** in the API Keys list
3. Paste your key and press **Save**
4. The model picker will now show Groq models at the top

> **No key?** Prompt2Code still works with built-in limited access. Adding a key removes rate limits and unlocks more powerful models.

**Other supported providers:**

| Provider | Where to get a key | Best for |
|---|---|---|
| **Groq** | [console.groq.com](https://console.groq.com) | Speed — free tier, fastest responses |
| **OpenAI** | [platform.openai.com](https://platform.openai.com) | GPT-4o, most well-known |
| **Anthropic** | [console.anthropic.com](https://console.anthropic.com) | Claude — great for long context |
| **Google Gemini** | [aistudio.google.com](https://aistudio.google.com) | Free tier, multimodal |

---

### Step 5 — Generate Your First Code

#### Option A: From a comment in your file

1. Open or create any file (e.g. `index.html`, `App.jsx`, `styles.css`)
2. Write a prompt as a comment:

```html
<!-- create a responsive hero section with a gradient background and CTA button -->
```

3. Place your cursor on that line
4. Press `Ctrl+Shift+G` (Mac: `Cmd+Shift+G`)
5. Watch the code appear ✨

#### Option B: From the Chat Sidebar

1. Click the 🚀 icon to open the chat panel
2. Select a mode:
   - **Ask** — for questions and explanations
   - **Agent** — for generating and editing files in your project
   - **Plan** — for breaking down complex tasks
3. Type your request and press **Send** (or `Enter`)

---

### Step 6 — Use Agent Mode for Bigger Tasks

Agent Mode can work across your entire project — not just the current file.

**Example workflow:**

1. Open your project folder in VS Code (`File → Open Folder`)
2. Switch to **Agent** mode in the chat panel
3. Type a request like:

   > *"Create a reusable Button component in React, add it to components/Button.tsx, and import it into App.tsx"*

4. The agent will:
   - Scan your project structure
   - Create the new file with correct content
   - Modify the existing file to integrate it

---

### Step 7 — Enable Inline Completions

For Copilot-style suggestions as you type:

1. Open Command Palette: `Ctrl+Shift+P`
2. Run: `Prompt2Code: Enable Inline Suggestions`
3. Start typing in any file — suggestions appear as grey text
4. Press `Tab` to accept, `Escape` to dismiss

---

### 💡 Tips for Best Results

| Tip | Example |
|---|---|
| Be specific about the tech stack | *"in React with TypeScript and Tailwind"* |
| Mention styling preferences | *"with dark mode support and smooth animations"* |
| Describe structure, not just the component | *"with separate Header, Body, and Footer sections"* |
| Use Agent mode for multi-file work | *"create X and integrate it into Y"* |
| Attach an image for UI cloning | Upload a screenshot and say *"build this"* |

---

## 💡 Example Prompts

#### 🌐 HTML / CSS
```html
<!-- create a modern login page with glassmorphism card, input validation styles, and full responsive CSS -->
```
```css
/* build an animated hero section with a gradient background and floating particles */
```

#### ⚛️ React / TypeScript
```tsx
// create a reusable DataTable component with sorting, filtering, and pagination
```
```tsx
// generate a custom useDebounce hook with TypeScript generics
```

#### 🟨 JavaScript / Node.js
```javascript
// build an Express REST API with CRUD routes, middleware, and error handling for a User model
```
```javascript
// generate a rate limiter utility using a sliding window algorithm
```

#### 🐍 Python
```python
# create a FastAPI endpoint with request validation, error handling, and async database calls
```

#### 🤖 Agent Mode (multi-file)
```
Create a Sidebar navigation component with icons and active state,
add it to components/Sidebar.tsx, and integrate it into App.tsx with React Router
```
```
Build a dark mode toggle — create a ThemeContext, wrap App.tsx with it,
and add a toggle button to the Header component
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

## 🩺 Troubleshooting

<details>
<summary><strong>Sign in with Google doesn't work</strong></summary>

Make sure VS Code is allowed to open external URLs. Try:
1. `Ctrl+Shift+P` → `Developer: Toggle Developer Tools`
2. Check the Console tab for errors
3. Ensure no firewall is blocking ports 8080–8090
4. Try reloading VS Code (`Ctrl+Shift+P` → `Developer: Reload Window`) and signing in again

</details>

<details>
<summary><strong>Code generation does nothing when I press Ctrl+Shift+G</strong></summary>

- Make sure your cursor is on a line that contains a comment with a prompt
- Check that you have an active API key in Settings (⚙️)
- The file must be saved and have a supported extension (`.html`, `.js`, `.ts`, `.jsx`, `.tsx`, `.css`, `.py`, etc.)

</details>

<details>
<summary><strong>Inline suggestions don't appear</strong></summary>

- Run `Ctrl+Shift+P` → `Prompt2Code: Enable Inline Suggestions`
- Make sure you're typing in a supported language file
- If suggestions appear but flicker, increase `prompt2code.debounceMs` in settings to `600`

</details>

<details>
<summary><strong>"Rate limit exceeded" error</strong></summary>

You've hit the default usage limit. Fix:
1. Open the chat panel settings (⚙️)
2. Add your own API key from [console.groq.com](https://console.groq.com) (free, no credit card)
3. Your own key has much higher limits

</details>

<details>
<summary><strong>Agent mode creates files but doesn't modify existing ones</strong></summary>

For Agent mode to modify existing files, make sure:
- Your project is open as a **folder** in VS Code (`File → Open Folder`), not just individual files
- The files you want modified are inside that folder
- Be explicit: *"update App.tsx to import and use the new component"

</details>

---

## 🐛 Issues & Feedback

Found a bug or have a feature request?
→ [Open an issue on GitHub](https://github.com/Sujay149/Prompt2Code/issues)

---

## 📄 License

[MIT](LICENSE) © Sujay Babu Thota