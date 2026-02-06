# Groq Code Assistant - Quick Start

## Setup Instructions

### 1. Install Dependencies
```bash
npm install
```

### 2. Compile TypeScript
```bash
npm run compile
```

### 3. Run Extension
Press `F5` in VS Code to launch the Extension Development Host.

### 4. Configure API Key
1. Get your API key from [Groq Console](https://console.groq.com)
2. In the Extension Development Host, open Settings (`Ctrl+,`)
3. Search for "Groq API Key"
4. Paste your key

### 5. Test the Extension

#### Test 1: Chat Sidebar (NEW!)
1. Look for the chat icon (💬) in the Activity Bar (left side)
2. Click it to open the Groq AI Assistant sidebar
3. Type: "Create a function to validate email addresses"
4. Press Enter
5. See the AI response with formatted code
6. Click "Insert" or "Copy" buttons on code blocks

#### Test 2: Context-Aware Chat
1. Open any code file
2. Select a function or code block
3. Open chat sidebar
4. Ask: "Can you explain this code?"
5. AI will see your selected code and explain it!

#### Test 3: Instruction-Based Generation
1. Create a new HTML file
2. Type: `<!-- create a login form with email and password -->`
3. Press `Ctrl+Shift+G` (or `Cmd+Shift+G` on Mac)
4. Watch the code generate! ✨

#### Test 4: JavaScript Generation
1. Create a new JS file
2. Type: `// create a function to validate email addresses`
3. Press `Ctrl+Shift+G`

#### Test 5: React Component
1. Create a new `.jsx` file
2. Type: `// generate a Button component with props`
3. Press `Ctrl+Shift+G`

## Project Structure

```
groq-code-assistant/
├── src/
│   ├── extension.ts           # Main extension entry point
│   ├── groqClient.ts          # Groq API integration
│   ├── instructionDetector.ts # Detects instruction comments
│   └── promptBuilder.ts       # Builds AI prompts
├── .vscode/
│   ├── launch.json           # Debug configuration
│   └── tasks.json            # Build tasks
├── out/                      # Compiled JavaScript (auto-generated)
├── package.json              # Extension manifest
├── tsconfig.json            # TypeScript configuration
└── README.md                # Full documentation
```

## Available Commands

- `npm run compile` - Compile TypeScript
- `npm run watch` - Watch mode (auto-compile on save)
- `npm run lint` - Run ESLint

## Troubleshooting

**Extension doesn't activate:**
- Check the Debug Console for errors
- Ensure dependencies are installed: `npm install`
- Recompile: `npm run compile`

**API errors:**
- Verify your Groq API key is valid
- Check internet connection
- View error details in Debug Console

## Next Steps

1. ✅ Install dependencies
2. ✅ Compile the code
3. ✅ Test with F5
4. ✅ Configure API key
5. ✅ Try generating code!

## Publishing (Optional)

To package your extension:
```bash
npm install -g @vscode/vsce
vsce package
```

This creates a `.vsix` file you can share or publish to the marketplace.

---

Happy coding! 🚀
