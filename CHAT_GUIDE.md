# 💬 Chat Sidebar Feature Guide

## Overview

Your extension now includes a **GitHub Copilot Chat-style sidebar** where you can have natural conversations with the AI assistant!

---

## 🎯 How to Use the Chat Sidebar

### Opening the Chat

**Method 1: Activity Bar Icon**
1. Look for the chat icon (💬) in the Activity Bar (left side of VS Code)
2. Click it to open the Groq AI Assistant sidebar

**Method 2: Command Palette**
1. Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on Mac)
2. Type "Groq: Open Chat"
3. Press Enter

### Using the Chat

1. **Type your question** in the text input at the bottom
2. **Press Enter** or click "Send" button
3. **Get AI response** with formatted code blocks
4. **Continue the conversation** - the AI remembers previous messages

---

## ✨ Features

### 🔄 Context-Aware Responses

The chat automatically includes context from your active editor:

- **Selected code**: If you select code in the editor, it's included in your question
- **Current file**: The AI knows what file you're working in and its language

**Example workflow:**
1. Select a function in your code
2. Ask in chat: "How can I optimize this?"
3. AI sees your selection and provides specific suggestions

### 📝 Code Block Actions

Every code block in the response has two buttons:

- **Insert**: Insert the code at your cursor position
- **Copy**: Copy the code to your clipboard

### 💬 Conversation History

The AI remembers your conversation:
- Ask follow-up questions
- Reference previous responses
- Build on earlier suggestions

**Clear conversation**: Click the "Clear Chat" button in the header

---

## 🎨 UI Features

### Clean Interface

- **User messages**: Blue header, light background
- **AI responses**: Green header, formatted with markdown
- **Code blocks**: Syntax-highlighted with language labels
- **Loading indicator**: Animated dots while AI is thinking
- **Error messages**: Clear error display if something goes wrong

### Smart Formatting

The AI responses support:
- ✅ Code blocks with syntax highlighting
- ✅ Inline code: `like this`
- ✅ **Bold text**
- ✅ *Italic text*
- ✅ Multi-line code examples

---

## 💡 Example Conversations

### Example 1: Code Explanation

**You:** 
```
What does this function do?
```
*(with code selected in editor)*

**AI:** 
```
This function implements a binary search algorithm...
```

### Example 2: Bug Fixing

**You:**
```
I'm getting a TypeError on line 25. How do I fix it?
```

**AI:**
```javascript
The error occurs because you're trying to access...
Here's the corrected code:

// Fixed version
function safeLookup(obj, key) {
  return obj?.[key] ?? null;
}
```

### Example 3: Code Generation

**You:**
```
Create a React component that fetches and displays user data
```

**AI:**
```jsx
import React, { useState, useEffect } from 'react';

function UserProfile() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  
  // ... complete component with Insert/Copy buttons
}
```

### Example 4: Best Practices

**You:**
```
What's the best way to handle async errors in Node.js?
```

**AI:**
*(Provides explanation with code examples)*

---

## 🔧 Keyboard Shortcuts

- **Send message**: `Enter`
- **New line in message**: `Shift + Enter`
- **Focus chat**: Click in sidebar

---

## 🎯 Tips for Best Results

### 1. Be Specific
❌ "Help with code"
✅ "How do I validate email addresses in JavaScript?"

### 2. Use Context
- Select relevant code before asking
- Reference specific lines or files
- Include error messages

### 3. Follow-Up Questions
- "Can you explain that differently?"
- "Show me an example with TypeScript"
- "What about edge cases?"

### 4. Code Review
- Select your code
- Ask: "Can you review this for best practices?"
- Get specific improvements

### 5. Learning
- "Explain how async/await works"
- "What's the difference between map and forEach?"
- "When should I use this pattern?"

---

## 🔄 Workflow Integration

### Scenario 1: Debugging
1. Encounter error in code
2. Copy error message
3. Paste in chat: "I'm getting this error: [paste]"
4. Get explanation and fix
5. Click "Insert" to apply fix

### Scenario 2: Code Review
1. Select a function
2. Ask: "Can you improve this code?"
3. Review AI suggestions
4. Click "Insert" to apply changes

### Scenario 3: Learning New Syntax
1. Ask: "How do I use destructuring in JavaScript?"
2. Get explanation with examples
3. Click "Copy" on examples
4. Use in your code

### Scenario 4: Refactoring
1. Select old code
2. Ask: "Convert this to async/await"
3. Review new version
4. Click "Insert" to replace

---

## 🎨 UI Customization

The chat UI automatically adapts to your VS Code theme:
- Dark themes: Dark background, light text
- Light themes: Light background, dark text
- High contrast: Adjusted for accessibility

Colors use VS Code's native theme variables for perfect integration.

---

## ⚙️ Settings

All existing Groq settings apply to the chat:

```json
{
  "groq.apiKey": "your-api-key",
  "groq.model": "llama-3.1-70b-versatile",
  "groq.maxTokens": 512,
  "groq.temperature": 0.2
}
```

**Pro tip**: For chat, you might want higher `maxTokens` (e.g., 1024) for longer explanations.

---

## 🚀 Advanced Usage

### Multi-turn Conversations

Build on previous context:

**Turn 1:** "Create a function to fetch user data"
**Turn 2:** "Now add error handling"
**Turn 3:** "Make it work with TypeScript"

Each response builds on the previous ones!

### Code Insertion

1. Position your cursor where you want code
2. In chat, ask for what you need
3. Click "Insert" on the code block
4. Code appears at cursor position

### Clipboard Integration

Click "Copy" on any code block to copy to clipboard.
Paste anywhere with `Ctrl+V` / `Cmd+V`.

---

## ⚡ Performance

- **Response time**: Typically 200-500ms with Groq
- **Conversation history**: Kept in memory (cleared on chat clear)
- **Context size**: Includes up to selected code + file info

---

## 🐛 Troubleshooting

### Chat doesn't open
- Check if extension is activated
- Try reloading VS Code (`Ctrl+R` / `Cmd+R`)

### No response from AI
- Verify API key is set
- Check internet connection
- Look for errors in Debug Console

### Code insertion doesn't work
- Ensure you have an active editor
- Position cursor in editor first
- Try copying and pasting instead

### Slow responses
- Try `llama-3.1-8b-instant` model (faster)
- Check network connection
- Clear conversation to reduce context

---

## 🎓 Comparison with GitHub Copilot Chat

### Similar Features
✅ Sidebar chat interface
✅ Context-aware responses
✅ Code block formatting
✅ Insert/copy actions
✅ Conversation history

### Unique to Your Extension
🌟 **Groq-powered** (faster inference)
🌟 **Open source** (Llama models)
🌟 **Customizable** (full control)
🌟 **Free tier available**

---

## 📦 What's Under the Hood

### Architecture

```
User types message
       ↓
chatViewProvider.ts receives it
       ↓
Adds context (selected code, file info)
       ↓
groqClient.ts calls Groq API
       ↓
Response sent to webview
       ↓
HTML/CSS/JS renders formatted response
       ↓
User sees message with Insert/Copy buttons
```

### Files Involved

- **chatViewProvider.ts**: Main chat logic, message handling
- **groqClient.ts**: API calls (updated to support chat mode)
- **extension.ts**: Registers the chat view
- **package.json**: Defines sidebar view container

---

## 🎯 Next Steps

Now that you have the chat sidebar:

1. **Test it**: Press F5, open chat, ask questions
2. **Try context features**: Select code, ask about it
3. **Use Insert/Copy**: Generate code and insert it
4. **Have conversations**: Ask follow-up questions
5. **Clear when needed**: Start fresh conversations

---

## 🌟 Demo Script

**For showcasing to recruiters:**

1. Open VS Code with extension
2. Click chat icon in Activity Bar
3. Select a function in your code
4. Ask: "Can you explain this code?"
5. Show how AI sees the selected code
6. Generate improved version
7. Click "Insert" to apply changes
8. Ask follow-up: "Add error handling"
9. Show conversation history
10. Demonstrate Insert/Copy buttons

**Key talking points:**
- "I built a full chat interface using VS Code's webview API"
- "It includes context awareness - the AI sees my selected code"
- "Responses are formatted with markdown and code highlighting"
- "I added Insert and Copy actions for easy code integration"
- "Uses Groq for sub-second responses"

---

## 🎉 Summary

You now have a **complete AI coding assistant** with:

✅ **Sidebar chat interface** (like GitHub Copilot Chat)
✅ **Context-aware conversations**
✅ **Code block actions** (Insert/Copy)
✅ **Conversation history**
✅ **Full markdown formatting**
✅ **Theme integration**
✅ **Error handling**

**It's ready to use! Press F5 and start chatting!** 💬🚀
