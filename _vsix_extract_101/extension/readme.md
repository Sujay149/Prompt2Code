# Prompt2Code — AI Code Generation Inside VS Code

Turn natural language prompts into real code directly inside VS Code.

Think: Prompt → Code → Done.

## Why Prompt2Code?

- Generate code faster from plain English
- Context-aware (uses your current file & selection)
- Create full UI pages with CSS
- Chat with AI like Copilot Chat
- Works across multiple languages

## Key Features

### AI Chat Sidebar

Chat with AI directly inside VS Code:

- Ask coding questions
- Explain selected code
- Convert code between languages
- Generate components/pages and insert into the editor

Open it via:

- Click the chat icon in the Activity Bar
- Or run **Prompt2Code: Open Chat**

### Prompt → Code Generation (Core Feature)

Write instructions as comments, then run **Prompt2Code: Generate Code**.

Example:

```html
<!-- create a responsive registration form with full CSS -->
```

The extension replaces the instruction comment with generated code.

### Inline Code Completion

Copilot-style inline suggestions while typing. Press `Tab` to accept.

```javascript
function calculateTotal(items) {
  return items.
  // → AI suggests: reduce((sum, i) => sum + i.price, 0);
}
```

## Supported Prompt Patterns

Prompt2Code understands instructions written as comments:

| Language | Example |
|---|---|
| HTML | `<!-- create a navbar -->` |
| JS / TS | `// generate a login form` |
| CSS | `/* create a card UI */` |
| JSX / TSX | `// build a loading spinner` |

Best keywords: `create`, `generate`, `build`, `convert`, `update`

## Workflow

1. Open a file (e.g. `index.html`, `App.jsx`, `styles.css`, `script.js`)
2. Write a prompt in a comment
3. Run **Prompt2Code: Generate Code** (`Ctrl+Shift+G` / `Cmd+Shift+G`)
4. Iterate with another prompt

## Example Prompts

- `<!-- create a modern registration page with full CSS -->`
- `// generate a loading spinner component`
- `/* build a debounce function */`
- `/* create a card with hover animation */`

## Commands

| Command | Description |
|---|---|
| **Prompt2Code: Open Chat** | Open AI chat sidebar |
| **Prompt2Code: Generate Code** | Generate code from a prompt comment |
| **Prompt2Code: Enable Inline Suggestions** | Turn on inline AI |
| **Prompt2Code: Disable Inline Suggestions** | Turn off inline AI |

## Configuration

Configure via VS Code Settings → **Prompt2Code**:

| Setting | Description |
|---|---|
| `prompt2code.apiKey` | Your Groq API key |
| `prompt2code.model` | Groq model |
| `prompt2code.maxTokens` | Response length |
| `prompt2code.temperature` | Creativity level |
| `prompt2code.enableInlineCompletions` | Enable/disable inline AI |
| `prompt2code.debounceMs` | Inline completion debounce (ms) |

## Supported Languages

- HTML / CSS / SCSS
- JavaScript / TypeScript
- React (JSX / TSX)
- Python
- Java

## Privacy

- API calls go directly to the AI provider (Groq)
- No code is stored by this extension
- Your API key stays in your VS Code settings

## License

MIT