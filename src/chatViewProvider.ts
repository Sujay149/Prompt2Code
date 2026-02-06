import * as vscode from 'vscode';
import * as path from 'path';
import { GroqClient, GroqMessage } from './groqClient';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'groq.chatView';

  private _view?: vscode.WebviewView;
  private groqClient: GroqClient;
  private conversationHistory: GroqMessage[] = [];
  private lastTextEditor?: vscode.TextEditor;
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly _extensionUri: vscode.Uri) {
    this.groqClient = new GroqClient();
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView
  ) {
    this._view = webviewView;

    // Track the last active text editor so code-intent works even
    // when focus is inside the chat webview.
    this.lastTextEditor = vscode.window.activeTextEditor;
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) this.lastTextEditor = editor;
      })
    );
    webviewView.onDidDispose(() => {
      for (const d of this.disposables) d.dispose();
      this.disposables = [];
    });

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (data) => {
      console.log('Webview → Extension:', data);

      switch (data.type) {
        case 'sendMessage':
          await this.handleUserMessage(data.message);
          break;

        case 'clearChat':
          this.clearConversation();
          break;

        case 'insertCode':
          this.insertCodeToEditor(data.code);
          break;

        case 'copyCode':
          await vscode.env.clipboard.writeText(data.code);
          vscode.window.showInformationMessage('Code copied to clipboard');
          break;
      }
    });
  }

  // ===========================
  // MESSAGE HANDLING
  // ===========================

  private async handleUserMessage(message: string) {
    if (!message || !message.trim()) return;

    console.log('📨 Handling message:', message);

    // 1️⃣ Show user message immediately
    this._view?.webview.postMessage({
      type: 'userMessage',
      message
    });

    // 2️⃣ Save conversation (for chat mode history)
    this.conversationHistory.push({ role: 'user', content: message });

    // 3️⃣ Show loading
    this._view?.webview.postMessage({
      type: 'loading',
      isLoading: true
    });

    try {
      // ⚠️ CHECK API KEY FIRST
      const apiKey = vscode.workspace.getConfiguration('groq').get<string>('apiKey', '');
      console.log('🔑 API Key configured:', apiKey ? 'YES' : 'NO');

      if (!apiKey || apiKey.trim() === '') {
        throw new Error('⚠️ Groq API key not configured. Please set it in Settings → Groq: Api Key\n\nGet your free API key at: https://console.groq.com');
      }

      const editor = this.getTargetEditor();
      const doc = editor?.document;
      const languageId = doc?.languageId ?? 'plaintext';

      const isCodeIntent = this.isCodeEditIntent(message);

      if (isCodeIntent) {
        if (!editor || !doc) {
          vscode.window.showWarningMessage('Open an editor tab to update code.');
          this._view?.webview.postMessage({
            type: 'error',
            message: 'No active editor found. Open a file, then try again.'
          });
          return;
        }

        console.log('🚀 Calling Groq API (code generation mode)...');

        const target = this.determineTargetLanguage(doc.languageId, message);
        const context = await this.buildCodebaseContext(doc, { targetLanguageId: target.languageId, instruction: message });
        const newCode = await this.groqClient.generateCode(
          message,
          target.promptLanguage,
          context
        );

        await this.replaceFullDocument(editor, newCode);

        // If user asked for React while editing HTML, switch language mode for better UX.
        if (target.languageId && target.languageId !== doc.languageId) {
          try {
            await vscode.languages.setTextDocumentLanguage(doc, target.languageId);
          } catch {
            // Non-fatal.
          }
        }
        vscode.window.showInformationMessage('Code updated in editor');

        // Copilot-like feedback without showing generated code.
        this._view?.webview.postMessage({
          type: 'assistantMessage',
          message: 'Code updated in editor.'
        });

        // Chat is for explanations only; do NOT render generated code in chat.
        return;
      }

      // Chat / explanation mode
      let contextInfo = '';
      if (doc) {
        contextInfo = `\n\nCurrent file: ${doc.fileName} (${languageId})`;
      }

      const messages: GroqMessage[] = [
        {
          role: 'system',
          content:
            'You are a helpful coding assistant. Explain clearly. Use minimal markdown. Avoid fenced code blocks.'
        },
        ...this.conversationHistory.slice(0, -1),
        { role: 'user', content: message + contextInfo }
      ];

      console.log('🚀 Calling Groq API (chat mode)...');
      const rawResponse = await this.groqClient.complete(messages, false);
      const response = this.sanitizeChatResponse(rawResponse);
      console.log('✅ Got response:', response.substring(0, 100) + '...');

      this.conversationHistory.push({ role: 'assistant', content: response });

      this._view?.webview.postMessage({ type: 'assistantMessage', message: response });

    } catch (err: any) {
      console.error('❌ Error:', err);

      const errorMsg = err.message || 'Failed to get response. Please check your API key and network connection.';

      this._view?.webview.postMessage({
        type: 'error',
        message: errorMsg
      });
    } finally {
      this._view?.webview.postMessage({
        type: 'loading',
        isLoading: false
      });
    }
  }

  private getTargetEditor(): vscode.TextEditor | undefined {
    return (
      vscode.window.activeTextEditor ??
      this.lastTextEditor ??
      vscode.window.visibleTextEditors?.[0]
    );
  }

  private isCodeEditIntent(userMessage: string): boolean {
    // Keyword-based intent detection (minimal + robust).
    return /\b(change|update|modify|replace|create|generate|convert)\b/i.test(userMessage);
  }

  private determineTargetLanguage(
    currentLanguageId: string,
    instruction: string
  ): { languageId?: string; promptLanguage: string } {
    const text = instruction.toLowerCase();

    // React intent
    if (/(\breact\b|\bjsx\b|\btsx\b)/i.test(text)) {
      // Default to TSX because this extension is TS-based.
      const wantsJsx = /\bjsx\b|\bjavascript\b/i.test(text) && !/\btypescript\b|\btsx\b/i.test(text);
      return wantsJsx
        ? { languageId: 'javascriptreact', promptLanguage: 'javascriptreact' }
        : { languageId: 'typescriptreact', promptLanguage: 'typescriptreact' };
    }

    // Otherwise keep current
    return { languageId: currentLanguageId, promptLanguage: currentLanguageId };
  }

  private sanitizeChatResponse(text: string): string {
    // Prevent chat from showing fenced markers. We keep the content but remove
    // the ``` fences so it stays readable in a plain-text webview.
    return text.replace(/```[a-zA-Z0-9_+-]*\s*/g, '').trim();
  }

  private async buildCodebaseContext(
    doc: vscode.TextDocument,
    hints?: { targetLanguageId?: string; instruction?: string }
  ): Promise<string> {
    // Keep context bounded to avoid huge prompts.
    const MAX_CONTEXT_CHARS = 60_000;
    const MAX_RELATED_FILES = 10;
    const MAX_FILE_CHARS = 12_000;

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(doc.uri);
    const rootPath = workspaceFolder?.uri.fsPath;

    const currentRel = rootPath
      ? path.relative(rootPath, doc.uri.fsPath)
      : doc.uri.fsPath;

    const sections: string[] = [];
    const included = new Set<string>();

    const addSection = (fileLabel: string, content: string) => {
      if (included.has(fileLabel)) return;
      included.add(fileLabel);

      const clipped = content.length > MAX_FILE_CHARS
        ? content.slice(0, MAX_FILE_CHARS) + '\n\n/* ...truncated... */\n'
        : content;

      sections.push(`--- FILE: ${fileLabel} ---\n${clipped}`);
    };

    // Always include the active file in full (or truncated).
    addSection(currentRel, doc.getText());

    // Add a short conversion hint to help the model transform formats (e.g., HTML -> React)
    if (hints?.targetLanguageId && hints.targetLanguageId !== doc.languageId) {
      sections.unshift(
        [
          '--- INSTRUCTION HINTS ---',
          `Current language: ${doc.languageId}`,
          `Target language: ${hints.targetLanguageId}`,
          hints.instruction ? `User instruction: ${hints.instruction}` : '' ,
          'If converting HTML to React: output a single React functional component, use JSX/TSX, convert class -> className, inline minimal state/handlers only if required.',
          'Output ONLY code. No markdown. No explanations.'
        ].filter(Boolean).join('\n')
      );
    }

    if (!rootPath) {
      // No workspace folder (single file). Return only current file context.
      return sections.join('\n\n').slice(0, MAX_CONTEXT_CHARS);
    }

    const relatedPaths = this.findLocalReferences(doc);
    const uniqueRelated = Array.from(new Set(relatedPaths)).slice(0, MAX_RELATED_FILES);

    for (const relRef of uniqueRelated) {
      const normalized = relRef.replace(/\\/g, '/');
      if (normalized.startsWith('node_modules/') || normalized.startsWith('out/') || normalized.startsWith('dist/')) {
        continue;
      }

      const abs = path.resolve(rootPath, relRef);
      if (!abs.startsWith(rootPath)) continue;

      const text = await this.tryReadTextFile(abs);
      if (!text) continue;

      addSection(relRef, text);

      if (sections.join('\n\n').length >= MAX_CONTEXT_CHARS) break;
    }

    const context = sections.join('\n\n');
    return context.length > MAX_CONTEXT_CHARS ? context.slice(0, MAX_CONTEXT_CHARS) : context;
  }

  private findLocalReferences(doc: vscode.TextDocument): string[] {
    const text = doc.getText();
    const refs: string[] = [];

    // JS/TS imports: import x from './x' / require('./x')
    if (['javascript', 'typescript', 'javascriptreact', 'typescriptreact'].includes(doc.languageId)) {
      const importRe = /(?:from\s+|require\()\s*['"](\.?\.\/[^'"\)]+)['"]/g;
      let match: RegExpExecArray | null;
      while ((match = importRe.exec(text))) {
        refs.push(...this.expandCandidatePaths(doc, match[1]));
      }
    }

    // HTML local asset refs: <script src>, <link href>, <img src>
    if (doc.languageId === 'html') {
      const htmlRe = /\b(?:src|href)\s*=\s*['"](\.?\.\/[^'"]+)['"]/g;
      let match: RegExpExecArray | null;
      while ((match = htmlRe.exec(text))) {
        refs.push(...this.expandCandidatePaths(doc, match[1]));
      }
    }

    return refs;
  }

  private expandCandidatePaths(doc: vscode.TextDocument, rawRef: string): string[] {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(doc.uri);
    const rootPath = workspaceFolder?.uri.fsPath;
    if (!rootPath) return [];

    const docDir = path.dirname(doc.uri.fsPath);
    const resolved = path.resolve(docDir, rawRef);
    if (!resolved.startsWith(rootPath)) return [];

    const rel = path.relative(rootPath, resolved);
    const candidates: string[] = [];

    // If ref already has extension, use as-is.
    if (path.extname(rel)) {
      candidates.push(rel);
      return candidates;
    }

    // Try common extensions.
    const exts = ['.ts', '.tsx', '.js', '.jsx', '.css', '.html', '.json'];
    for (const ext of exts) {
      candidates.push(rel + ext);
    }

    // Also consider index files in folders.
    for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
      candidates.push(path.join(rel, 'index' + ext));
    }

    return candidates;
  }

  private async tryReadTextFile(absPath: string): Promise<string | null> {
    try {
      const uri = vscode.Uri.file(absPath);
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = new TextDecoder('utf-8').decode(bytes);
      return text;
    } catch {
      return null;
    }
  }

  private async replaceFullDocument(
    editor: vscode.TextEditor,
    newText: string
  ): Promise<void> {
    const doc = editor.document;
    const fullRange = new vscode.Range(
      doc.positionAt(0),
      doc.positionAt(doc.getText().length)
    );

    const ok = await editor.edit((editBuilder) => {
      editBuilder.replace(fullRange, newText);
    });

    if (!ok) {
      throw new Error('Failed to update the document.');
    }
  }

  // ===========================
  // UTILITIES
  // ===========================

  private clearConversation() {
    this.conversationHistory = [];
    this._view?.webview.postMessage({ type: 'clearMessages' });
  }

  private insertCodeToEditor(code: string) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('No active editor');
      return;
    }

    editor.edit(editBuilder => {
      editBuilder.insert(editor.selection.active, code);
    });
  }

  // ===========================
  // WEBVIEW HTML
  // ===========================

  private getHtml(webview: vscode.Webview): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  body {
    font-family: var(--vscode-font-family);
    background: var(--vscode-sideBar-background);
    color: var(--vscode-foreground);
    height: 100vh;
    display: flex;
    flex-direction: column;
  }
  .header {
    padding: 10px;
    display: flex;
    justify-content: space-between;
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  .chat {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
  }
  .msg {
    margin-bottom: 12px;
  }
  .user { color: #3794ff; }
  .assistant { color: #89d185; }
  .bubble {
    background: var(--vscode-editor-background);
    padding: 8px 10px;
    border-radius: 6px;
    border: 1px solid var(--vscode-panel-border);
    white-space: pre-wrap;
  }
  .input {
    border-top: 1px solid var(--vscode-panel-border);
    padding: 10px;
    display: flex;
    gap: 8px;
  }
  textarea {
    flex: 1;
    resize: none;
    padding: 8px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
  }
  button {
    padding: 8px 14px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.5;
  }
</style>
</head>

<body>
  <div class="header">
    <strong>AI Assistant</strong>
    <button id="clear">Clear</button>
  </div>

  <div class="chat" id="chat"></div>

  <div class="input">
    <textarea id="input" rows="2" placeholder="Ask something..."></textarea>
    <button id="send">Send</button>
  </div>

<script>
  const vscode = acquireVsCodeApi();
  const chat = document.getElementById('chat');
  const input = document.getElementById('input');
  const send = document.getElementById('send');
  const clear = document.getElementById('clear');

  let loading = false;

  send.onclick = () => {
    if (!input.value.trim() || loading) return;
    vscode.postMessage({ type: 'sendMessage', message: input.value });
    input.value = '';
  };

  clear.onclick = () => {
    vscode.postMessage({ type: 'clearChat' });
  };

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send.click();
    }
  });

  window.addEventListener('message', event => {
    const msg = event.data;

    if (msg.type === 'userMessage') add('You', msg.message, 'user');
    if (msg.type === 'assistantMessage') add('AI', msg.message, 'assistant');
    if (msg.type === 'loading') {
      loading = msg.isLoading;
      send.disabled = loading;
    }
    if (msg.type === 'clearMessages') chat.innerHTML = '';
    if (msg.type === 'error') add('Error', msg.message, 'assistant');
  });

  function add(title, text, cls) {
    const div = document.createElement('div');
    div.className = 'msg ' + cls;

    const strong = document.createElement('strong');
    strong.textContent = title;

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;

    div.appendChild(strong);
    div.appendChild(bubble);
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
  }
</script>
</body>
</html>`;
  }
}
