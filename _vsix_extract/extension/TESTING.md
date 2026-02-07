# Testing Guide for Groq Code Assistant

## Pre-Testing Setup

### 1. Get Groq API Key
1. Visit https://console.groq.com
2. Sign up for a free account
3. Navigate to API Keys
4. Create a new API key
5. Copy the key (you'll need it in step 4)

### 2. Start the Extension in Debug Mode
1. Open this project in VS Code
2. Press `F5` to launch Extension Development Host
3. A new VS Code window will open with the extension loaded

### 3. Configure API Key
In the Extension Development Host window:
1. Press `Ctrl+,` (or `Cmd+,` on Mac) to open Settings
2. Search for "Groq API Key"
3. Paste your API key
4. Close Settings

## Test Cases

### ✅ Test 1: HTML Form Generation

1. Open [demo.html](demo.html) in the Extension Development Host
2. Place cursor at end of this line:
   ```html
   <!-- create a responsive login form with email and password fields -->
   ```
3. Press `Ctrl+Shift+G` (Windows/Linux) or `Cmd+Shift+G` (Mac)
4. **Expected:** A complete HTML form appears with:
   - `<form>` tag
   - Email input with label
   - Password input with label
   - Submit button
   - No markdown formatting

### ✅ Test 2: JavaScript Function Generation

1. Open [demo.js](demo.js)
2. Place cursor at end of:
   ```javascript
   // create a function to validate email addresses
   ```
3. Press `Ctrl+Shift+G`
4. **Expected:** A complete email validation function

### ✅ Test 3: React Component Generation

1. Open [demo.jsx](demo.jsx)
2. Place cursor at end of:
   ```javascript
   // create a Button component with onClick and children props
   ```
3. Press `Ctrl+Shift+G`
4. **Expected:** A React functional component

### ✅ Test 4: Inline Completion

1. Create a new JavaScript file
2. Start typing:
   ```javascript
   function sum(a, b) {
     return a +
   ```
3. Wait a moment
4. **Expected:** Ghost text appears suggesting ` b;`
5. Press `Tab` to accept

### ✅ Test 5: Multi-line Comment

1. Create a new HTML file
2. Type:
   ```html
   /* create a footer with copyright and social links */
   ```
3. Press `Ctrl+Shift+G`
4. **Expected:** Footer HTML generated

### ✅ Test 6: Command Palette

1. Press `Ctrl+Shift+P` (or `Cmd+Shift+P`)
2. Type "Groq"
3. **Expected:** See these commands:
   - Groq: Generate Code from Instruction
   - Groq: Enable Inline Suggestions
   - Groq: Disable Inline Suggestions

### ✅ Test 7: Disable/Enable Inline

1. Run command: "Groq: Disable Inline Suggestions"
2. Try typing code - no suggestions should appear
3. Run command: "Groq: Enable Inline Suggestions"
4. Suggestions should work again

### ✅ Test 8: Error Handling (Invalid API Key)

1. Change API key to invalid value in settings
2. Try generating code
3. **Expected:** Error message appears: "Invalid Groq API key"

## What to Look For

### ✅ Success Indicators
- Code generates in <500ms
- No markdown code blocks (` ```html ` etc.)
- Code is syntactically valid
- Indentation is clean
- No explanatory text, just code

### ❌ Failure Indicators
- Code wrapped in markdown blocks
- Explanations or comments added by AI
- Invalid syntax
- API errors in Debug Console
- Timeout (>5 seconds)

## Debugging

### View Logs
1. In Extension Development Host
2. Help → Toggle Developer Tools
3. Go to Console tab
4. Look for errors or Groq API responses

### Common Issues

**No code generates:**
- Check API key is valid
- Check Debug Console for errors
- Verify internet connection

**Code has markdown:**
- Shouldn't happen - the cleanResponse function strips it
- Report as bug if it occurs

**Slow generation:**
- Groq should be fast (<500ms typically)
- Check network latency
- Try different model in settings

## Performance Testing

### Expected Speed
- HTML form: ~200-400ms
- JavaScript function: ~150-300ms
- React component: ~300-500ms

### Test Different Models

Try each model and compare speed/quality:

1. `llama-3.1-70b-versatile` (default, best quality)
2. `llama-3.1-8b-instant` (faster, simpler code)
3. `mixtral-8x7b-32768` (good balance)

Change in Settings → Groq: Model

## Advanced Testing

### Test with Selection

1. Type an instruction without comment syntax:
   ```
   create a navbar
   ```
2. Select the text
3. Press `Ctrl+Shift+G`
4. **Expected:** Code generates

### Test Different Languages

Test in files with these extensions:
- `.html` - HTML
- `.css` - CSS
- `.js` - JavaScript
- `.ts` - TypeScript
- `.jsx` - React JSX
- `.tsx` - React TSX

### Test Edge Cases

1. **Empty instruction:**
   ```html
   <!-- create -->
   ```
   Should generate something or show message

2. **Long instruction:**
   ```html
   <!-- create a complex multi-step registration form with name, email, password, password confirmation, phone number with country code selector, address fields including street, city, state, zip code, and terms of service checkbox -->
   ```
   Should handle gracefully

3. **Cursor in middle of comment:**
   ```html
   <!-- create a| login form -->
   ```
   (| = cursor)
   Should still detect and generate

## Final Checklist

Before submitting/demoing:

- [ ] All test cases pass
- [ ] No markdown in output
- [ ] Response time <500ms
- [ ] Commands work from palette
- [ ] Keybindings work
- [ ] Settings editable
- [ ] Error messages clear
- [ ] Works in multiple languages
- [ ] Inline completion works
- [ ] Can disable/enable inline

## Reporting Issues

If you find bugs, note:
1. What you typed
2. What you expected
3. What actually happened
4. Error messages (from Debug Console)
5. Model used
6. File type

---

Happy testing! 🚀
