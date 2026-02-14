import * as vscode from 'vscode';
import * as path from 'path';
import { GroqClient, GroqMessage } from './groqClient';
import { GoogleAuthProvider } from './authProvider';
import {
  listWorkspaceFiles,
  createWorkspaceFile,
  createWorkspaceFileQuiet,
  parseMultiFileResponse,
  buildProjectTree,
  readFilesAsContext,
  extractFileReferences,
  stripFileReferences,
  gatherProjectContext,
} from './workspaceHelper';

export type ChatMode = 'ask' | 'agent' | 'plan';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'prompt2code.chatView';

  private _view?: vscode.WebviewView;
  private groqClient: GroqClient;
  private conversationHistory: GroqMessage[] = [];
  private lastTextEditor?: vscode.TextEditor;
  private disposables: vscode.Disposable[] = [];
  private currentMode: ChatMode = 'agent';

  /** Checkpoint store: id → { uri, content } for undo/restore. */
  private checkpoints = new Map<string, { uri: vscode.Uri; content: string }>();
  private checkpointCounter = 0;

  /** Google Auth provider (injected by extension.ts). */
  private authProvider?: GoogleAuthProvider;

  constructor(private readonly _extensionUri: vscode.Uri) {
    this.groqClient = new GroqClient();
  }

  /** Called from extension.ts after construction. */
  public setAuthProvider(auth: GoogleAuthProvider) {
    this.authProvider = auth;
    auth.onDidChangeAuth(async () => {
      await this.sendAuthStateToWebview();
    });
  }

  /** Push current auth state (signed-in / signed-out) to the webview. */
  private async sendAuthStateToWebview() {
    if (!this._view) { return; }
    const signedIn = this.authProvider ? await this.authProvider.isAuthenticated() : false;
    const user = signedIn ? await this.authProvider?.getUserInfo() ?? null : null;
    this._view.webview.postMessage({ type: 'authState', signedIn, user });
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

    // Send available models + current selection to webview
    this.sendModelListToWebview();

    // Send auth state on first render
    this.sendAuthStateToWebview();

    webviewView.webview.onDidReceiveMessage(async (data) => {
      console.log('Webview → Extension:', data);

      switch (data.type) {
        case 'sendMessage':
          await this.handleUserMessage(data.message, data.attachedFiles || []);
          break;

        case 'sendImageMessage':
          await this.handleImageToCode(data.message, data.imageBase64, data.mimeType, data.fileName);
          break;

        case 'clearChat':
          this.clearConversation();
          break;

        case 'newChat':
          this.startNewChat();
          break;

        case 'closePanel':
          this.closePanel();
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

        case 'selectModel': {
          await this.handleModelSelection(data.modelId);
          break;
        }

        case 'setMode': {
          const mode = data.mode as ChatMode;
          if (['ask', 'agent', 'plan'].includes(mode)) {
            this.currentMode = mode;
            this._view?.webview.postMessage({ type: 'modeChanged', mode });
          }
          break;
        }

        case 'executePlan': {
          await this.executePlan(data.plan);
          break;
        }

        case 'googleSignIn': {
          if (this.authProvider) {
            const user = await this.authProvider.signIn();
            if (user) {
              vscode.window.showInformationMessage(`Signed in as ${user.name} (${user.email})`);
            } else {
              vscode.window.showWarningMessage('Google Sign-In was cancelled or failed.');
            }
            await this.sendAuthStateToWebview();
          }
          break;
        }

        case 'googleSignOut': {
          if (this.authProvider) {
            // Ask for confirmation
            const choice = await vscode.window.showWarningMessage(
              'Sign out of Prompt2Code?',
              { modal: true },
              'Sign Out',
              'Sign Out & Clear History'
            );

            if (choice) {
              await this.authProvider.signOut();
              
              // Clear chat history if requested
              if (choice === 'Sign Out & Clear History') {
                this.conversationHistory = [];
                this._view?.webview.postMessage({ type: 'clearMessages' });
              }
              
              vscode.window.showInformationMessage('Successfully signed out of Prompt2Code');
              await this.sendAuthStateToWebview();
            }
          }
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

  /** Send available model list and currently active model to webview. */
  private sendModelListToWebview() {
    if (!this._view) { return; }
    const models = GroqClient.AVAILABLE_MODELS;
    const activeModel = this.groqClient.getActiveModel();
    this._view.webview.postMessage({
      type: 'modelList',
      models,
      activeModel,
    });
  }

  /** Handle model selection from the webview dropdown. */
  private async handleModelSelection(modelId: string) {
    const modelInfo = GroqClient.AVAILABLE_MODELS.find(m => m.id === modelId);
    const modelLabel = modelInfo?.label ?? modelId;

    // Check if this specific model already has a key (per-model or global fallback)
    let apiKey = this.groqClient.getApiKeyForModel(modelId);

    if (!apiKey || apiKey.trim() === '') {
      // First time using this model — prompt for its API key
      const enteredKey = await vscode.window.showInputBox({
        title: `API Key for ${modelLabel}`,
        prompt: `Enter your Groq API key to use ${modelLabel}. Get one free at https://console.groq.com`,
        placeHolder: 'gsk_...',
        password: true,
        ignoreFocusOut: true,
      });

      if (!enteredKey || !enteredKey.trim()) {
        this._view?.webview.postMessage({
          type: 'modelChangeResult',
          success: false,
          error: 'No API key provided.',
          activeModel: this.groqClient.getActiveModel(),
        });
        return;
      }

      // Validate the key against this specific model
      this._view?.webview.postMessage({
        type: 'assistantMessage',
        message: `🔑 Validating API key for ${modelLabel}…`,
      });

      const validation = await this.groqClient.validateApiKey(enteredKey.trim(), modelId);
      if (!validation.valid) {
        this._view?.webview.postMessage({
          type: 'modelChangeResult',
          success: false,
          error: validation.error || 'Invalid API key.',
          activeModel: this.groqClient.getActiveModel(),
        });
        vscode.window.showErrorMessage(`Invalid API key: ${validation.error}`);
        return;
      }

      // Save the validated key for this model
      const config = vscode.workspace.getConfiguration('prompt2code');
      const perModelKeys = { ...config.get<Record<string, string>>('apiKeys', {}) };
      perModelKeys[modelId] = enteredKey.trim();
      await config.update('apiKeys', perModelKeys, vscode.ConfigurationTarget.Global);
      apiKey = enteredKey.trim();

      this._view?.webview.postMessage({
        type: 'assistantMessage',
        message: `✅ API key for ${modelLabel} validated and saved.`,
      });
    }

    // Set the model override
    this.groqClient.setModelOverride(modelId);

    // Also persist it to settings so it survives reloads
    await vscode.workspace.getConfiguration('prompt2code').update('model', modelId, vscode.ConfigurationTarget.Global);

    this._view?.webview.postMessage({
      type: 'modelChangeResult',
      success: true,
      activeModel: modelId,
    });

    vscode.window.showInformationMessage(`Model switched to ${modelLabel}`);
  }

  /**
   * Compute a human-readable diff summary between the old and new content.
   * Returns a structured message showing what changed.
   */
  private computeDiffSummary(oldContent: string, newContent: string, fileName: string): string {
    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');

    let added = 0;
    let removed = 0;
    const changedSections: string[] = [];

    // Simple line-level diff via LCS-like approach
    const oldSet = new Set(oldLines.map(l => l.trim()).filter(Boolean));
    const newSet = new Set(newLines.map(l => l.trim()).filter(Boolean));

    for (const line of newLines) {
      if (line.trim() && !oldSet.has(line.trim())) { added++; }
    }
    for (const line of oldLines) {
      if (line.trim() && !newSet.has(line.trim())) { removed++; }
    }

    // Identify changed regions (up to 5)
    let regionStart = -1;
    const maxRegions = 5;
    for (let i = 0; i < Math.max(oldLines.length, newLines.length); i++) {
      const oldL = (oldLines[i] ?? '').trim();
      const newL = (newLines[i] ?? '').trim();
      if (oldL !== newL) {
        if (regionStart < 0) { regionStart = i; }
      } else if (regionStart >= 0) {
        if (changedSections.length < maxRegions) {
          const span = i - regionStart;
          changedSections.push(`  • Lines ${regionStart + 1}–${i} (${span} line${span !== 1 ? 's' : ''})`);
        }
        regionStart = -1;
      }
    }
    if (regionStart >= 0 && changedSections.length < maxRegions) {
      const endLine = Math.max(oldLines.length, newLines.length);
      const span = endLine - regionStart;
      changedSections.push(`  • Lines ${regionStart + 1}–${endLine} (${span} line${span !== 1 ? 's' : ''})`);
    }

    const sizeDelta = newLines.length - oldLines.length;
    const sizeNote = sizeDelta === 0
      ? `${newLines.length} lines (unchanged size)`
      : sizeDelta > 0
        ? `${oldLines.length} → ${newLines.length} lines (+${sizeDelta})`
        : `${oldLines.length} → ${newLines.length} lines (${sizeDelta})`;

    let summary = `📋 Changes made to ${fileName}:\n`;
    summary += `───────────────────────────\n`;
    summary += `  ✚ ${added} line${added !== 1 ? 's' : ''} added\n`;
    summary += `  ─ ${removed} line${removed !== 1 ? 's' : ''} removed\n`;
    summary += `  📏 ${sizeNote}\n`;
    if (changedSections.length > 0) {
      summary += `\n📍 Changed regions:\n`;
      summary += changedSections.join('\n');
      if (changedSections.length === maxRegions) {
        summary += '\n  … and more';
      }
    }
    return summary;
  }

  // ===========================
  // MESSAGE HANDLING
  // ===========================

  private async handleUserMessage(message: string, attachedFiles: string[] = []) {
    if (!message || !message.trim()) return;

    // Gate behind Google auth
    if (this.authProvider && !(await this.authProvider.isAuthenticated())) {
      this._view?.webview.postMessage({
        type: 'error',
        message: '🔒 Please sign in with Google before using Prompt2Code.'
      });
      return;
    }

    console.log('📨 Handling message:', message, 'mode:', this.currentMode, 'attached:', attachedFiles);

    // 1️⃣ Show user message immediately (checkpointId attached later for code-edit path)
    this._view?.webview.postMessage({
      type: 'userMessage',
      message
    });

    // 2️⃣ Save conversation (for chat mode history)
    this.conversationHistory.push({ role: 'user', content: message });

    // 3️⃣ Route to the appropriate handler based on mode
    switch (this.currentMode) {
      case 'ask':
        await this.handleAskMode(message, attachedFiles);
        return;
      case 'plan':
        await this.handlePlanMode(message, attachedFiles);
        return;
      case 'agent':
      default:
        await this.handleAgentMode(message, attachedFiles);
        return;
    }
  }

  // ===========================
  // ASK MODE — Chat only, no file edits
  // ===========================

  private async handleAskMode(message: string, attachedFiles: string[] = []) {
    this._view?.webview.postMessage({ type: 'loading', isLoading: true });

    try {
      const activeModel = this.groqClient.getActiveModel();
      const apiKey = this.groqClient.getApiKeyForModel(activeModel);
      if (!apiKey || apiKey.trim() === '') {
        const modelLabel = GroqClient.AVAILABLE_MODELS.find(m => m.id === activeModel)?.label ?? activeModel;
        throw new Error(`⚠️ No API key for ${modelLabel}. Select the model from the dropdown below to set its key.\n\nGet your free API key at: https://console.groq.com`);
      }

      const fileRefs = extractFileReferences(message);
      const cleanMessage = stripFileReferences(message);
      const allFileRefs = [...new Set([...fileRefs, ...attachedFiles])];

      let referencedFilesContext = '';
      if (allFileRefs.length > 0) {
        referencedFilesContext = await readFilesAsContext(allFileRefs);
      }

      const editor = this.getTargetEditor();
      const doc = editor?.document;
      const languageId = doc?.languageId ?? 'plaintext';

      let contextInfo = '';
      if (doc) {
        contextInfo = `\n\nCurrent file: ${doc.fileName} (${languageId})`;
        // Include current file content for ask mode so AI can answer about it
        const fileContent = doc.getText();
        if (fileContent.length < 15000) {
          contextInfo += `\n\nFile content:\n${fileContent}`;
        } else {
          contextInfo += `\n\nFile content (first 15000 chars):\n${fileContent.substring(0, 15000)}\n/* ...truncated... */`;
        }
      }
      if (referencedFilesContext) {
        contextInfo += `\n\nReferenced files:\n${referencedFilesContext}`;
      }

      if (/(@workspace|project structure|codebase|all files)/i.test(message)) {
        const tree = await buildProjectTree();
        contextInfo += `\n\nProject files:\n${tree}`;
      }

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
            'You are a helpful coding assistant in ASK mode. Your job is to EXPLAIN, ANSWER QUESTIONS, and provide GUIDANCE about code.\n\n' +
            'RULES:\n' +
            '- Do NOT output full code rewrites or file contents.\n' +
            '- Provide clear, concise explanations with code snippets only when helpful.\n' +
            '- If the user asks you to change/edit/create code, remind them to switch to Agent mode.\n' +
            '- Use minimal markdown. Keep responses focused and readable.\n' +
            '- Reference specific line numbers and function names when explaining code.'
        },
        ...this.conversationHistory.slice(0, -1),
        { role: 'user', content: cleanMessage + contextInfo }
      ];

      console.log('🚀 Calling Groq API (ask mode)...');
      const rawResponse = await this.groqClient.complete(messages, false);
      const response = this.sanitizeChatResponse(rawResponse);

      this.conversationHistory.push({ role: 'assistant', content: response });
      this._view?.webview.postMessage({ type: 'assistantMessage', message: response });

    } catch (err: any) {
      console.error('❌ Ask mode error:', err);
      this._view?.webview.postMessage({
        type: 'error',
        message: err.message || 'Failed to get response.'
      });
    } finally {
      this._view?.webview.postMessage({ type: 'loading', isLoading: false });
    }
  }

  // ===========================
  // PLAN MODE — Generate step-by-step plan, then optionally execute
  // ===========================

  private async handlePlanMode(message: string, attachedFiles: string[] = []) {
    this._view?.webview.postMessage({ type: 'loading', isLoading: true });

    try {
      const activeModel = this.groqClient.getActiveModel();
      const apiKey = this.groqClient.getApiKeyForModel(activeModel);
      if (!apiKey || apiKey.trim() === '') {
        const modelLabel = GroqClient.AVAILABLE_MODELS.find(m => m.id === activeModel)?.label ?? activeModel;
        throw new Error(`⚠️ No API key for ${modelLabel}. Select the model from the dropdown below to set its key.\n\nGet your free API key at: https://console.groq.com`);
      }

      const fileRefs = extractFileReferences(message);
      const cleanMessage = stripFileReferences(message);
      const allFileRefs = [...new Set([...fileRefs, ...attachedFiles])];

      let referencedFilesContext = '';
      if (allFileRefs.length > 0) {
        referencedFilesContext = await readFilesAsContext(allFileRefs);
      }

      const editor = this.getTargetEditor();
      const doc = editor?.document;

      let contextInfo = '';
      if (doc) {
        contextInfo = `\n\nCurrent file: ${doc.fileName} (${doc.languageId})\nLines: ${doc.lineCount}`;
        // Include file structure summary
        const fileContent = doc.getText();
        if (fileContent.length < 20000) {
          contextInfo += `\n\nFile content:\n${fileContent}`;
        } else {
          contextInfo += `\n\nFile content (first 20000 chars):\n${fileContent.substring(0, 20000)}\n/* ...truncated... */`;
        }
      }
      if (referencedFilesContext) {
        contextInfo += `\n\nReferenced files:\n${referencedFilesContext}`;
      }

      // Always include project tree for planning
      const tree = await buildProjectTree();
      contextInfo += `\n\nProject structure:\n${tree}`;

      const chatCharBudget = this.groqClient.getContextCharBudget();
      const projCtx = await gatherProjectContext({
        languageId: doc?.languageId,
        currentFilePath: doc?.uri.fsPath,
        maxChars: Math.min(chatCharBudget, 20_000),
        maxFiles: 8,
      });
      if (projCtx.text) {
        contextInfo += `\n\nProject context (${projCtx.fileCount} files):\n${projCtx.text}`;
      }

      const messages: GroqMessage[] = [
        {
          role: 'system',
          content:
            'You are an expert coding assistant in PLAN mode. Your job is to analyze the request and produce a clear, actionable IMPLEMENTATION PLAN.\n\n' +
            'FORMAT YOUR PLAN EXACTLY LIKE THIS:\n' +
            '## Plan: [brief title]\n\n' +
            '### Steps:\n' +
            '1. **[Action]** — [File/location]: [What to do]\n' +
            '2. **[Action]** — [File/location]: [What to do]\n' +
            '...\n\n' +
            '### Details:\n' +
            '[Brief description of key implementation details, patterns to follow, and potential pitfalls]\n\n' +
            'RULES:\n' +
            '- Be SPECIFIC: mention exact file names, function names, line ranges when possible.\n' +
            '- Each step should be a single, concrete action (add, modify, create, delete, move).\n' +
            '- Order steps by dependency — what must be done first.\n' +
            '- Include estimated scope (e.g., "~20 lines", "new file").\n' +
            '- Mention potential risks or things to watch out for.\n' +
            '- Do NOT generate code in plan mode — only describe what to do.\n' +
            '- Keep it concise but thorough. Max 10 steps for most tasks.'
        },
        ...this.conversationHistory.slice(0, -1),
        { role: 'user', content: cleanMessage + contextInfo }
      ];

      console.log('🚀 Calling Groq API (plan mode)...');
      const rawResponse = await this.groqClient.complete(messages, false);
      const response = this.sanitizeChatResponse(rawResponse);

      this.conversationHistory.push({ role: 'assistant', content: response });

      // Send plan with execute button
      this._view?.webview.postMessage({
        type: 'planMessage',
        message: response,
        originalRequest: cleanMessage,
      });

    } catch (err: any) {
      console.error('❌ Plan mode error:', err);
      this._view?.webview.postMessage({
        type: 'error',
        message: err.message || 'Failed to generate plan.'
      });
    } finally {
      this._view?.webview.postMessage({ type: 'loading', isLoading: false });
    }
  }

  /**
   * Execute a plan by switching to agent mode and asking the AI to implement it.
   */
  private async executePlan(plan: string) {
    const executeMessage = `Implement the following plan. Apply all changes step by step:\n\n${plan}`;
    const previousMode = this.currentMode;
    this.currentMode = 'agent';
    await this.handleUserMessage(executeMessage, []);
    this.currentMode = previousMode;
  }

  // ===========================
  // AGENT MODE — Full auto (edit files, create files, chat)
  // ===========================

  private async handleAgentMode(message: string, attachedFiles: string[] = []) {

    // 3️⃣ Show loading
    this._view?.webview.postMessage({
      type: 'loading',
      isLoading: true
    });

    try {
      // ⚠️ CHECK API KEY FIRST — resolves per-model key or global fallback
      const activeModel = this.groqClient.getActiveModel();
      const apiKey = this.groqClient.getApiKeyForModel(activeModel);
      console.log('🔑 API Key for', activeModel, ':', apiKey ? 'YES' : 'NO');

      if (!apiKey || apiKey.trim() === '') {
        const modelLabel = GroqClient.AVAILABLE_MODELS.find(m => m.id === activeModel)?.label ?? activeModel;
        throw new Error(`⚠️ No API key for ${modelLabel}. Select the model from the dropdown below to set its key.\n\nGet your free API key at: https://console.groq.com`);
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

      // ── Detect multi-file / scaffold intent ──
      if (this.isMultiFileIntent(cleanMessage)) {
        await this.handleMultiFileGeneration(cleanMessage, referencedFilesContext);
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

        // Build context: referenced files + auto-scanned project files
        const contextParts: string[] = [];
        if (referencedFilesContext) { contextParts.push(referencedFilesContext); }

        const ctxCharBudget = this.groqClient.getContextCharBudget();
        const projectCtx = await gatherProjectContext({
          languageId: target.languageId || doc.languageId,
          currentFilePath: doc.uri.fsPath,
          maxChars: Math.min(ctxCharBudget, 40_000),
          maxFiles: 8,
        });
        if (projectCtx.text) { contextParts.push(projectCtx.text); }

        // 💾 Save checkpoint before modifying the editor
        const cpId = String(++this.checkpointCounter);
        this.checkpoints.set(cpId, { uri: doc.uri, content: doc.getText() });
        this._view?.webview.postMessage({ type: 'linkCheckpoint', checkpointId: cpId });

        // ── Determine editing strategy: SELECTION vs WHOLE-FILE ──
        const selection = editor.selection;
        const hasSelection = !selection.isEmpty;
        const fileLineCount = doc.lineCount;

        if (hasSelection) {
          // ═══════ SELECTION MODE: edit only the selected block ═══════
          console.log('📌 Selection mode — editing lines', selection.start.line + 1, 'to', selection.end.line + 1);

          const selectedText = doc.getText(selection);

          // Grab surrounding context (up to 20 lines before/after)
          const ctxLinesBefore = 20;
          const ctxLinesAfter = 20;
          const beforeStart = Math.max(0, selection.start.line - ctxLinesBefore);
          const afterEnd = Math.min(fileLineCount - 1, selection.end.line + ctxLinesAfter);

          const beforeRange = new vscode.Range(beforeStart, 0, selection.start.line, 0);
          const afterRange = new vscode.Range(selection.end.line + 1, 0, afterEnd + 1, 0);

          const beforeText = doc.getText(beforeRange);
          const afterText = doc.getText(afterRange);

          const surroundingCtx =
            `── Lines BEFORE selection (read-only) ──\n${beforeText}\n` +
            `── Lines AFTER selection (read-only) ──\n${afterText}`;

          this._view?.webview.postMessage({
            type: 'assistantMessage',
            message: `⏳ Editing selected code (lines ${selection.start.line + 1}–${selection.end.line + 1})…`
          });

          // Use the range stream updater — only replaces the selection
          const startOffset = doc.offsetAt(selection.start);
          const originalLen = selectedText.length;
          const updater = this.makeRangeStreamUpdater(editor, startOffset, originalLen, 150);

          const newBlock = await this.groqClient.generateSectionEdit(
            cleanMessage,
            target.promptLanguage,
            selectedText,
            surroundingCtx,
            updater.onChunk,
            contextParts.join('\n\n')
          );

          await updater.flush();

          // Final write: ensure the exact replacement landed correctly
          // The updater tracks the current range, but do a safety pass to guarantee correctness
          const docAfter = editor.document;
          const textNow = docAfter.getText();
          const after = textNow.substring(startOffset);
          // The streamed region starts at startOffset — find what's currently there
          // and replace with the final accumulated newBlock if it doesn't match.
          if (!after.startsWith(newBlock)) {
            // Simplest approach: just replace from startOffset to startOffset + whatever the updater wrote
            const safeEnd = Math.min(textNow.length, startOffset + Math.max(newBlock.length, originalLen));
            await this.replaceRange(
              editor,
              new vscode.Range(docAfter.positionAt(startOffset), docAfter.positionAt(safeEnd)),
              newBlock,
              3
            );
          }

        } else if (fileLineCount > 80) {
          // ═══════ SMART WHOLE-FILE MODE for large files ═══════
          // Auto-detect the relevant section and edit only that
          console.log('📝 Smart whole-file mode — file has', fileLineCount, 'lines');

          // Try to find the relevant section based on the instruction keywords
          const fullText = doc.getText();
          const lines = fullText.split('\n');
          const relevantRange = this.findRelevantSection(lines, cleanMessage);

          if (relevantRange) {
            console.log('📌 Auto-detected relevant section: lines', relevantRange.start + 1, 'to', relevantRange.end + 1);

            const sectionLines = lines.slice(relevantRange.start, relevantRange.end + 1);
            const selectedText = sectionLines.join('\n');

            // Context: lines around the section
            const beforeLines = lines.slice(Math.max(0, relevantRange.start - 15), relevantRange.start);
            const afterLines = lines.slice(relevantRange.end + 1, Math.min(lines.length, relevantRange.end + 16));

            const surroundingCtx =
              `── Lines BEFORE section (read-only) ──\n${beforeLines.join('\n')}\n` +
              `── Lines AFTER section (read-only) ──\n${afterLines.join('\n')}`;

            this._view?.webview.postMessage({
              type: 'assistantMessage',
              message: `⏳ Editing lines ${relevantRange.start + 1}–${relevantRange.end + 1}…`
            });

            const startPos = doc.lineAt(relevantRange.start).range.start;
            const endPos = doc.lineAt(relevantRange.end).range.end;
            const startOffset = doc.offsetAt(startPos);
            const originalLen = doc.offsetAt(endPos) - startOffset;
            const updater = this.makeRangeStreamUpdater(editor, startOffset, originalLen, 150);

            const newBlock = await this.groqClient.generateSectionEdit(
              cleanMessage,
              target.promptLanguage,
              selectedText,
              surroundingCtx,
              updater.onChunk,
              contextParts.join('\n\n')
            );

            await updater.flush();
            // Final safety write — ensure the section was replaced correctly
            const curDoc = editor.document;
            const curText = curDoc.getText();
            const curAfter = curText.substring(startOffset);
            if (!curAfter.startsWith(newBlock)) {
              const safeEnd = Math.min(curText.length, startOffset + Math.max(newBlock.length, originalLen));
              await this.replaceRange(
                editor,
                new vscode.Range(curDoc.positionAt(startOffset), curDoc.positionAt(safeEnd)),
                newBlock,
                3
              );
            }
          } else {
            // Couldn't detect section — fall back to whole-file update
            console.log('📝 Falling back to whole-file update mode');
            await this.doWholeFileUpdate(editor, doc, cleanMessage, target, contextParts);
          }

        } else {
          // ═══════ SMALL FILE: whole-file update (original behavior) ═══════
          console.log('📝 Whole-file update mode — file has', fileLineCount, 'lines');
          await this.doWholeFileUpdate(editor, doc, cleanMessage, target, contextParts);
        }

        // If user asked for React while editing HTML, switch language mode for better UX.
        if (target.languageId && target.languageId !== doc.languageId) {
          try {
            await vscode.languages.setTextDocumentLanguage(doc, target.languageId);
          } catch {
            // Non-fatal.
          }
        }
        vscode.window.showInformationMessage('Code updated in editor');

        // 📋 Compute and display diff summary
        const checkpointContent = this.checkpoints.get(cpId)?.content ?? '';
        const updatedContent = editor.document.getText();
        const fileName = path.basename(editor.document.uri.fsPath);
        const diffSummary = this.computeDiffSummary(checkpointContent, updatedContent, fileName);

        this._view?.webview.postMessage({
          type: 'assistantMessage',
          message: `✅ Code updated in editor.\n\n${diffSummary}`
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
    // If it's a multi-file intent, don't treat as single-file edit
    if (this.isMultiFileIntent(userMessage)) { return false; }
    // Broad keyword-based intent detection — anything that sounds like
    // an action on code should go to the editor, not chat.
    return /\b(change|update|modify|replace|create|generate|convert|enhance|improve|refactor|fix|optimise|optimize|rewrite|redesign|style|beautify|add|remove|delete|implement|build|make|write|edit|transform|migrate|upgrade|redo|revamp|restyle|tweak|adjust|clean|format|lint|minify|simplify|extend|expand|rework|overhaul|design|code|develop|scaffold|setup|set\s*up)\b/i.test(userMessage);
  }

  /**
   * Detect if the user wants to create/modify multiple files or scaffold a structure.
   */
  private isMultiFileIntent(msg: string): boolean {
    const lower = msg.toLowerCase();

    // Explicit multi-file / scaffold keywords
    if (/\b(scaffold|boilerplate|project structure|folder structure|file structure|codebase|full[- ]?stack)\b/i.test(lower)) { return true; }

    // "create / build / make / develop / generate  ...  app / project / application / website / page / site / dashboard / system / platform"
    if (/\b(create|build|make|develop|generate|design|implement|code|write)\b.{0,40}\b(app|application|project|website|web\s*site|landing\s*page|web\s*app|webapp|webpage|web\s*page|dashboard|portal|platform|system|api|server|backend|frontend|front[- ]?end|back[- ]?end|cli|tool|game|clone|replica|template|starter|demo|prototype|mvp|saas)\b/i.test(lower)) { return true; }

    // "create all/multiple/several files/components/pages"
    if (/\bcreate\s+(all|multiple|several|the)\s+(files|components|pages|modules|routes)\b/i.test(lower)) { return true; }

    // "set up a/the project/app"
    if (/\bset\s*up\s+(a |the )?(project|app|application|repo|repository)\b/i.test(lower)) { return true; }

    // "... using React / with Express / in Next.js" — framework-based requests are inherently multi-file
    if (/\b(create|build|make|develop)\b/i.test(lower) && /\b(react|vue|angular|svelte|next\.?js|nuxt|express|fastapi|flask|django|spring|laravel|rails|nest\.?js|gatsby|remix|astro|vite|tailwind)\b/i.test(lower)) { return true; }

    // "todo app", "calculator app", "chat app", "blog app" etc. — noun + app/application
    if (/\b\w+\s+(app|application|website|webpage|page)\b/i.test(lower) && /\b(create|build|make|develop|generate|write|code|give|can you|i want|i need|please)\b/i.test(lower)) { return true; }

    // Mentions 2+ file paths
    const filePathMentions = lower.match(/\b[\w/\\-]+\.\w{1,5}\b/g) || [];
    if (filePathMentions.length >= 2) { return true; }

    // "create X and Y" pattern
    if (/\bcreate\b.+\band\b.+\b(file|component|page|module)\b/i.test(lower)) { return true; }

    // "with files" / "with components"
    if (/\bwith\s+(files|components|pages|modules|routes|folders|endpoints|screens|views|templates)\b/i.test(lower)) { return true; }

    return false;
  }

  /**
   * Handle multi-file generation: ask AI to output multiple files,
   * parse the structured response, and create them all in the workspace.
   */
  private async handleMultiFileGeneration(
    instruction: string,
    referencedFilesContext: string
  ): Promise<void> {
    this._view?.webview.postMessage({
      type: 'assistantMessage',
      message: '⏳ Analyzing project structure and generating files…'
    });

    // Build rich project context
    const tree = await buildProjectTree();
    const contextParts: string[] = [];
    if (referencedFilesContext) { contextParts.push(referencedFilesContext); }

    const charBudget = this.groqClient.getContextCharBudget();
    const projCtx = await gatherProjectContext({
      maxChars: Math.min(charBudget, 30_000),
      maxFiles: 10,
    });
    if (projCtx.text) { contextParts.push(projCtx.text); }

    const systemPrompt = [
      'You are an expert developer generating MULTIPLE FILES for a project.',
      '',
      'CRITICAL RULES (FOLLOW EXACTLY):',
      '- Output each file using this EXACT format:',
      '',
      '===FILE: path/to/file.ext===',
      '...complete file content...',
      '===END_FILE===',
      '',
      '- Use relative paths from the workspace root (e.g. src/index.ts, not ./src/index.ts).',
      '- Generate ALL necessary files for a working project.',
      '- Include package.json, config files, and entry points as needed.',
      '- Create complete, production-ready file contents — not stubs or placeholders.',
      '- Include proper imports, exports, and type annotations.',
      '- Do NOT add markdown, explanations, or commentary outside of file blocks.',
      '- Do NOT wrap the ===FILE=== blocks inside code fences.',
      '- If modifying an existing file, output the COMPLETE updated file content.',
      '- Order files so dependencies come before dependents.',
      '- For web apps, include HTML, CSS, and JS/TS files as needed.',
      '- For Node.js projects, include package.json with dependencies.',
      '- Start generating files IMMEDIATELY — no preamble text.',
    ].join('\n');

    let userPrompt = `Instruction: ${instruction}\n\n`;
    userPrompt += `Current project structure:\n${tree}\n\n`;
    if (contextParts.length > 0) {
      const ctx = contextParts.join('\n\n');
      const budget = Math.floor(charBudget * 0.6);
      userPrompt += `Project context:\n${ctx.length > budget ? ctx.slice(0, budget) + '\n/* ...trimmed... */' : ctx}\n\n`;
    }
    userPrompt += 'Generate the files now. Start with ===FILE: path=== immediately.';

    const messages: GroqMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    console.log('🚀 Calling Groq API (multi-file generation with continuation)...');
    const rawResponse = await this.groqClient.completeWithContinuation(messages, { maxContinuations: 5 });

    // Parse structured file blocks from the response
    const fileBlocks = parseMultiFileResponse(rawResponse);

    if (fileBlocks.length === 0) {
      // AI didn't use the structured format — fall back to showing the response as chat
      this._view?.webview.postMessage({
        type: 'assistantMessage',
        message: rawResponse,
      });
      return;
    }

    // Create all files
    const created: string[] = [];
    const failed: string[] = [];
    let firstUri: vscode.Uri | undefined;

    for (const block of fileBlocks) {
      try {
        const uri = await createWorkspaceFileQuiet(block.path, block.content);
        if (uri) {
          created.push(block.path);
          if (!firstUri) { firstUri = uri; }
        } else {
          failed.push(block.path);
        }
      } catch (err: any) {
        console.error(`Failed to create ${block.path}:`, err);
        failed.push(block.path);
      }
    }

    // Open the first created file in the editor
    if (firstUri) {
      try {
        const doc = await vscode.workspace.openTextDocument(firstUri);
        await vscode.window.showTextDocument(doc, { preview: false });
      } catch { /* non-fatal */ }
    }

    // Build summary message
    let summary = `✅ Created ${created.length} file${created.length !== 1 ? 's' : ''}:\n\n`;
    for (const f of created) {
      summary += `  📄 ${f}\n`;
    }
    if (failed.length > 0) {
      summary += `\n⚠️ Failed to create ${failed.length} file${failed.length !== 1 ? 's' : ''}:\n`;
      for (const f of failed) {
        summary += `  ❌ ${f}\n`;
      }
    }

    this._view?.webview.postMessage({
      type: 'assistantMessage',
      message: summary,
    });

    this.conversationHistory.push({ role: 'assistant', content: summary });
    vscode.window.showInformationMessage(`Prompt2Code: Created ${created.length} files`);
  }

  // ===========================
  // IMAGE-TO-CODE — Vision-based UI replication
  // ===========================

  private async handleImageToCode(
    instruction: string,
    imageBase64: string,
    mimeType: string,
    fileName: string
  ): Promise<void> {
    // Gate behind Google auth
    if (this.authProvider && !(await this.authProvider.isAuthenticated())) {
      this._view?.webview.postMessage({
        type: 'error',
        message: '🔒 Please sign in with Google before using Prompt2Code.'
      });
      return;
    }

    // Show user message with image indicator
    this._view?.webview.postMessage({
      type: 'userMessage',
      message: `🖼️ [Image: ${fileName}] ${instruction}`
    });
    this.conversationHistory.push({ role: 'user', content: `[Image: ${fileName}] ${instruction}` });

    this._view?.webview.postMessage({ type: 'loading', isLoading: true });

    try {
      // Check API key
      const visionModel = GroqClient.VISION_MODEL;
      const apiKey = this.groqClient.getApiKeyForModel(visionModel);
      const globalKey = this.groqClient.getApiKeyForModel(this.groqClient.getActiveModel());
      if (!apiKey && !globalKey) {
        throw new Error(
          '⚠️ No API key configured. Set a global API key or a key for the Llama 4 Scout (Vision) model.\n\n' +
          'Get your free API key at: https://console.groq.com'
        );
      }

      // Determine target language from user instruction or current editor
      const editor = this.getTargetEditor();
      let targetLang = 'HTML/CSS/JavaScript';
      if (/\breact\b/i.test(instruction)) { targetLang = 'React (JSX/TSX with Tailwind CSS)'; }
      else if (/\bvue\b/i.test(instruction)) { targetLang = 'Vue.js (Single File Components)'; }
      else if (/\bsvelte\b/i.test(instruction)) { targetLang = 'Svelte'; }
      else if (/\bangular\b/i.test(instruction)) { targetLang = 'Angular (TypeScript)'; }
      else if (/\btailwind\b/i.test(instruction)) { targetLang = 'HTML with Tailwind CSS'; }
      else if (/\bnext\.?js\b/i.test(instruction)) { targetLang = 'Next.js (React/TypeScript)'; }
      else if (editor?.document.languageId === 'typescriptreact') { targetLang = 'React (TSX)'; }
      else if (editor?.document.languageId === 'javascriptreact') { targetLang = 'React (JSX)'; }

      this._view?.webview.postMessage({
        type: 'assistantMessage',
        message: `🖼️ Analyzing screenshot and generating ${targetLang} code…`
      });

      // Call vision model
      const rawResponse = await this.groqClient.imageToCode(
        imageBase64,
        mimeType,
        instruction,
        targetLang
      );

      // Check if the response contains multiple files
      const fileBlocks = parseMultiFileResponse(rawResponse);

      if (fileBlocks.length > 0) {
        // Multi-file output — create files in workspace
        const created: string[] = [];
        const failed: string[] = [];
        let firstUri: vscode.Uri | undefined;

        for (const block of fileBlocks) {
          try {
            const uri = await createWorkspaceFileQuiet(block.path, block.content);
            if (uri) {
              created.push(block.path);
              if (!firstUri) { firstUri = uri; }
            } else {
              failed.push(block.path);
            }
          } catch (err: any) {
            console.error(`Failed to create ${block.path}:`, err);
            failed.push(block.path);
          }
        }

        if (firstUri) {
          try {
            const doc = await vscode.workspace.openTextDocument(firstUri);
            await vscode.window.showTextDocument(doc, { preview: false });
          } catch { /* non-fatal */ }
        }

        let summary = `✅ Generated ${created.length} file${created.length !== 1 ? 's' : ''} from screenshot:\n\n`;
        for (const f of created) { summary += `  📄 ${f}\n`; }
        if (failed.length > 0) {
          summary += `\n⚠️ Failed: ${failed.join(', ')}`;
        }

        this._view?.webview.postMessage({ type: 'assistantMessage', message: summary });
        this.conversationHistory.push({ role: 'assistant', content: summary });
        vscode.window.showInformationMessage(`Prompt2Code: Generated ${created.length} files from image`);
      } else {
        // Single file output — insert into editor or show as chat
        const cleanCode = rawResponse
          .replace(/^```[\w]*\n?/gm, '')
          .replace(/```\s*$/gm, '')
          .trim();

        if (editor && editor.document) {
          // Save checkpoint
          const cpId = String(++this.checkpointCounter);
          this.checkpoints.set(cpId, { uri: editor.document.uri, content: editor.document.getText() });
          this._view?.webview.postMessage({ type: 'linkCheckpoint', checkpointId: cpId });

          const fullRange = new vscode.Range(
            editor.document.positionAt(0),
            editor.document.positionAt(editor.document.getText().length)
          );
          await editor.edit(eb => { eb.replace(fullRange, cleanCode); });
          vscode.window.showInformationMessage('Code generated from screenshot and inserted into editor');
          this._view?.webview.postMessage({
            type: 'assistantMessage',
            message: '✅ UI code generated from screenshot and inserted into the editor.'
          });
        } else {
          // No editor — show code as chat message
          this._view?.webview.postMessage({
            type: 'assistantMessage',
            message: '```\n' + cleanCode + '\n```'
          });
        }
        this.conversationHistory.push({ role: 'assistant', content: cleanCode });
      }

    } catch (error: any) {
      console.error('Image-to-code error:', error);
      const errorMsg = error.response?.data?.error?.message || error.message || 'Unknown error';
      this._view?.webview.postMessage({
        type: 'error',
        message: `Image analysis failed: ${errorMsg}`
      });
    } finally {
      this._view?.webview.postMessage({ type: 'loading', isLoading: false });
    }
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
   * Replace a specific line range in the document (used for selection-based edits).
   */
  private async replaceRange(
    editor: vscode.TextEditor,
    range: vscode.Range,
    newText: string,
    retries = 3
  ): Promise<boolean> {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const ok = await editor.edit(
          (eb) => { eb.replace(range, newText); },
          { undoStopBefore: false, undoStopAfter: false }
        );
        if (ok) { return true; }
      } catch {
        // editor busy
      }
      await new Promise(r => setTimeout(r, 120));
    }
    return false;
  }

  /**
   * Stream updater that replaces only a specific range (for selection edits).
   * The range is tracked and updated as the content changes length.
   */
  private makeRangeStreamUpdater(
    editor: vscode.TextEditor,
    startOffset: number,
    originalLength: number,
    minChars = 200
  ): { onChunk: (accumulated: string) => void; flush: () => Promise<void> } {
    let pending: string | null = null;
    let lastLen = 0;
    let busy = false;
    let currentEnd = startOffset + originalLength;

    const apply = async () => {
      if (busy || pending === null) { return; }
      busy = true;
      const text = pending;
      pending = null;
      try {
        const doc = editor.document;
        const range = new vscode.Range(
          doc.positionAt(startOffset),
          doc.positionAt(currentEnd)
        );
        const ok = await editor.edit(
          (eb) => { eb.replace(range, text); },
          { undoStopBefore: false, undoStopAfter: false }
        );
        if (ok) {
          currentEnd = startOffset + text.length;
        }
      } catch { /* editor busy */ }
      busy = false;
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
        while (busy) { await new Promise(r => setTimeout(r, 80)); }
      }
    };
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
  // SECTION DETECTION
  // ===========================

  /**
   * Heuristic: scan the file for a code block that is likely relevant
   * to the user's instruction. Returns a { start, end } line-range (0-indexed)
   * or null if nothing meaningful was found.
   */
  private findRelevantSection(
    lines: string[],
    instruction: string
  ): { start: number; end: number } | null {
    const lower = instruction.toLowerCase();

    // Extract potential identifiers the user mentioned (function/class/variable names)
    const identifiers = lower.match(/\b[a-z_$][a-z0-9_$]*\b/gi) || [];
    // Remove common stop-words so we only search meaningful identifiers
    const stopWords = new Set([
      'the', 'a', 'an', 'is', 'it', 'to', 'in', 'on', 'of', 'for', 'and', 'or',
      'this', 'that', 'add', 'change', 'update', 'modify', 'remove', 'fix', 'make',
      'new', 'with', 'from', 'into', 'can', 'should', 'not', 'dont', 'please',
      'create', 'use', 'using', 'want', 'need', 'code', 'function', 'class', 'method',
      'style', 'color', 'text', 'background', 'css', 'html', 'javascript', 'typescript',
      'react', 'component', 'button', 'input', 'form', 'div', 'section', 'header',
      'footer', 'nav', 'sidebar', 'modal', 'dropdown'
    ]);
    const keywords = identifiers.filter(w => !stopWords.has(w.toLowerCase()) && w.length > 2);

    // Try to find a block containing one of the keywords
    let bestStart = -1;
    let bestScore = 0;

    // Also look for common HTML/CSS/JS section names in the instruction
    const sectionPatterns: RegExp[] = [];
    if (/\bnav(bar|igation)?\b/i.test(lower)) { sectionPatterns.push(/\bnav/i); }
    if (/\bheader\b/i.test(lower)) { sectionPatterns.push(/\bheader/i); }
    if (/\bfooter\b/i.test(lower)) { sectionPatterns.push(/\bfooter/i); }
    if (/\bsidebar\b/i.test(lower)) { sectionPatterns.push(/\bsidebar/i); }
    if (/\bmodal\b/i.test(lower)) { sectionPatterns.push(/\bmodal/i); }
    if (/\bhero\b/i.test(lower)) { sectionPatterns.push(/\bhero/i); }
    if (/\bcard\b/i.test(lower)) { sectionPatterns.push(/\bcard/i); }
    if (/\btable\b/i.test(lower)) { sectionPatterns.push(/\btable/i); }
    if (/\bform\b/i.test(lower)) { sectionPatterns.push(/\bform/i); }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let lineScore = 0;

      for (const kw of keywords) {
        if (line.toLowerCase().includes(kw.toLowerCase())) { lineScore += 2; }
      }
      for (const pat of sectionPatterns) {
        if (pat.test(line)) { lineScore += 3; }
      }

      if (lineScore > bestScore) {
        bestScore = lineScore;
        bestStart = i;
      }
    }

    if (bestStart < 0 || bestScore < 2) { return null; }

    // Expand from anchor line to enclosing block
    // Walk backward to find block start
    let start = bestStart;
    let depth = 0;
    for (let i = bestStart; i >= 0; i--) {
      const line = lines[i];
      depth += (line.match(/[{}]/g) || []).reduce((d: number, ch: string) => d + (ch === '}' ? 1 : -1), 0);
      if (depth <= 0 && i < bestStart) {
        // Found a line at the same or outer nesting level — this might be the block start
        if (/^\s*(function|class|const|let|var|export|import|<\w|\/\*|\/\/|\.[\w-]+\s*\{|#[\w-]+|@media|@keyframes)/.test(line.trim()) || line.trim() === '') {
          start = i;
          break;
        }
      }
      start = i;
    }

    // Walk forward to find block end
    let end = bestStart;
    depth = 0;
    for (let i = start; i < lines.length; i++) {
      for (const ch of lines[i]) {
        if (ch === '{' || ch === '(' || ch === '<') { depth++; }
        if (ch === '}' || ch === ')' || ch === '>') { depth--; }
      }
      end = i;
      if (depth <= 0 && i > bestStart) { break; }
      // Also cap at a reasonable size (max ~60 lines from anchor)
      if (i - start > 60) { break; }
    }

    // Ensure minimum context
    if (end - start < 3) {
      start = Math.max(0, bestStart - 5);
      end = Math.min(lines.length - 1, bestStart + 15);
    }

    return { start, end };
  }

  // ===========================
  // WHOLE-FILE UPDATE (extracted helper)
  // ===========================

  private async doWholeFileUpdate(
    editor: vscode.TextEditor,
    doc: vscode.TextDocument,
    cleanMessage: string,
    target: { languageId?: string; promptLanguage: string },
    contextParts: string[]
  ) {
    const currentFileContent = doc.getText();

    const baseCtx = await this.buildCodebaseContext(doc, { targetLanguageId: target.languageId, instruction: cleanMessage }, true);
    contextParts.push(baseCtx);

    this._view?.webview.postMessage({
      type: 'assistantMessage',
      message: '⏳ Generating code — watch the editor for live changes…'
    });

    // Stream code directly into the editor
    const updater = this.makeStreamUpdater(editor, 200);
    const newCode = await this.groqClient.generateCodeStreaming(
      cleanMessage,
      target.promptLanguage,
      updater.onChunk,
      contextParts.join('\n\n'),
      currentFileContent
    );

    await updater.flush();
    await this.replaceFullDocument(editor, newCode, 5);
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

  public clearConversation() {
    this.conversationHistory = [];
    this._view?.webview.postMessage({ type: 'clearMessages' });
  }

  /** Start a new chat session (like Copilot's new chat feature). */
  public startNewChat() {
    this.conversationHistory = [];
    this._view?.webview.postMessage({ type: 'clearMessages' });
    vscode.window.showInformationMessage('Started new chat session');
  }

  /** Close the chat panel. */
  public closePanel() {
    // Hide the webview panel (similar to Copilot)
    if (this._view) {
      // In VS Code, we can't directly close a webview view, but we can hide it
      // by collapsing the sidebar or using the command to focus elsewhere
      vscode.commands.executeCommand('workbench.action.closeSidebar');
    }
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

  private getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = this.getNonce();
    return `<!DOCTYPE html>
<html lang="en" style="height:100%;">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data: https://*.googleusercontent.com;">
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 0;
    font-family: var(--vscode-font-family);
    background: var(--vscode-sideBar-background);
    color: var(--vscode-foreground);
    height: 100%;
    display: flex;
    flex-direction: column;
  }
  .header {
    padding: 14px 12px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid var(--vscode-panel-border);
    background: var(--vscode-sideBar-background);
  }
  .header strong {
    font-size: 14px;
    font-weight: 700;
    letter-spacing: -0.3px;
  }
  .header-actions { display: flex; gap: 8px; }
  #newChat {
    padding: 6px 12px;
    font-size: 12px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.15s;
    font-weight: 600;
  }
  #newChat:hover { opacity: 0.85; transform: translateY(-1px); }
  #newChat:active { transform: translateY(0); }
  #close {
    padding: 4px 8px;
    font-size: 18px;
    line-height: 1;
    background: transparent;
    color: var(--vscode-foreground);
    border: none;
    border-radius: 6px;
    cursor: pointer;
    opacity: 0.5;
    transition: all 0.15s;
  }
  #close:hover {
    opacity: 1;
    background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.1));
  }
  .chat {
    flex: 1;
    overflow-y: auto;
    padding: 16px 12px;
  }
  .msg {
    margin-bottom: 16px;
    display: flex;
    flex-direction: column;
  }
  .msg .msg-label {
    font-size: 11px;
    font-weight: 700;
    color: var(--vscode-foreground);
    opacity: 0.7;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    margin-bottom: 6px;
  }
  .msg.user .msg-label { 
    opacity: 0.9;
    color: var(--vscode-button-background);
  }
  .msg.assistant .msg-label { 
    opacity: 0.6;
  }
  .bubble {
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 10px 12px;
    border-radius: 8px;
    border: 1px solid var(--vscode-panel-border);
    white-space: pre-wrap;
    font-size: 13px;
    line-height: 1.6;
    word-wrap: break-word;
  }
  .msg.user .bubble {
    background: var(--vscode-input-background, rgba(100, 100, 100, 0.1));
    border-color: var(--vscode-button-background);
    border-left: 3px solid var(--vscode-button-background);
  }
  .msg.assistant .bubble {
    background: var(--vscode-editor-background);
    border-color: var(--vscode-panel-border);
    opacity: 0.95;
  }
  .msg-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 6px;
  }
  .msg-actions {
    display: flex;
    gap: 4px;
  }
  .msg-actions button {
    background: none;
    border: none;
    color: var(--vscode-foreground);
    opacity: 0;
    cursor: pointer;
    font-size: 13px;
    padding: 4px 6px;
    border-radius: 4px;
    transition: all 0.15s;
  }
  .msg-actions button svg {
    width: 14px;
    height: 14px;
    fill: currentColor;
    vertical-align: middle;
  }
  .msg-actions button .check-icon { display: none; color: #4ade80; }
  .msg-actions button.done svg { display: none; }
  .msg-actions button.done .check-icon { display: inline; }
  .msg:hover .msg-actions button { opacity: 0.6; }
  .msg-actions button:hover {
    opacity: 1 !important;
    background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.12));
  }
  .msg-actions button.restore-btn:hover {
    color: #f97316;
  }
  /* ── Copilot-style chat input ── */
  .chat-input-wrapper {
    padding: 12px;
    border-top: 1px solid var(--vscode-panel-border);
    background: var(--vscode-sideBar-background);
  }
  .chat-input-container {
    display: flex;
    flex-direction: column;
    border-radius: 10px;
    background: var(--vscode-input-background, var(--vscode-editor-background));
    border: 1.5px solid var(--vscode-input-border, var(--vscode-panel-border));
    transition: all 0.2s;
    overflow: hidden;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  }
  .chat-input-container:focus-within {
    border-color: var(--vscode-focusBorder);
    box-shadow: 0 0 0 2px rgba(100, 150, 255, 0.2);
  }
  .mode-selector-compact {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 10px;
    border-bottom: 1px solid var(--vscode-panel-border);
    background: var(--vscode-input-background, var(--vscode-editor-background));
  }
  .mode-tabs {
    display: flex;
    gap: 3px;
  }
  .mode-tab {
    padding: 5px 12px;
    font-size: 12px;
    font-weight: 500;
    background: transparent;
    border: none;
    color: var(--vscode-foreground);
    cursor: pointer;
    border-radius: 6px;
    opacity: 0.65;
    transition: all 0.15s;
  }
  .mode-tab:hover {
    opacity: 0.85;
    background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.08));
  }
  .mode-tab.active {
    opacity: 1;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    font-weight: 600;
  }
  .mode-hint-text {
    font-size: 11px;
    opacity: 0.5;
    font-weight: 500;
  }
  .add-context-btn-inner {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    background: transparent;
    border: none;
    border-bottom: 1px solid var(--vscode-panel-border);
    color: var(--vscode-foreground);
    cursor: pointer;
    font-size: 12px;
    font-weight: 500;
    text-align: left;
    transition: all 0.15s;
    width: 100%;
  }
  .add-context-btn-inner:hover {
    background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.06));
  }
  .add-context-btn-inner .icon {
    font-size: 14px;
    opacity: 0.75;
  }
  .chat-input-area {
    padding: 11px 12px;
  }
  .chat-input-area textarea {
    width: 100%;
    resize: none;
    min-height: 36px;
    max-height: 140px;
    padding: 0;
    border: none;
    outline: none;
    background: transparent;
    color: var(--vscode-foreground);
    font-family: var(--vscode-font-family);
    font-size: 13px;
    line-height: 1.5;
    overflow-y: auto;
    font-weight: 400;
  }
  .chat-input-area textarea::placeholder {
    color: var(--vscode-input-placeholderForeground);
    opacity: 0.55;
    font-weight: 400;
  }
  .chat-input-area textarea:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .chat-input-toolbar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 10px;
    border-top: 1px solid var(--vscode-panel-border);
    background: var(--vscode-input-background, var(--vscode-editor-background));
  }
  .toolbar-left {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: 1;
  }
  .toolbar-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 5px 8px;
    border-radius: 6px;
    border: none;
    background: transparent;
    color: var(--vscode-foreground);
    cursor: pointer;
    font-size: 13px;
    opacity: 0.65;
    transition: all 0.15s;
  }
  .toolbar-btn:hover {
    opacity: 1;
    background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.1));
  }
  .toolbar-btn .icon {
    font-size: 16px;
  }
  .toolbar-select {
    padding: 5px 8px;
    border-radius: 6px;
    border: 1px solid var(--vscode-panel-border);
    background: transparent;
    color: var(--vscode-foreground);
    cursor: pointer;
    font-size: 12px;
    opacity: 0.85;
    transition: all 0.15s;
    font-weight: 500;
  }
  .toolbar-select:hover {
    opacity: 1;
    background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.1));
    border-color: var(--vscode-focusBorder);
  }
  .image-preview-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 8px;
    margin-bottom: 4px;
  }
  .image-preview-bar img {
    max-width: 80px;
    max-height: 60px;
    border-radius: 4px;
    border: 1px solid var(--vscode-panel-border);
    object-fit: cover;
  }
  .image-preview-bar .img-name {
    flex: 1;
    font-size: 12px;
    opacity: 0.8;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .image-preview-bar .img-remove {
    cursor: pointer;
    font-size: 16px;
    opacity: 0.7;
    padding: 2px 4px;
    border-radius: 4px;
  }
  .image-preview-bar .img-remove:hover {
    opacity: 1;
    background: var(--vscode-button-secondaryBackground);
  }
  .toolbar-send-btn {
    width: 36px;
    height: 36px;
    min-width: 36px;
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
    transition: all 0.2s;
    font-weight: 600;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
  }
  .toolbar-send-btn:hover {
    opacity: 0.85;
    transform: translateY(-1px);
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
  }
  .toolbar-send-btn:active {
    transform: translateY(0);
  }
  .toolbar-send-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
    background: var(--vscode-button-secondaryBackground);
    transform: none;
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
    padding: 6px 12px;
    font-size: 11px;
    opacity: 0.55;
    font-weight: 400;
    line-height: 1.5;
  }
  .hint b {
    font-weight: 600;
    color: var(--vscode-button-background);
    opacity: 0.9;
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
    gap: 6px;
    padding: 6px 10px 0;
  }
  .file-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 4px 10px;
    background: var(--vscode-badge-background, rgba(100, 100, 100, 0.2));
    color: var(--vscode-badge-foreground, #fff);
    border-radius: 12px;
    font-size: 11px;
    font-weight: 500;
    max-width: 240px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    border: 1px solid var(--vscode-panel-border);
    transition: all 0.15s;
  }
  .file-chip:hover {
    background: var(--vscode-badge-background, rgba(100, 100, 100, 0.3));
    border-color: var(--vscode-focusBorder);
  }
  .file-chip .icon {
    opacity: 0.8;
    font-size: 12px;
    flex-shrink: 0;
  }
  .file-chip .name {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .file-chip .lang-badge {
    font-size: 9px;
    padding: 1px 5px;
    border-radius: 4px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    flex-shrink: 0;
    text-transform: uppercase;
    font-weight: 700;
  }
  .file-chip .remove {
    cursor: pointer;
    opacity: 0.6;
    flex-shrink: 0;
    font-size: 13px;
    line-height: 1;
    transition: opacity 0.15s;
  }
  .file-chip .remove:hover { opacity: 1; }
  /* Checkpoint banner */
  .checkpoint-banner {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 10px 12px;
    margin: 10px 0;
    background: rgba(248, 113, 113, 0.08);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 8px;
    font-size: 12px;
    font-weight: 500;
  }
  .checkpoint-banner button {
    padding: 5px 14px;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 600;
    transition: all 0.15s;
  }
  .btn-keep {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  .btn-discard {
    background: var(--vscode-button-secondaryBackground, rgba(100, 100, 100, 0.3));
    color: var(--vscode-button-secondaryForeground, #fff);
  }
  .btn-keep:hover { opacity: 0.85; transform: translateY(-1px); }
  .btn-discard:hover { opacity: 0.85; transform: translateY(-1px); }
  /* ── Plan execute button ── */
  .plan-actions {
    display: flex;
    gap: 8px;
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid var(--vscode-panel-border);
  }
  .plan-actions button {
    padding: 6px 16px;
    font-size: 12px;
    border-radius: 6px;
    cursor: pointer;
    border: none;
    font-weight: 600;
    transition: all 0.15s;
  }
  .plan-execute-btn {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  .plan-execute-btn:hover { opacity: 0.85; transform: translateY(-1px); }
  .plan-copy-btn {
    background: var(--vscode-button-secondaryBackground, rgba(100, 100, 100, 0.2));
    color: var(--vscode-button-secondaryForeground, #fff);
  }
  .plan-copy-btn:hover { opacity: 0.85; transform: translateY(-1px); }
  /* ── Diff summary styling in bubble ── */
  .bubble .diff-summary {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px;
    line-height: 1.6;
  }
  /* ── Login overlay ── */
  .login-overlay {
    position: absolute;
    inset: 0;
    z-index: 999;
    background: linear-gradient(135deg, var(--vscode-sideBar-background) 0%, var(--vscode-editor-background) 100%);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 18px;
    padding: 28px;
    text-align: center;
  }
  .login-overlay.hidden { display: none; }
  .login-overlay .logo {
    font-size: 48px;
    margin-bottom: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .login-overlay h2 {
    margin: 0;
    font-size: 20px;
    font-weight: 700;
    color: var(--vscode-foreground);
    letter-spacing: -0.3px;
  }
  .login-overlay p {
    margin: 0;
    font-size: 13px;
    opacity: 0.7;
    max-width: 280px;
    line-height: 1.6;
    font-weight: 400;
  }
  .google-btn {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    padding: 12px 28px;
    background: #4285f4;
    color: #fff;
    font-size: 14px;
    font-weight: 700;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.2s;
    margin-top: 10px;
    box-shadow: 0 2px 4px rgba(66, 133, 244, 0.3);
  }
  .google-btn:hover { 
    opacity: 0.88;
    transform: translateY(-2px);
    box-shadow: 0 4px 8px rgba(66, 133, 244, 0.4);
  }
  .google-btn:active { transform: translateY(0); }
  .google-btn .g-icon {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    font-weight: 700;
    color: #4285f4;
  }
  /* ── User avatar bar (shown when signed in) ── */
  .user-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    font-size: 12px;
    border-bottom: 1px solid var(--vscode-panel-border);
    background: rgba(100, 150, 255, 0.02);
  }
  .user-bar.hidden { display: none; }
  .user-bar img {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    border: 2px solid var(--vscode-button-background);
    object-fit: cover;
  }
  .user-bar .user-name {
    flex: 1;
    opacity: 0.9;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-weight: 500;
  }
  .user-bar .sign-out-btn {
    background: none;
    border: none;
    color: var(--vscode-foreground);
    opacity: 0.6;
    cursor: pointer;
    font-size: 11px;
    padding: 3px 8px;
    border-radius: 4px;
    transition: all 0.15s;
    font-weight: 500;
  }
  .user-bar .sign-out-btn:hover {
    opacity: 1;
    background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.12));
  }
  .user-bar .sign-out-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
</style>
</head>

<body>
  <!-- LOGIN OVERLAY — hides the chat until user signs in -->
  <div class="login-overlay" id="loginOverlay">
    <div class="logo">🚀</div>
    <h2>Welcome to Prompt2Code</h2>
    <p>Sign in with your Google account to start generating code with AI.</p>
    <button class="google-btn" id="googleSignInBtn">
      <span class="g-icon">G</span> Sign in with Google
    </button>
  </div>

  <!-- USER BAR — shown when signed in -->
  <div class="user-bar hidden" id="userBar">
    <img id="userAvatar" src="" alt="" />
    <span class="user-name" id="userName"></span>
    <button class="sign-out-btn" id="signOutBtn">🚪 Sign out</button>
  </div>

  <div class="header">
    <strong>Prompt2Code</strong>
    <div class="header-actions">
      <button id="newChat" title="Start a new chat">+</button>
      <button id="close" title="Close panel">×</button>
    </div>
  </div>

  <div class="hint">
    <b>@file</b> to include files &middot;
    <b>@workspace</b> for project tree &middot;
    <b>"create file …"</b> to create new files
  </div>

  <div class="loading-bar" id="loadingBar"></div>

  <div class="chat" id="chat"></div>

  <div class="typing" id="typingIndicator">⏳ Working… generating code in the editor</div>
  <div class="attached-files" id="attachedFiles"></div>
  <div class="chat-input-wrapper">
    <div class="chat-input-container">
      <div class="mode-selector-compact">
        <div class="mode-tabs">
          <button class="mode-tab" data-mode="ask" title="Ask questions about code">Ask</button>
          <button class="mode-tab active" data-mode="agent" title="Edit code, create files">Agent</button>
          <button class="mode-tab" data-mode="plan" title="Plan before implementing">Plan</button>
        </div>
        <span class="mode-hint-text" id="modeHint">Auto-edits files & creates code</span>
      </div>
      <button class="add-context-btn-inner" id="addContextBtn">
        <span class="icon">📎</span>
        <span>Add Context...</span>
      </button>
      <div class="chat-input-area">
        <textarea id="input" rows="1" placeholder="Describe what to build next"></textarea>
      </div>
      <div id="imagePreview" style="display:none"></div>
      <div class="chat-input-toolbar">
        <div class="toolbar-left">
          <button class="toolbar-btn" id="addFile" title="Add file to context">
            <span class="icon">📄</span>
          </button>
          <button class="toolbar-btn" id="addImage" title="Upload UI screenshot">
            <span class="icon">🖼</span>
          </button>
          <select class="toolbar-select" id="modelSelect">
            <option>Loading…</option>
          </select>
          <button class="toolbar-btn" id="moreOptions" title="More options">
            <span class="icon">⚙️</span>
          </button>
        </div>
        <button id="send" class="toolbar-send-btn" title="Send" aria-label="Send">
          <span class="send-icon" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M3 17L17 10L3 3V8.5L13 10L3 11.5V17Z" fill="currentColor"/>
            </svg>
          </span>
        </button>
      </div>
    </div>
    <input type="file" id="imageInput" accept="image/png,image/jpeg,image/gif,image/webp" style="display:none" />
  </div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const chat = document.getElementById('chat');
  const input = document.getElementById('input');
  const send = document.getElementById('send');
  const newChat = document.getElementById('newChat');
  const close = document.getElementById('close');
  const addContextBtn = document.getElementById('addContextBtn');
  const addFile = document.getElementById('addFile');
  const addImage = document.getElementById('addImage');
  const imageInput = document.getElementById('imageInput');
  const imagePreview = document.getElementById('imagePreview');
  const loadingBar = document.getElementById('loadingBar');
  const typingIndicator = document.getElementById('typingIndicator');
  const attachedFilesEl = document.getElementById('attachedFiles');
  const modelSelect = document.getElementById('modelSelect');
  const moreOptions = document.getElementById('moreOptions');

  // ── Auth elements ──
  const loginOverlay = document.getElementById('loginOverlay');
  const googleSignInBtn = document.getElementById('googleSignInBtn');
  const userBar = document.getElementById('userBar');
  const userAvatar = document.getElementById('userAvatar');
  const userName = document.getElementById('userName');
  const signOutBtn = document.getElementById('signOutBtn');

  googleSignInBtn.onclick = () => {
    googleSignInBtn.disabled = true;
    googleSignInBtn.textContent = 'Opening browser…';
    vscode.postMessage({ type: 'googleSignIn' });
    // Re-enable after 5 s in case user closes the tab
    setTimeout(() => { googleSignInBtn.disabled = false; googleSignInBtn.innerHTML = '<span class="g-icon">G</span> Sign in with Google'; }, 5000);
  };
  signOutBtn.onclick = () => {
    signOutBtn.disabled = true;
    signOutBtn.textContent = '⏳ Signing out...';
    vscode.postMessage({ type: 'googleSignOut' });
    // Re-enable after 3s in case user cancels
    setTimeout(() => { signOutBtn.disabled = false; signOutBtn.textContent = '🚪 Sign out'; }, 3000);
  };

  function applyAuthState(signedIn, user) {
    if (signedIn && user) {
      loginOverlay.classList.add('hidden');
      userBar.classList.remove('hidden');
      userAvatar.src = user.picture || '';
      userName.textContent = user.name || user.email || 'User';
    } else {
      loginOverlay.classList.remove('hidden');
      userBar.classList.add('hidden');
    }
  }

  let loading = false;
  let availableModels = [];
  let currentMode = 'agent';

  // ── Image attachment state ──
  let pendingImage = null; // { base64, mimeType, fileName }

  addImage.onclick = () => { imageInput.click(); };

  imageInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) {
      alert('Image too large. Max 4 MB for the vision API.');
      imageInput.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const base64 = dataUrl.split(',')[1];
      const mimeType = file.type || 'image/png';
      pendingImage = { base64, mimeType, fileName: file.name };
      // Show preview
      imagePreview.innerHTML =
        '<div class="image-preview-bar">' +
          '<img src="' + dataUrl + '" />' +
          '<span class="img-name">' + file.name + '</span>' +
          '<span class="img-remove" title="Remove image">&times;</span>' +
        '</div>';
      imagePreview.style.display = 'block';
      imagePreview.querySelector('.img-remove').onclick = () => {
        pendingImage = null;
        imagePreview.innerHTML = '';
        imagePreview.style.display = 'none';
        imageInput.value = '';
      };
      // Update placeholder hint
      input.placeholder = 'Describe what you want (or leave empty to replicate the UI)…';
    };
    reader.readAsDataURL(file);
  });

  const modeHints = {
    ask: 'Explains code — no file edits',
    agent: 'Auto-edits files & creates code',
    plan: 'Creates a plan before implementing'
  };

  // ── Mode selector ──
  const modeTabs = document.querySelectorAll('.mode-tab');
  const modeHint = document.getElementById('modeHint');

  modeTabs.forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      if (mode === currentMode) return;
      currentMode = mode;
      modeTabs.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      modeHint.textContent = modeHints[mode] || '';
      vscode.postMessage({ type: 'setMode', mode });

      // Update placeholder
      const placeholders = {
        ask: 'Ask a question about your code',
        agent: 'Describe what to build next',
        plan: 'Describe what you want to build'
      };
      input.placeholder = placeholders[mode] || placeholders.agent;
    });
  });

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
    if (loading) return;

    // If an image is attached, send as image message
    if (pendingImage) {
      const msg = input.value.trim() || 'Recreate this UI exactly as shown in the image';
      vscode.postMessage({
        type: 'sendImageMessage',
        message: msg,
        imageBase64: pendingImage.base64,
        mimeType: pendingImage.mimeType,
        fileName: pendingImage.fileName
      });
      input.value = '';
      pendingImage = null;
      imagePreview.innerHTML = '';
      imagePreview.style.display = 'none';
      imageInput.value = '';
      input.placeholder = 'Describe what to build next';
      return;
    }

    if (!input.value.trim()) return;
    const files = trackedFiles.map(f => f.relPath);
    vscode.postMessage({ type: 'sendMessage', message: input.value, attachedFiles: files });
    input.value = '';
  };

  newChat.onclick = () => {
    vscode.postMessage({ type: 'newChat' });
  };

  close.onclick = () => {
    vscode.postMessage({ type: 'closePanel' });
  };

  addContextBtn.onclick = () => {
    vscode.postMessage({ type: 'pickFile' });
  };

  addFile.onclick = () => {
    vscode.postMessage({ type: 'pickFile' });
  };

  moreOptions.onclick = () => {
    // Could open settings or show more options in the future
    vscode.postMessage({ type: 'showOptions' });
  };

  // Model selector
  modelSelect.onchange = () => {
    const selectedId = modelSelect.value;
    vscode.postMessage({ type: 'selectModel', modelId: selectedId });
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

    if (msg.type === 'authState') { applyAuthState(msg.signedIn, msg.user); }
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
    if (msg.type === 'modeChanged') {
      currentMode = msg.mode;
      modeBtns.forEach(b => {
        b.classList.toggle('active', b.dataset.mode === msg.mode);
      });
      modeHint.textContent = modeHints[msg.mode] || '';
    }
    if (msg.type === 'planMessage') {
      // Show plan with execute button
      addPlan(msg.message, msg.originalRequest);
    }
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
    if (msg.type === 'modelList') {
      availableModels = msg.models || [];
      modelSelect.innerHTML = '';
      for (const m of availableModels) {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.label + ' (' + m.ctx + ')';
        if (m.id === msg.activeModel) { opt.selected = true; }
        modelSelect.appendChild(opt);
      }
    }
    if (msg.type === 'modelChangeResult') {
      if (msg.success) {
        modelSelect.value = msg.activeModel;
      } else {
        // Revert the dropdown to the active model
        const cur = availableModels.find(m => m.id === msg.activeModel);
        if (cur) { modelSelect.value = cur.id; }
        if (msg.error) {
          add('Error', msg.error, 'assistant');
        }
      }
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

  // Handle plan message with execute button
  function addPlan(text, originalRequest) {
    const div = document.createElement('div');
    div.className = 'msg assistant';

    const header = document.createElement('div');
    header.className = 'msg-header';
    const label = document.createElement('span');
    label.className = 'msg-label';
    label.textContent = '📋 Plan';
    header.appendChild(label);

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;

    const actions = document.createElement('div');
    actions.className = 'plan-actions';

    const execBtn = document.createElement('button');
    execBtn.className = 'plan-execute-btn';
    execBtn.textContent = '▶ Execute Plan';
    execBtn.onclick = () => {
      execBtn.disabled = true;
      execBtn.textContent = '⏳ Executing…';
      vscode.postMessage({ type: 'executePlan', plan: text });
    };

    const copyBtn = document.createElement('button');
    copyBtn.className = 'plan-copy-btn';
    copyBtn.textContent = '📋 Copy Plan';
    copyBtn.onclick = () => {
      vscode.postMessage({ type: 'copyCode', code: text });
      copyBtn.textContent = '✓ Copied';
      setTimeout(() => { copyBtn.textContent = '📋 Copy Plan'; }, 1500);
    };

    actions.appendChild(execBtn);
    actions.appendChild(copyBtn);

    div.appendChild(header);
    div.appendChild(bubble);
    div.appendChild(actions);
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
  }
</script>
</body>
</html>`;
  }
}
