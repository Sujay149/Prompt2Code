import * as vscode from 'vscode';
import * as path from 'path';
import { GroqClient, GroqMessage } from './groqClient';
import {
  listWorkspaceFiles,
  createWorkspaceFile,
  buildProjectTree,
  readFilesAsContext,
  extractFileReferences,
  stripFileReferences,
  gatherProjectContext,
} from './workspaceHelper';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'prompt2code.chatView';

  private _view?: vscode.WebviewView;
  private groqClient: GroqClient;
  private conversationHistory: GroqMessage[] = [];
  private lastTextEditor?: vscode.TextEditor;
  private disposables: vscode.Disposable[] = [];

  /** Checkpoint store: id → { uri, content } for undo/restore. */
  private checkpoints = new Map<string, { uri: vscode.Uri; content: string }>();
  private checkpointCounter = 0;

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
    this.sendActiveFileToWebview(this.lastTextEditor);
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) {
          this.lastTextEditor = editor;
          this.sendActiveFileToWebview(editor);
        }
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
          await this.handleUserMessage(data.message, data.attachedFiles || []);
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

        case 'pickFile':
          await this.handlePickFile();
          break;

        case 'removeTrackedFile':
          // User removed the tracked file chip — nothing to do server-side
          break;

        case 'trimHistory': {
          // User clicked "Edit" on a message — trim conversation from that point
          const idx = this.conversationHistory.findIndex(
            m => m.role === 'user' && m.content === data.content
          );
          if (idx >= 0) {
            this.conversationHistory = this.conversationHistory.slice(0, idx);
          }
          break;
        }

        case 'checkpointAction': {
          const cp = this.checkpoints.get(data.id);
          if (!cp) { break; }
          if (data.action === 'discard') {
            // Restore file to checkpoint content
            try {
              const doc = await vscode.workspace.openTextDocument(cp.uri);
              const editor = await vscode.window.showTextDocument(doc);
              const fullRange = new vscode.Range(
                doc.positionAt(0),
                doc.positionAt(doc.getText().length)
              );
              await editor.edit(eb => { eb.replace(fullRange, cp.content); });
              vscode.window.showInformationMessage('Restored to checkpoint');
            } catch {
              vscode.window.showErrorMessage('Failed to restore checkpoint');
            }
          }
          // Either way, clean up the checkpoint
          this.checkpoints.delete(data.id);
          break;
        }
      }
    });
  }

  /** Send the currently active file info to the webview so it can show a chip. */
  private sendActiveFileToWebview(editor?: vscode.TextEditor) {
    if (!this._view) { return; }
    if (!editor) {
      this._view.webview.postMessage({ type: 'activeFile', fileName: null, relPath: null, languageId: null });
      return;
    }
    const doc = editor.document;
    const ws = vscode.workspace.getWorkspaceFolder(doc.uri);
    const relPath = ws
      ? path.relative(ws.uri.fsPath, doc.uri.fsPath).replace(/\\/g, '/')
      : path.basename(doc.uri.fsPath);
    this._view.webview.postMessage({
      type: 'activeFile',
      fileName: path.basename(doc.uri.fsPath),
      relPath,
      languageId: doc.languageId,
    });
  }

  // ===========================
  // MESSAGE HANDLING
  // ===========================

  private async handleUserMessage(message: string, attachedFiles: string[] = []) {
    if (!message || !message.trim()) return;

    console.log('📨 Handling message:', message, 'attached:', attachedFiles);

    // 1️⃣ Show user message immediately (checkpointId attached later for code-edit path)
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
      const apiKey = vscode.workspace.getConfiguration('prompt2code').get<string>('apiKey', '');
      console.log('🔑 API Key configured:', apiKey ? 'YES' : 'NO');

      if (!apiKey || apiKey.trim() === '') {
        throw new Error('⚠️ Groq API key not configured. Please set it in Settings → Prompt2Code: Api Key\n\nGet your free API key at: https://console.groq.com');
      }

      // ── Resolve @file / #file: references ──
      const fileRefs = extractFileReferences(message);
      const cleanMessage = stripFileReferences(message);

      // Merge explicitly attached files (from the chip) with @file refs
      const allFileRefs = [...new Set([...fileRefs, ...attachedFiles])];

      let referencedFilesContext = '';
      if (allFileRefs.length > 0) {
        referencedFilesContext = await readFilesAsContext(allFileRefs);
      }

      // ── Detect "create file" intent ──
      const createFileMatch = this.detectCreateFileIntent(cleanMessage);

      if (createFileMatch) {
        await this.handleCreateFile(cleanMessage, createFileMatch, referencedFilesContext);
        return;
      }

      // ── Detect code-edit intent (existing behaviour) ──
      const editor = this.getTargetEditor();
      const doc = editor?.document;
      const languageId = doc?.languageId ?? 'plaintext';
      const isCodeIntent = this.isCodeEditIntent(cleanMessage)
        || (attachedFiles.length > 0 && !/\b(explain|what|why|how|describe|tell|show|list|help|question|ask)\b/i.test(cleanMessage));

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

        const target = this.determineTargetLanguage(doc.languageId, cleanMessage);

        // Build context: current file + referenced files + auto-scanned project files
        const contextParts: string[] = [];
        if (referencedFilesContext) { contextParts.push(referencedFilesContext); }
        const baseCtx = await this.buildCodebaseContext(doc, { targetLanguageId: target.languageId, instruction: cleanMessage }, true);
        contextParts.push(baseCtx);

        // Auto-scan: gather same-language project files, configs, open tabs
        // Budget is driven by the model's token window
        const ctxCharBudget = this.groqClient.getContextCharBudget();
        const projectCtx = await gatherProjectContext({
          languageId: target.languageId || doc.languageId,
          currentFilePath: doc.uri.fsPath,
          maxChars: Math.min(ctxCharBudget, 40_000),
          maxFiles: 8,
        });
        if (projectCtx.text) { contextParts.push(projectCtx.text); }

        // Show "working" status in chat
        this._view?.webview.postMessage({
          type: 'assistantMessage',
          message: '⏳ Generating code — watch the editor for live changes…'
        });

        // 💾 Save checkpoint before modifying the editor
        const cpId = String(++this.checkpointCounter);
        this.checkpoints.set(cpId, { uri: doc.uri, content: doc.getText() });

        // Link this checkpoint to the last user message so the restore button works
        this._view?.webview.postMessage({ type: 'linkCheckpoint', checkpointId: cpId });

        // Capture the current file content for UPDATE mode —
        // the AI will modify this rather than regenerating from scratch.
        const currentFileContent = doc.getText();

        // Stream code directly into the editor
        const updater = this.makeStreamUpdater(editor, 200);
        const newCode = await this.groqClient.generateCodeStreaming(
          cleanMessage,
          target.promptLanguage,
          updater.onChunk,
          contextParts.join('\n\n'),
          currentFileContent // ← tells the AI to UPDATE, not regenerate
        );

        // Wait for any in-flight edit, then do the final write
        await updater.flush();
        await this.replaceFullDocument(editor, newCode, 5);

        // If user asked for React while editing HTML, switch language mode for better UX.
        if (target.languageId && target.languageId !== doc.languageId) {
          try {
            await vscode.languages.setTextDocumentLanguage(doc, target.languageId);
          } catch {
            // Non-fatal.
          }
        }
        vscode.window.showInformationMessage('Code updated in editor');

        this._view?.webview.postMessage({
          type: 'assistantMessage',
          message: '✅ Code updated in editor.'
        });

        // Show Keep / Undo checkpoint banner
        this._view?.webview.postMessage({ type: 'checkpoint', id: cpId });

        return;
      }

      // ── Chat / explanation mode ──
      let contextInfo = '';
      if (doc) {
        contextInfo = `\n\nCurrent file: ${doc.fileName} (${languageId})`;
      }
      if (referencedFilesContext) {
        contextInfo += `\n\nReferenced files:\n${referencedFilesContext}`;
      }

      // If user typed @workspace or the message asks about the project structure,
      // attach a compact project tree.
      if (/(@workspace|project structure|codebase|all files)/i.test(message)) {
        const tree = await buildProjectTree();
        contextInfo += `\n\nProject files:\n${tree}`;
      }

      // Always include some project context so the AI understands the codebase
      const chatCharBudget = this.groqClient.getContextCharBudget();
      const projCtx = await gatherProjectContext({
        languageId: doc?.languageId,
        currentFilePath: doc?.uri.fsPath,
        maxChars: Math.min(chatCharBudget, 15_000),
        maxFiles: 5,
      });
      if (projCtx.text) {
        contextInfo += `\n\nProject context (${projCtx.fileCount} files):\n${projCtx.text}`;
      }

      const messages: GroqMessage[] = [
        {
          role: 'system',
          content:
            'You are a helpful coding assistant. Explain clearly. Use minimal markdown. Avoid fenced code blocks.'
        },
        ...this.conversationHistory.slice(0, -1),
        { role: 'user', content: cleanMessage + contextInfo }
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

  // ===========================
  // CREATE FILE FROM CHAT
  // ===========================

  /**
   * Detect if the user wants to create a new file.
   * Returns the desired filename / relative path, or null.
   */
  private detectCreateFileIntent(msg: string): string | null {
    // "create file src/utils/helpers.ts" / "create a new file called App.jsx"
    const patterns = [
      /\bcreate\s+(?:a\s+)?(?:new\s+)?file\s+(?:called\s+|named\s+)?([^\s,]+\.\w+)/i,
      /\bnew\s+file\s+(?:called\s+|named\s+)?([^\s,]+\.\w+)/i,
      /\bgenerate\s+(?:a\s+)?(?:new\s+)?file\s+(?:called\s+|named\s+)?([^\s,]+\.\w+)/i,
      /\bmake\s+(?:a\s+)?(?:new\s+)?file\s+(?:called\s+|named\s+)?([^\s,]+\.\w+)/i,
      /\badd\s+(?:a\s+)?(?:new\s+)?file\s+(?:called\s+|named\s+)?([^\s,]+\.\w+)/i,
    ];
    for (const re of patterns) {
      const m = re.exec(msg);
      if (m) { return m[1]; }
    }
    return null;
  }

  /**
   * Ask the AI to generate file content, then create + open the file in the editor.
   */
  private async handleCreateFile(
    instruction: string,
    relPath: string,
    referencedFilesContext: string
  ): Promise<void> {
    const ext = path.extname(relPath).slice(1) || 'txt';
    const langMap: Record<string, string> = {
      ts: 'typescript', tsx: 'typescriptreact', js: 'javascript', jsx: 'javascriptreact',
      html: 'html', css: 'css', scss: 'scss', py: 'python', java: 'java',
      json: 'json', md: 'markdown', sql: 'sql', go: 'go', rs: 'rust',
    };
    const language = langMap[ext] || ext;

    // Build context: referenced files + auto-scanned project codebase
    const contextParts: string[] = [];
    if (referencedFilesContext) { contextParts.push(referencedFilesContext); }

    // Auto-scan: configs + same-language files + open tabs
    const createCharBudget = this.groqClient.getContextCharBudget();
    const projectCtx = await gatherProjectContext({
      languageId: language,
      maxChars: Math.min(createCharBudget, 30_000),
      maxFiles: 8,
    });
    if (projectCtx.text) { contextParts.push(projectCtx.text); }

    console.log(`🚀 Generating new file: ${relPath}`);

    // Create an empty file first so user sees the editor open immediately
    const editor = await createWorkspaceFile(relPath, `// Generating ${relPath}...\n`);

    if (!editor) {
      this._view?.webview.postMessage({
        type: 'error',
        message: `Failed to create ${relPath}.`
      });
      return;
    }

    this._view?.webview.postMessage({
      type: 'assistantMessage',
      message: `⏳ Creating **${relPath}** — watch the editor for live output…`
    });

    // 💾 Save checkpoint (empty file state) before streaming
    const cpId = String(++this.checkpointCounter);
    this.checkpoints.set(cpId, { uri: editor.document.uri, content: editor.document.getText() });

    // Stream into the newly created file
    const updater = this.makeStreamUpdater(editor, 200);
    const code = await this.groqClient.generateCodeStreaming(
      instruction,
      language,
      updater.onChunk,
      contextParts.join('\n\n')
    );

    // Wait for any in-flight edit, then do the final write
    await updater.flush();
    await this.replaceFullDocument(editor, code, 5);

    vscode.window.showInformationMessage(`Created ${relPath}`);
    this._view?.webview.postMessage({
      type: 'assistantMessage',
      message: `✅ Created and opened **${relPath}** in the editor.`
    });

    // Show Keep / Undo checkpoint banner
    this._view?.webview.postMessage({ type: 'checkpoint', id: cpId });
  }

  private getTargetEditor(): vscode.TextEditor | undefined {
    return (
      vscode.window.activeTextEditor ??
      this.lastTextEditor ??
      vscode.window.visibleTextEditors?.[0]
    );
  }

  private isCodeEditIntent(userMessage: string): boolean {
    // If the user wants to create a *new* file, that's handled separately.
    if (this.detectCreateFileIntent(userMessage)) { return false; }
    // Broad keyword-based intent detection — anything that sounds like
    // an action on code should go to the editor, not chat.
    return /\b(change|update|modify|replace|create|generate|convert|enhance|improve|refactor|fix|optimise|optimize|rewrite|redesign|style|beautify|add|remove|delete|implement|build|make|write|edit|transform|migrate|upgrade|redo|revamp|restyle|tweak|adjust|clean|format|lint|minify|simplify|extend|expand|rework|overhaul|design|code|develop|scaffold|setup|set\s*up)\b/i.test(userMessage);
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
    hints?: { targetLanguageId?: string; instruction?: string },
    skipCurrentFile: boolean = false
  ): Promise<string> {
    // Keep context bounded — respect the model's token window
    const charBudget = this.groqClient.getContextCharBudget();
    const MAX_CONTEXT_CHARS = Math.min(charBudget, 30_000);
    const MAX_RELATED_FILES = 6;
    const MAX_FILE_CHARS = Math.min(Math.floor(charBudget / 3), 8_000);

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

    // Include the active file only if we're NOT passing it separately via currentFileContent.
    if (!skipCurrentFile) {
      addSection(currentRel, doc.getText());
    }

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
      const importRe = /(?:from\s+|require\()\s*['"](\.?\.\/[^'")]+)['"]/g;
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

  /**
   * Replace the full document content with retry logic.
   * Uses undoStopBefore/After: false so rapid streaming edits don't
   * pollute the undo stack or collide with each other.
   */
  private async replaceFullDocument(
    editor: vscode.TextEditor,
    newText: string,
    retries = 3
  ): Promise<boolean> {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const doc = editor.document;
        const fullRange = new vscode.Range(
          doc.positionAt(0),
          doc.positionAt(doc.getText().length)
        );
        const ok = await editor.edit(
          (eb) => { eb.replace(fullRange, newText); },
          { undoStopBefore: false, undoStopAfter: false }
        );
        if (ok) { return true; }
      } catch {
        // editor disposed or otherwise unavailable
      }
      // Small delay before retry so VS Code can finish any pending edit
      await new Promise(r => setTimeout(r, 120));
    }
    console.warn('replaceFullDocument: all retries exhausted');
    return false;
  }

  /**
   * Helper: creates a serialised queue so only one editor.edit()
   * is in-flight at a time. Returns a callback suitable for the
   * streaming `onChunk` parameter.
   */
  private makeStreamUpdater(
    editor: vscode.TextEditor,
    minChars = 200
  ): { onChunk: (accumulated: string) => void; flush: () => Promise<void> } {
    let pending: string | null = null;
    let lastLen = 0;
    let busy = false;

    const apply = async () => {
      if (busy || pending === null) { return; }
      busy = true;
      const text = pending;
      pending = null;
      await this.replaceFullDocument(editor, text, 2);
      busy = false;
      // If more text arrived while we were writing, go again
      if (pending !== null) { apply(); }
    };

    return {
      onChunk(accumulated: string) {
        if (accumulated.length - lastLen < minChars) { return; }
        lastLen = accumulated.length;
        pending = accumulated;
        apply();
      },
      async flush() {
        // Wait for any in-flight edit before the final write
        while (busy) { await new Promise(r => setTimeout(r, 80)); }
      }
    };
  }

  // ===========================
  // UTILITIES
  // ===========================

  private async handlePickFile() {
    const files = await listWorkspaceFiles(200);
    if (files.length === 0) {
      vscode.window.showInformationMessage('No workspace files found.');
      return;
    }

    const picked = await vscode.window.showQuickPick(files, {
      placeHolder: 'Select a file to include as context (@file)',
      canPickMany: true,
    });

    if (picked && picked.length > 0) {
      const refs = picked.map(f => `@file ${f}`).join(' ');
      this._view?.webview.postMessage({ type: 'insertFileRef', ref: refs });
    }
  }

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

  private getHtml(_webview: vscode.Webview): string {
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
    align-items: center;
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  .header-actions { display: flex; gap: 6px; }
  .chat {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
  }
  .msg {
    margin-bottom: 14px;
  }
  .msg .msg-label {
    font-size: 12px;
    font-weight: 600;
    color: var(--vscode-foreground);
    opacity: 0.85;
  }
  .msg.user .msg-label { opacity: 1; }
  .msg.assistant .msg-label { opacity: 0.7; }
  .bubble {
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 8px 10px;
    border-radius: 6px;
    border: 1px solid var(--vscode-panel-border);
    white-space: pre-wrap;
    font-size: 13px;
    line-height: 1.5;
  }
  .msg.user .bubble {
    background: var(--vscode-input-background, var(--vscode-editor-background));
  }
  .msg.assistant .bubble {
    background: var(--vscode-editor-background);
    border-color: transparent;
  }
  .msg-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 3px;
  }
  .msg-actions {
    display: flex;
    gap: 2px;
  }
  .msg-actions button {
    background: none;
    border: none;
    color: var(--vscode-foreground);
    opacity: 0;
    cursor: pointer;
    font-size: 13px;
    padding: 3px 5px;
    border-radius: 3px;
    transition: opacity 0.15s, background 0.15s;
  }
  .msg-actions button svg {
    width: 14px;
    height: 14px;
    fill: currentColor;
    vertical-align: middle;
  }
  .msg-actions button .check-icon { display: none; }
  .msg-actions button.done svg { display: none; }
  .msg-actions button.done .check-icon { display: inline; }
  .msg:hover .msg-actions button { opacity: 0.55; }
  .msg-actions button:hover {
    opacity: 1 !important;
    background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.1));
  }
  .msg-actions button.restore-btn:hover {
    color: #f48771;
  }
  /* Checkpoint banner */
  .checkpoint-banner {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 8px 12px;
    margin: 8px 0;
    background: var(--vscode-editorWidget-background, #252526);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    font-size: 12px;
  }
  .checkpoint-banner button {
    padding: 4px 12px;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
  }
  .btn-keep {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  .btn-discard {
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #fff);
  }
  .btn-keep:hover { opacity: 0.9; }
  .btn-discard:hover { opacity: 0.9; }
  /* ── Copilot-style chat input ── */
  .chat-input-wrapper {
    padding: 10px;
    border-top: 1px solid var(--vscode-panel-border);
    background: var(--vscode-sideBar-background);
  }
  .chat-input {
    display: flex;
    align-items: flex-end;
    gap: 6px;
    padding: 6px;
    border-radius: 10px;
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border);
    transition: border-color 0.15s;
  }
  .chat-input:focus-within {
    border-color: var(--vscode-focusBorder);
  }
  .chat-input textarea {
    flex: 1;
    resize: none;
    min-height: 28px;
    max-height: 140px;
    padding: 6px 8px;
    border: none;
    outline: none;
    background: transparent;
    color: var(--vscode-foreground);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    line-height: 1.4;
    overflow-y: auto;
  }
  .chat-input textarea::placeholder {
    opacity: 0.5;
  }
  .chat-input textarea:disabled {
    opacity: 0.5;
  }
  .icon-btn {
    width: 28px;
    height: 28px;
    min-width: 28px;
    border-radius: 6px;
    border: none;
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #fff);
    cursor: pointer;
    font-size: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    flex-shrink: 0;
    transition: background 0.15s;
  }
  .icon-btn:hover {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  .send-btn {
    width: 32px;
    height: 32px;
    min-width: 32px;
    border-radius: 8px;
    border: none;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    cursor: pointer;
    font-size: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    flex-shrink: 0;
    transition: opacity 0.15s, background 0.15s;
  }
  .send-btn:hover {
    opacity: 0.9;
  }
  .send-btn:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }
  button {
    padding: 8px 14px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    cursor: pointer;
    border-radius: 4px;
  }
  button:disabled {
    opacity: 0.5;
  }
  .hint {
    padding: 4px 12px;
    font-size: 11px;
    opacity: 0.6;
  }
  .loading-bar {
    height: 3px;
    background: var(--vscode-progressBar-background, #007acc);
    animation: loading-pulse 1.5s ease-in-out infinite;
    display: none;
  }
  .loading-bar.active { display: block; }
  @keyframes loading-pulse {
    0%   { width: 10%; margin-left: 0; }
    50%  { width: 60%; margin-left: 20%; }
    100% { width: 10%; margin-left: 90%; }
  }
  .typing {
    display: none;
    padding: 8px 12px;
    font-size: 12px;
    opacity: 0.7;
    animation: blink 1s step-end infinite;
  }
  .typing.active { display: block; }
  @keyframes blink {
    50% { opacity: 0.3; }
  }
  /* ── File chip / attachment area ── */
  .attached-files {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 4px 10px 0;
  }
  .file-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    background: var(--vscode-badge-background, #4d4d4d);
    color: var(--vscode-badge-foreground, #fff);
    border-radius: 10px;
    font-size: 11px;
    max-width: 220px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    border: 1px solid var(--vscode-panel-border);
  }
  .file-chip .icon {
    opacity: 0.7;
    font-size: 12px;
    flex-shrink: 0;
  }
  .file-chip .name {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .file-chip .lang-badge {
    font-size: 9px;
    padding: 0 4px;
    border-radius: 3px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    flex-shrink: 0;
    text-transform: uppercase;
  }
  .file-chip .remove {
    cursor: pointer;
    opacity: 0.5;
    flex-shrink: 0;
    font-size: 13px;
    line-height: 1;
  }
  .file-chip .remove:hover { opacity: 1; }
</style>
</head>

<body>
  <div class="header">
    <strong>Prompt2Code</strong>
    <div class="header-actions">
      <button id="attach" title="Include a workspace file (@file)">📎</button>
      <button id="clear" title="Clear conversation">Clear </button>
    </div>
  </div>

  <div class="hint">
    Use <b>@file path/to/file</b> to include files &middot;
    <b>@workspace</b> for project tree &middot;
    <b>"create file src/x.ts …"</b> to create new files
  </div>

  <div class="loading-bar" id="loadingBar"></div>

  <div class="chat" id="chat"></div>

  <div class="typing" id="typingIndicator">⏳ Working… generating code in the editor</div>
  <div class="attached-files" id="attachedFiles"></div>
  <div class="chat-input-wrapper">
    <div class="chat-input">
      <button id="addFile" class="icon-btn" title="Add file to context">+</button>
      <textarea id="input" rows="1" placeholder="Ask Prompt2Code… (use @file or @workspace)"></textarea>
      <button id="send" class="send-btn" title="Send">&#10148;</button>
    </div>
  </div>

<script>
  const vscode = acquireVsCodeApi();
  const chat = document.getElementById('chat');
  const input = document.getElementById('input');
  const send = document.getElementById('send');
  const clear = document.getElementById('clear');
  const attach = document.getElementById('attach');
  const addFile = document.getElementById('addFile');
  const loadingBar = document.getElementById('loadingBar');
  const typingIndicator = document.getElementById('typingIndicator');
  const attachedFilesEl = document.getElementById('attachedFiles');

  let loading = false;

  // ── Tracked / attached files state ──
  // { relPath, fileName, languageId, source: 'active'|'manual' }
  let trackedFiles = [];

  function renderChips() {
    attachedFilesEl.innerHTML = '';
    for (const f of trackedFiles) {
      const chip = document.createElement('span');
      chip.className = 'file-chip';
      chip.innerHTML =
        '<span class="icon">\ud83d\udcc4</span>' +
        '<span class="name" title="' + f.relPath + '">' + f.fileName + '</span>' +
        (f.languageId ? '<span class="lang-badge">' + f.languageId + '</span>' : '') +
        '<span class="remove" title="Remove">\u00d7</span>';
      chip.querySelector('.remove').onclick = () => {
        trackedFiles = trackedFiles.filter(t => t.relPath !== f.relPath);
        renderChips();
        vscode.postMessage({ type: 'removeTrackedFile', relPath: f.relPath });
      };
      attachedFilesEl.appendChild(chip);
    }
  }

  send.onclick = () => {
    if (!input.value.trim() || loading) return;
    const files = trackedFiles.map(f => f.relPath);
    vscode.postMessage({ type: 'sendMessage', message: input.value, attachedFiles: files });
    input.value = '';
  };

  clear.onclick = () => {
    vscode.postMessage({ type: 'clearChat' });
  };

  attach.onclick = () => {
    vscode.postMessage({ type: 'pickFile' });
  };

  addFile.onclick = () => {
    vscode.postMessage({ type: 'pickFile' });
  };

  // Auto-grow textarea (Copilot-like)
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send.click();
      // Reset height after send
      input.style.height = 'auto';
    }
  });

  window.addEventListener('message', event => {
    const msg = event.data;

    if (msg.type === 'userMessage') add('You', msg.message, 'user');
    if (msg.type === 'assistantMessage') add('AI', msg.message, 'assistant');
    if (msg.type === 'linkCheckpoint') {
      // Link the most recent user message to a checkpoint so its restore button works
      const userMsgs = chat.querySelectorAll('.msg.user');
      const last = userMsgs[userMsgs.length - 1];
      if (last) {
        last.dataset.checkpointId = msg.checkpointId;
        const restoreBtn = last.querySelector('.restore-btn');
        if (restoreBtn) restoreBtn.style.display = '';
      }
    }
    if (msg.type === 'loading') {
      loading = msg.isLoading;
      send.disabled = loading;
      input.disabled = loading;
      loadingBar.className = msg.isLoading ? 'loading-bar active' : 'loading-bar';
      typingIndicator.className = msg.isLoading ? 'typing active' : 'typing';
    }
    if (msg.type === 'clearMessages') chat.innerHTML = '';
    if (msg.type === 'error') add('Error', msg.message, 'assistant');
    if (msg.type === 'checkpoint') addCheckpointBanner(msg.id);
    if (msg.type === 'insertFileRef') {
      // From the 📎 file picker — add as a manual chip
      const refs = msg.ref.split(/\\s+/).filter(Boolean);
      for (const r of refs) {
        const cleaned = r.replace(/^@file\\s*/i, '');
        if (cleaned && !trackedFiles.find(t => t.relPath === cleaned)) {
          const parts = cleaned.split('/');
          trackedFiles.push({ relPath: cleaned, fileName: parts[parts.length - 1], languageId: '', source: 'manual' });
        }
      }
      renderChips();
      input.focus();
    }
    if (msg.type === 'activeFile') {
      // Update the auto-tracked active file chip
      trackedFiles = trackedFiles.filter(t => t.source !== 'active');
      if (msg.fileName && msg.relPath) {
        trackedFiles.unshift({
          relPath: msg.relPath,
          fileName: msg.fileName,
          languageId: msg.languageId || '',
          source: 'active'
        });
      }
      renderChips();
    }
  });

  function add(title, text, cls) {
    const div = document.createElement('div');
    div.className = 'msg ' + cls;

    // Header row: title + action buttons
    const header = document.createElement('div');
    header.className = 'msg-header';

    const label = document.createElement('span');
    label.className = 'msg-label';
    label.textContent = title;
    header.appendChild(label);

    const actions = document.createElement('span');
    actions.className = 'msg-actions';

    if (cls === 'user') {
      // 1. Edit button — loads text back into input
      const editBtn = document.createElement('button');
      editBtn.title = 'Edit & Resend';
      editBtn.innerHTML = '<svg viewBox="0 0 16 16"><path d="M13.23 1h-1.46L3.52 9.25l-.16.22L1 13.59 2.41 15l4.12-2.36.22-.16L15 4.23V2.77L13.23 1zM2.41 13.59l1.51-3 1.45 1.45-2.96 1.55zm3.83-2.06L4.47 9.76l8-8 1.77 1.77-8 8z"/></svg><span class="check-icon">✓</span>';
      editBtn.onclick = () => {
        input.value = text;
        input.focus();
        // Remove this message and all messages after it
        while (chat.lastChild && chat.lastChild !== div) {
          chat.removeChild(chat.lastChild);
        }
        if (chat.lastChild === div) chat.removeChild(div);
        // Tell extension to trim conversation history
        vscode.postMessage({ type: 'trimHistory', content: text });
      };
      actions.appendChild(editBtn);

      // 2. Copy button
      const copyBtn = document.createElement('button');
      copyBtn.title = 'Copy';
      copyBtn.innerHTML = '<svg viewBox="0 0 16 16"><path d="M4 4l1-1h5.414L14 6.586V14l-1 1H5l-1-1V4zm9 3l-3-3H5v10h8V7zM3 1L2 2v10l1 1V2h6.414l-1-1H3z"/></svg><span class="check-icon">✓</span>';
      copyBtn.onclick = () => {
        vscode.postMessage({ type: 'copyCode', code: text });
        copyBtn.classList.add('done');
        setTimeout(() => { copyBtn.classList.remove('done'); }, 1200);
      };
      actions.appendChild(copyBtn);

      // 3. Restore button — reverts editor to state before this prompt ran
      //    (hidden until a checkpoint is linked via 'linkCheckpoint' message)
      const restoreBtn = document.createElement('button');
      restoreBtn.title = 'Restore code to before this change';
      restoreBtn.innerHTML = '<svg viewBox="0 0 16 16"><path d="M4.5 2A3.5 3.5 0 0 0 1 5.5v1h1v-1A2.5 2.5 0 0 1 4.5 3h4.3L7.1 4.7l.8.6 2.5-2.5v-.6L7.9 0l-.8.6L8.8 2H4.5zM15 5.5a3.5 3.5 0 0 0-3.5-3.5v1A2.5 2.5 0 0 1 14 5.5v5a2.5 2.5 0 0 1-2.5 2.5h-8A2.5 2.5 0 0 1 1 10.5v-1H0v1A3.5 3.5 0 0 0 3.5 14h8a3.5 3.5 0 0 0 3.5-3.5v-5z"/></svg><span class="check-icon">✓</span>';
      restoreBtn.className = 'restore-btn';
      restoreBtn.style.display = 'none';
      restoreBtn.onclick = () => {
        const cpId = div.dataset.checkpointId;
        if (cpId) {
          vscode.postMessage({ type: 'checkpointAction', action: 'discard', id: cpId });
          restoreBtn.classList.add('done');
          restoreBtn.title = 'Restored';
          setTimeout(() => { restoreBtn.classList.remove('done'); restoreBtn.title = 'Restore code to before this change'; }, 2000);
        }
      };
      actions.appendChild(restoreBtn);
    } else {
      // Assistant messages: copy button only
      const copyBtn = document.createElement('button');
      copyBtn.title = 'Copy';
      copyBtn.innerHTML = '<svg viewBox="0 0 16 16"><path d="M4 4l1-1h5.414L14 6.586V14l-1 1H5l-1-1V4zm9 3l-3-3H5v10h8V7zM3 1L2 2v10l1 1V2h6.414l-1-1H3z"/></svg><span class="check-icon">✓</span>';
      copyBtn.onclick = () => {
        vscode.postMessage({ type: 'copyCode', code: text });
        copyBtn.classList.add('done');
        setTimeout(() => { copyBtn.classList.remove('done'); }, 1200);
      };
      actions.appendChild(copyBtn);
    }

    header.appendChild(actions);

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;

    div.appendChild(header);
    div.appendChild(bubble);
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
  }

  // Handle checkpoint banner
  function addCheckpointBanner(checkpointId) {
    const div = document.createElement('div');
    div.className = 'checkpoint-banner';
    div.id = 'checkpoint-' + checkpointId;
    div.innerHTML =
      '<span>💾 Checkpoint saved</span>' +
      '<button class="btn-keep" data-action="keep">✓ Keep</button>' +
      '<button class="btn-discard" data-action="discard">↩ Undo changes</button>';
    div.querySelector('.btn-keep').onclick = () => {
      vscode.postMessage({ type: 'checkpointAction', action: 'keep', id: checkpointId });
      div.innerHTML = '<span>✅ Changes kept</span>';
      setTimeout(() => div.remove(), 2000);
    };
    div.querySelector('.btn-discard').onclick = () => {
      vscode.postMessage({ type: 'checkpointAction', action: 'discard', id: checkpointId });
      div.innerHTML = '<span>↩ Restored to previous state</span>';
      setTimeout(() => div.remove(), 2000);
    };
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
  }
</script>
</body>
</html>`;
  }
}
