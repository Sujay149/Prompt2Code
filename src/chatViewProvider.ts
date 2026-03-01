import * as vscode from 'vscode';
import * as path from 'path';
import { GroqClient, GroqMessage } from './groqClient';
import { GoogleAuthProvider } from './authProvider';
import {
  listWorkspaceFiles,
  createWorkspaceFile,
  createWorkspaceFileQuiet,
  parseMultiFileResponse,
  parseIntegrationResponse,
  modifyWorkspaceFile,
  workspaceFileExists,
  readMultipleFiles,
  buildProjectTree,
  readFilesAsContext,
  readWorkspaceFile,
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
    if (!this._view) { 
      console.log('⚠️ sendAuthStateToWebview: no webview available');
      return; 
    }
    
    if (!this.authProvider) {
      console.log('⚠️ sendAuthStateToWebview: no auth provider');
      this._view.webview.postMessage({ type: 'authState', signedIn: false, user: null });
      return;
    }

    try {
      const signedIn = await this.authProvider.isAuthenticated();
      const user = signedIn ? await this.authProvider.getUserInfo() : null;
      
      console.log('📤 Sending auth state to webview:', { signedIn, user: user ? user.email : null });
      
      this._view.webview.postMessage({ 
        type: 'authState', 
        signedIn, 
        user 
      });
    } catch (error) {
      console.error('❌ Error getting auth state:', error);
      this._view.webview.postMessage({ type: 'authState', signedIn: false, user: null });
    }
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

    // Now safe to send initial state (HTML is loaded)
    this.sendActiveFileToWebview(this.lastTextEditor);

    // Send available models + current selection to webview
    this.sendModelListToWebview();

    // Re-send auth state whenever the view becomes visible again
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        console.log('👁️ Webview became visible, re-sending auth state');
        this.sendAuthStateToWebview();
      }
    });

    webviewView.webview.onDidReceiveMessage(async (data) => {
      console.log('Webview → Extension:', data);
      switch (data.type) {
        case 'webviewReady': {
          console.log('✅ Webview reported ready, sending initial state');
          this.sendModelListToWebview();
          await this.sendAuthStateToWebview();
          break;
        }

        case 'sendMessage':
          await this.handleUserMessage(data.message, data.attachedFiles || [], data.localFiles || []);
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
          // Handle Google Sign-In request from webview
          if (!this.authProvider) {
            vscode.window.showErrorMessage('Authentication system not initialized. Please reload VS Code.');
            this._view?.webview.postMessage({ type: 'authState', signedIn: false, user: null });
            this._view?.webview.postMessage({ type: 'error', message: 'Authentication system not initialized. Please reload the window (Ctrl+Shift+P → Reload Window).' });
            break;
          }
          console.log('🔐 Extension received googleSignIn message, starting OAuth flow…');
          try {
            const user = await this.authProvider.signIn();
            if (user) {
              vscode.window.showInformationMessage(`✅ Signed in as ${user.name || user.email}`);
              this._view?.webview.postMessage({ type: 'authState', signedIn: true, user });
            } else {
              vscode.window.showWarningMessage('Google Sign-In was cancelled or failed. Check the browser tab.');
              this._view?.webview.postMessage({ type: 'authState', signedIn: false, user: null });
              this._view?.webview.postMessage({ type: 'error', message: 'Google Sign-In was cancelled or failed. Please check your browser and try again.' });
            }
            // Always refresh auth state after sign-in attempt
            await this.sendAuthStateToWebview();
          } catch (error: any) {
            console.error('❌ Sign-in error:', error);
            vscode.window.showErrorMessage(`Sign-in failed: ${error.message}`);
            this._view?.webview.postMessage({ type: 'authState', signedIn: false, user: null });
            this._view?.webview.postMessage({ type: 'error', message: `Sign-in failed: ${error.message}` });
          }
          break;
        }

        case 'requestAuthState': {
          console.log('🔄 Webview requested auth state refresh');
          await this.sendAuthStateToWebview();
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

        case 'requestApiKeys': {
          const models = GroqClient.AVAILABLE_MODELS;
          const keys: Record<string, string> = {};
          for (const m of models) {
            // Use explicit per-model key only — no global fallback
            // so models the user hasn't configured show blank in the UI
            const k = this.groqClient.getExplicitApiKeyForModel(m.id);
            if (k && k.trim()) {
              const t = k.trim();
              // Mask: show first 4 chars + bullets + last 4 chars
              const bullets = '•'.repeat(Math.max(8, Math.min(20, t.length - 8)));
              keys[m.id] = t.slice(0, 4) + bullets + t.slice(-4);
            } else {
              keys[m.id] = '';
            }
          }
          this._view?.webview.postMessage({
            type: 'apiKeysState',
            keys,
            activeModel: this.groqClient.getActiveModel(),
          });
          break;
        }

        case 'setApiKey': {
          const { modelId, apiKey } = data;
          if (!modelId || !apiKey?.trim()) {
            this._view?.webview.postMessage({ type: 'apiKeyResult', success: false, message: 'No key provided.' });
            break;
          }
          // Save the key immediately so it is usable right away
          const cfg = vscode.workspace.getConfiguration('prompt2code');
          const perModelKeys = { ...cfg.get<Record<string, string>>('apiKeys', {}) };
          perModelKeys[modelId] = apiKey.trim();
          await cfg.update('apiKeys', perModelKeys, vscode.ConfigurationTarget.Global);
          const modelLabel = GroqClient.AVAILABLE_MODELS.find(m => m.id === modelId)?.label ?? modelId;
          // Acknowledge save immediately so the UI updates without waiting for network
          this._view?.webview.postMessage({
            type: 'apiKeyResult', success: true,
            message: `API key for ${modelLabel} saved.`,
          });
          // Validate in the background and show a non-blocking warning if the key looks invalid
          this.groqClient.validateApiKey(apiKey.trim(), modelId).then(validation => {
            if (!validation.valid) {
              this._view?.webview.postMessage({
                type: 'apiKeyResult', success: true,   // keep success=true so UI stays green
                message: `Key saved — but validation warning: ${validation.error ?? 'key may be invalid. It will still be used.'}`
              });
            }
          }).catch(() => { /* ignore network errors during background validation */ });
          break;
        }

        case 'deleteApiKey': {
          const { modelId } = data;
          const cfg = vscode.workspace.getConfiguration('prompt2code');
          const perModelKeys = { ...cfg.get<Record<string, string>>('apiKeys', {}) };
          delete perModelKeys[modelId];
          await cfg.update('apiKeys', perModelKeys, vscode.ConfigurationTarget.Global);
          const modelLabel = GroqClient.AVAILABLE_MODELS.find(m => m.id === modelId)?.label ?? modelId;
          this._view?.webview.postMessage({
            type: 'apiKeyResult', success: true,
            message: `Key for ${modelLabel} removed.`,
          });
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
    // Attach hasKey flag so webview can group them
    const modelsWithKeyStatus = models.map(m => ({
      ...m,
      hasKey: !!(this.groqClient.getApiKeyForModel(m.id)?.trim()),
    }));
    this._view.webview.postMessage({
      type: 'modelList',
      models: modelsWithKeyStatus,
      activeModel,
    });
  }

  /** Handle model selection from the webview dropdown. */
  private async handleModelSelection(modelId: string) {
    const modelInfo = GroqClient.AVAILABLE_MODELS.find(m => m.id === modelId);
    const modelLabel = modelInfo?.label ?? modelId;
    const provider = GroqClient.getProviderForModel(modelId);
    const provMeta = GroqClient.getProviderMeta(provider);

    // Check if this specific model already has a key (per-model or global fallback)
    let apiKey = this.groqClient.getApiKeyForModel(modelId);

    if (!apiKey || apiKey.trim() === '') {
      // First time using this model — prompt for its API key
      const enteredKey = await vscode.window.showInputBox({
        title: `${provMeta.name} API Key for ${modelLabel}`,
        prompt: `Enter your ${provMeta.name} API key to use ${modelLabel}. Get one at ${provMeta.apiKeyUrl}`,
        placeHolder: provMeta.placeholder,
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

  /**
   * Provide lightweight local replies for casual chat (greetings, thanks, farewells)
   * so we do not call the LLM for trivial exchanges.
   */
  private getQuickReply(message: string): string | null {
    const text = message.trim();
    if (!text) { return null; }

    const lower = text.toLowerCase();

    if (/^(hi|hello|hey|hiya|yo|hola)\b/.test(lower)) {
      return 'Hi! How can I help you today?';
    }

    if (/^good (morning|afternoon|evening)\b/.test(lower)) {
      return 'Hello! How can I help you today?';
    }

    if (/^(thanks|thank you|ty)\b/.test(lower)) {
      return "You're welcome! What can I help with next?";
    }

    if (/^(bye|goodbye|see ya|see you|cya)\b/.test(lower)) {
      return 'Goodbye! If you need help later, just ask.';
    }

    if (/^(how are you|how\s*r\s*u|what's up|whats up|sup)\b/.test(lower) && text.length <= 40) {
      return "I'm here and ready to help. What can I do for you?";
    }

    return null;
  }

  // ===========================
  // MESSAGE HANDLING
  // ===========================

  private async handleUserMessage(message: string, attachedFiles: string[] = [], localFiles: { name: string; content: string }[] = []) {
    if (!message || !message.trim()) return;

    // Gate behind Google auth
    if (this.authProvider && !(await this.authProvider.isAuthenticated())) {
      this._view?.webview.postMessage({
        type: 'error',
        message: '🔒 Please sign in with Google before using Prompt2Code.'
      });
      return;
    }

    console.log('📨 Handling message:', message, 'mode:', this.currentMode, 'attached:', attachedFiles, 'local:', localFiles.map(f => f.name));

    // Prepend any locally-uploaded file contents to the message as inline context
    let enrichedMessage = message;
    if (localFiles.length > 0) {
      const localContext = localFiles
        .map(f => `### Uploaded file: ${f.name}\n\`\`\`\n${f.content}\n\`\`\``)
        .join('\n\n');
      enrichedMessage = `${message}\n\n${localContext}`;
    }

    // 1️⃣ Show user message immediately (checkpointId attached later for code-edit path)
    this._view?.webview.postMessage({
      type: 'userMessage',
      message
    });

    // 2️⃣ Save conversation (for chat mode history)
    this.conversationHistory.push({ role: 'user', content: enrichedMessage });

    // 2.5️⃣ Quick local reply for casual chat (no LLM call)
    const quickReply = this.getQuickReply(message);
    if (quickReply) {
      this.conversationHistory.push({ role: 'assistant', content: quickReply });
      this._view?.webview.postMessage({ type: 'assistantMessage', message: quickReply });
      return;
    }

    // 3️⃣ Route to the appropriate handler based on mode
    switch (this.currentMode) {
      case 'ask':
        await this.handleAskMode(enrichedMessage, attachedFiles);
        return;
      case 'plan':
        await this.handlePlanMode(enrichedMessage, attachedFiles);
        return;
      case 'agent':
      default:
        await this.handleAgentMode(enrichedMessage, attachedFiles);
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
        const provMeta = GroqClient.getProviderMeta(GroqClient.getProviderForModel(activeModel));
        throw new Error(`⚠️ No API key for ${modelLabel}. Select the model from the dropdown to set its key.\n\nGet your ${provMeta.name} API key at: ${provMeta.apiKeyUrl}`);
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
            '- Mirror the user\'s tone; keep greetings short (e.g., "Hi! How can I help?").\n' +
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
        const provMeta = GroqClient.getProviderMeta(GroqClient.getProviderForModel(activeModel));
        throw new Error(`⚠️ No API key for ${modelLabel}. Select the model from the dropdown to set its key.\n\nGet your ${provMeta.name} API key at: ${provMeta.apiKeyUrl}`);
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
        const provMeta = GroqClient.getProviderMeta(GroqClient.getProviderForModel(activeModel));
        throw new Error(`⚠️ No API key for ${modelLabel}. Select the model from the dropdown to set its key.\n\nGet your ${provMeta.name} API key at: ${provMeta.apiKeyUrl}`);
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

      // ── Detect create-and-integrate intent (new component + modify existing files) ──
      if (this.isCreateAndIntegrateIntent(cleanMessage)) {
        await this.handleCreateAndIntegrate(cleanMessage, allFileRefs, referencedFilesContext);
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
      'For NEW files:',
      '===NEW_FILE: path/to/file.ext===',
      '...complete file content...',
      '===END_FILE===',
      '',
      'For MODIFYING existing files (use targeted search/replace):',
      '===MODIFY_FILE: path/to/existing.ext===',
      '<<<SEARCH>>>',
      '...exact lines to find in the existing file...',
      '<<<REPLACE>>>',
      '...replacement lines...',
      '<<<END>>>',
      '===END_FILE===',
      '',
      'If you prefer to output the FULL updated file instead of search/replace, use:',
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
      '- Do NOT wrap the file blocks inside code fences.',
      '- IMPORTANT: If you are adding new components, also MODIFY existing files to import and use them.',
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
    userPrompt += 'Generate the files now. Start with ===NEW_FILE: path=== or ===FILE: path=== immediately.';

    const messages: GroqMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    console.log('🚀 Calling Groq API (multi-file generation with continuation)...');
    const rawResponse = await this.groqClient.completeWithContinuation(messages, { maxContinuations: 5 });

    // Parse using the enhanced integration parser (handles NEW_FILE, MODIFY_FILE, and FILE blocks)
    const integration = parseIntegrationResponse(rawResponse);

    if (integration.newFiles.length === 0 && integration.modifications.length === 0) {
      // AI didn't use the structured format — fall back to showing the response as chat
      this._view?.webview.postMessage({
        type: 'assistantMessage',
        message: rawResponse,
      });
      return;
    }

    // Create all new files
    const created: string[] = [];
    const failed: string[] = [];
    let firstUri: vscode.Uri | undefined;

    for (const block of integration.newFiles) {
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

    // Apply modifications to existing files (if any)
    const modified: string[] = [];
    const failedMods: string[] = [];
    for (const mod of integration.modifications) {
      const exists = await workspaceFileExists(mod.path);
      if (!exists) {
        failedMods.push(`${mod.path} (not found)`);
        continue;
      }
      const result = await modifyWorkspaceFile(mod.path, mod.operations);
      if (result.success) {
        modified.push(mod.path);
      } else {
        failedMods.push(`${mod.path} (${result.error})`);
      }
    }

    // Build summary message
    let summary = '';
    if (created.length > 0) {
      summary += `✅ Created ${created.length} file${created.length !== 1 ? 's' : ''}:\n\n`;
      for (const f of created) {
        summary += `  📄 ${f}\n`;
      }
    }
    if (modified.length > 0) {
      summary += `\n🔧 Modified ${modified.length} existing file${modified.length !== 1 ? 's' : ''}:\n`;
      for (const f of modified) {
        summary += `  ✏️ ${f}\n`;
      }
    }
    if (failed.length > 0) {
      summary += `\n⚠️ Failed to create ${failed.length} file${failed.length !== 1 ? 's' : ''}:\n`;
      for (const f of failed) {
        summary += `  ❌ ${f}\n`;
      }
    }
    if (failedMods.length > 0) {
      summary += `\n⚠️ Failed to modify: ${failedMods.join(', ')}\n`;
    }

    this._view?.webview.postMessage({
      type: 'assistantMessage',
      message: summary,
    });

    this.conversationHistory.push({ role: 'assistant', content: summary });
    vscode.window.showInformationMessage(`Prompt2Code: Created ${created.length} files, modified ${modified.length} files`);
  }

  // ===========================
  // CREATE & INTEGRATE — Create new files + modify existing files
  // ===========================

  /**
   * Detect if the user wants to create/add a new component AND have it
   * integrated into existing files (e.g. "add a sidebar component and
   * integrate it into App.tsx").
   *
   * This also catches implicit integration intent like:
   * - "create a navbar component" (in a React project, needs import in App)
   * - "add authentication to the app" (needs new files + wiring)
   * - "add a contact page and link it in the router"
   */
  private isCreateAndIntegrateIntent(msg: string): boolean {
    const lower = msg.toLowerCase();

    // Explicit integration keywords
    if (/\b(integrate|wire|connect|hook\s*up|plug\s*in|link|register|add\s*to\s*router|add\s*to\s*app|add\s*to\s*layout|include\s*in)\b/i.test(lower)) {
      return true;
    }

    // "add/create X component/page/module" without specifying an exact filename
    // In a project with existing structure, this implies integration
    if (/\b(add|create|build|implement|make)\s+(a\s+|the\s+|new\s+)*([\w-]+\s+)?(component|page|route|module|feature|section|service|hook|provider|context|middleware|util|helper|guard|interceptor|pipe|directive|store|slice|reducer|action)/i.test(lower)) {
      // Only trigger if it's NOT a bare "create file X.ext" (that's handled elsewhere)
      if (!this.detectCreateFileIntent(msg)) {
        return true;
      }
    }

    // "add X to Y" pattern (e.g., "add dark mode to the app", "add search to the header")
    if (/\b(add|implement|include|put|place)\b.{1,40}\b(to|into|in|inside|within)\s+(the\s+)?(app|layout|page|router|navigation|menu|sidebar|header|footer|main|index|home|dashboard)/i.test(lower)) {
      return true;
    }

    // Feature-level requests that need multiple file touches
    if (/\b(add|implement|create|build|set\s*up)\s+(a\s+|the\s+)?(authentication|auth|login\s*system|user\s*management|dark\s*mode|theme\s*switch|search\s*feature|notification|toast\s*system|modal\s*system|routing|state\s*management|api\s*layer|error\s*handling|loading\s*state|pagination|infinite\s*scroll|form\s*validation|file\s*upload|drag\s*and\s*drop|websocket|real[\s-]*time|caching|i18n|internationalization|localization|analytics|logging|testing\s*setup)/i.test(lower)) {
      return true;
    }

    return false;
  }

  /**
   * Main handler: analyze the codebase, generate new files, and modify
   * existing files to integrate the new code.
   */
  private async handleCreateAndIntegrate(
    instruction: string,
    attachedFileRefs: string[],
    referencedFilesContext: string
  ): Promise<void> {
    this._view?.webview.postMessage({
      type: 'assistantMessage',
      message: '🔍 Analyzing your codebase to plan the integration…'
    });

    try {
      // ── 1. Deep codebase analysis ──
      const tree = await buildProjectTree();
      const allFiles = await listWorkspaceFiles(300);

      // Identify key structural files (entry points, routers, layouts, configs)
      const structuralPatterns = [
        /\b(app|main|index|layout|root)\.(tsx?|jsx?|vue|svelte)$/i,
        /\brouter\b.*\.(tsx?|jsx?)$/i,
        /\broutes?\b.*\.(tsx?|jsx?)$/i,
        /\bnavigation\b.*\.(tsx?|jsx?)$/i,
        /\bstore\b.*\.(tsx?|jsx?)$/i,
        /\bprovider\b.*\.(tsx?|jsx?)$/i,
        /\b_app\b.*\.(tsx?|jsx?)$/i,       // Next.js
        /\b_layout\b.*\.(tsx?|jsx?)$/i,     // Next.js app router
        /\bpage\b.*\.(tsx?|jsx?)$/i,        // Next.js pages
      ];

      const structuralFiles = allFiles.filter(f =>
        structuralPatterns.some(p => p.test(f))
      ).slice(0, 10);

      // Read structural files so the AI knows what to modify
      const structuralContents = await readMultipleFiles(structuralFiles, 12_000);

      // Also read referenced files
      const contextParts: string[] = [];
      if (referencedFilesContext) { contextParts.push(referencedFilesContext); }

      // Build structural files context
      let structuralContext = '';
      for (const [filePath, content] of structuralContents) {
        structuralContext += `\n--- EXISTING FILE: ${filePath} ---\n${content}\n`;
      }

      // Auto-scan project context
      const charBudget = this.groqClient.getContextCharBudget();
      const projCtx = await gatherProjectContext({
        maxChars: Math.min(charBudget, 25_000),
        maxFiles: 10,
      });
      if (projCtx.text) { contextParts.push(projCtx.text); }

      // ── 2. Build the integration prompt ──
      const systemPrompt = [
        'You are an expert developer. Your job is to CREATE new files AND MODIFY existing files to fully integrate new functionality into the codebase.',
        '',
        'You have two types of output blocks:',
        '',
        '1. NEW FILES — creates a brand new file:',
        '===NEW_FILE: path/to/new/file.tsx===',
        '...complete file content...',
        '===END_FILE===',
        '',
        '2. MODIFY FILES — applies targeted edits to an existing file:',
        '===MODIFY_FILE: path/to/existing/file.tsx===',
        '<<<SEARCH>>>',
        '...exact lines to find in the existing file...',
        '<<<REPLACE>>>',
        '...replacement lines...',
        '<<<END>>>',
        '===END_FILE===',
        '',
        'CRITICAL RULES:',
        '- Analyze the EXISTING codebase structure, imports, patterns, and conventions FIRST.',
        '- Create new files in the correct directory following the project\'s file organization.',
        '- ALWAYS modify existing files to import and use the new components/modules.',
        '- In MODIFY_FILE blocks, the SEARCH section must contain EXACT lines from the existing file (copy them precisely!).',
        '- You can have MULTIPLE <<<SEARCH>>>...<<<REPLACE>>>...<<<END>>> blocks in one MODIFY_FILE.',
        '- Order: output new files first, then modifications to existing files.',
        '- Match the project\'s code style, naming, and framework patterns exactly.',
        '- Use the same libraries/frameworks already in the project — don\'t introduce new ones unless asked.',
        '- Generate COMPLETE, production-ready code — no stubs or TODOs.',
        '- Include proper imports, types, and exports.',
        '- Do NOT add markdown or explanations outside of file blocks.',
        '- Start output IMMEDIATELY with ===NEW_FILE=== or ===MODIFY_FILE===.',
        '',
        'COMMON INTEGRATION PATTERNS:',
        '- React: Create component → import in parent → render in JSX → add route if needed',
        '- Vue: Create .vue file → import in parent → register component → add route if needed',
        '- Angular: Create component → add to module declarations → add route → update template',
        '- HTML: Create file → add link/script in main HTML → update navigation links',
        '- Next.js: Create page/component → import where needed → update layout/navigation',
        '- Express: Create route/controller → import in app/server → register middleware/route',
      ].join('\n');

      let userPrompt = `Instruction: ${instruction}\n\n`;
      userPrompt += `Project structure:\n${tree}\n\n`;

      if (structuralContext) {
        userPrompt += `KEY EXISTING FILES (study these carefully — you must match their patterns):\n${structuralContext}\n\n`;
      }

      if (contextParts.length > 0) {
        const ctx = contextParts.join('\n\n');
        const budget = Math.floor(charBudget * 0.4);
        userPrompt += `Additional project context:\n${ctx.length > budget ? ctx.slice(0, budget) + '\n/* ...trimmed... */' : ctx}\n\n`;
      }

      userPrompt += 'Now create the new files AND modify existing files to integrate everything. Start immediately with ===NEW_FILE=== or ===MODIFY_FILE===.';

      const messages: GroqMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ];

      this._view?.webview.postMessage({
        type: 'assistantMessage',
        message: '⏳ Generating new files and integration changes…'
      });

      // ── 3. Call AI with continuation support ──
      console.log('🚀 Calling Groq API (create-and-integrate mode)...');
      const rawResponse = await this.groqClient.completeWithContinuation(messages, { maxContinuations: 5 });

      // ── 4. Parse the response ──
      const integration = parseIntegrationResponse(rawResponse);

      if (integration.newFiles.length === 0 && integration.modifications.length === 0) {
        // AI didn't use the structured format — show as chat
        this._view?.webview.postMessage({
          type: 'assistantMessage',
          message: rawResponse,
        });
        return;
      }

      // ── 5. Create new files ──
      const createdFiles: string[] = [];
      const failedFiles: string[] = [];
      let firstUri: vscode.Uri | undefined;

      for (const file of integration.newFiles) {
        try {
          const uri = await createWorkspaceFileQuiet(file.path, file.content);
          if (uri) {
            createdFiles.push(file.path);
            if (!firstUri) { firstUri = uri; }
          } else {
            failedFiles.push(file.path);
          }
        } catch (err: any) {
          console.error(`Failed to create ${file.path}:`, err);
          failedFiles.push(file.path);
        }
      }

      // ── 6. Apply modifications to existing files ──
      const modifiedFiles: string[] = [];
      const failedMods: string[] = [];

      for (const mod of integration.modifications) {
        // Check if file exists before modifying
        const exists = await workspaceFileExists(mod.path);
        if (!exists) {
          console.warn(`Cannot modify ${mod.path}: file does not exist`);
          failedMods.push(`${mod.path} (not found)`);
          continue;
        }

        const result = await modifyWorkspaceFile(mod.path, mod.operations);
        if (result.success) {
          modifiedFiles.push(mod.path);
        } else {
          console.warn(`Failed to modify ${mod.path}: ${result.error}`);
          failedMods.push(`${mod.path} (${result.error})`);
        }
      }

      // ── 7. Open the first created file in the editor ──
      if (firstUri) {
        try {
          const doc = await vscode.workspace.openTextDocument(firstUri);
          await vscode.window.showTextDocument(doc, { preview: false });
        } catch { /* non-fatal */ }
      }

      // ── 8. Build summary ──
      let summary = '';

      if (createdFiles.length > 0) {
        summary += `✅ Created ${createdFiles.length} new file${createdFiles.length !== 1 ? 's' : ''}:\n`;
        for (const f of createdFiles) {
          summary += `  📄 ${f}\n`;
        }
      }

      if (modifiedFiles.length > 0) {
        summary += `\n🔧 Modified ${modifiedFiles.length} existing file${modifiedFiles.length !== 1 ? 's' : ''} for integration:\n`;
        for (const f of modifiedFiles) {
          summary += `  ✏️ ${f}\n`;
        }
      }

      if (failedFiles.length > 0) {
        summary += `\n⚠️ Failed to create: ${failedFiles.join(', ')}\n`;
      }
      if (failedMods.length > 0) {
        summary += `\n⚠️ Failed to modify: ${failedMods.join(', ')}\n`;
      }

      if (!summary) {
        summary = '⚠️ No files were created or modified. The AI response did not contain valid file blocks.';
      }

      this._view?.webview.postMessage({
        type: 'assistantMessage',
        message: summary,
      });

      this.conversationHistory.push({ role: 'assistant', content: summary });

      vscode.window.showInformationMessage(
        `Prompt2Code: Created ${createdFiles.length} file${createdFiles.length !== 1 ? 's' : ''}, modified ${modifiedFiles.length} file${modifiedFiles.length !== 1 ? 's' : ''}`
      );

    } catch (err: any) {
      console.error('❌ Create-and-integrate error:', err);
      this._view?.webview.postMessage({
        type: 'error',
        message: err.message || 'Failed to create and integrate files.'
      });
    } finally {
      this._view?.webview.postMessage({ type: 'loading', isLoading: false });
    }
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
          '⚠️ No API key configured. Set a key for the Llama 4 Scout (Vision) model in the Configure Tools panel.\n\n' +
          'Get your free Groq API key at: https://console.groq.com'
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
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource}; img-src data: https://*.googleusercontent.com ${webview.cspSource};">
<style>
  html, body { height: 100%; min-height: 100vh; margin: 0; padding: 0; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0;
    font-family: var(--vscode-font-family);
    background: var(--vscode-sideBar-background, #1e1e1e);
    color: var(--vscode-foreground, #ccc);
    height: 100vh;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    position: relative;
    overflow: hidden;
  }

  /* ── Sessions Panel ── */
  .sessions-panel { flex-shrink: 0; border-bottom: 1px solid var(--vscode-panel-border); }
  .sessions-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 5px 6px 5px 14px; min-height: 30px;
  }
  .sessions-title {
    font-size: 11px; font-weight: 700; letter-spacing: 0.8px;
    text-transform: uppercase; color: var(--vscode-foreground); opacity: 0.65;
  }
  .sessions-actions { display: flex; align-items: center; gap: 0; }
  .session-icon-btn {
    width: 24px; height: 24px;
    display: flex; align-items: center; justify-content: center;
    background: transparent; border: none;
    color: var(--vscode-foreground); opacity: 0.55;
    cursor: pointer; border-radius: 4px; padding: 0; transition: all 0.15s;
  }
  .session-icon-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.1)); }
  .sessions-list { overflow: hidden; }
  .session-item {
    display: flex; flex-direction: column;
    padding: 5px 8px 5px 14px;
    cursor: pointer; transition: background 0.12s; position: relative;
  }
  .session-item:hover { background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.04)); }
  .session-item.active { background: var(--vscode-list-activeSelectionBackground, rgba(255,255,255,0.07)); }
  .session-item-top { display: flex; align-items: center; gap: 7px; }
  .session-bullet {
    width: 5px; height: 5px; border-radius: 50%;
    background: var(--vscode-foreground); opacity: 0.35; flex-shrink: 0;
  }
  .session-title {
    flex: 1; font-size: 12.5px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    color: var(--vscode-foreground); opacity: 0.9;
  }
  .session-icon { flex-shrink: 0; opacity: 0.35; display: flex; align-items: center; }
  .session-item-bottom {
    display: flex; align-items: center; justify-content: space-between;
    margin-top: 1px; padding-left: 12px;
  }
  .session-status { font-size: 11px; opacity: 0.5; color: var(--vscode-foreground); }
  .session-time { font-size: 11px; opacity: 0.38; color: var(--vscode-foreground); }
  .sessions-footer { padding: 4px 14px 7px; }
  .sessions-more-btn {
    background: none; border: none; padding: 0;
    font-size: 11px; font-weight: 600; letter-spacing: 0.4px; text-transform: uppercase;
    color: var(--vscode-foreground); opacity: 0.55; cursor: pointer; transition: opacity 0.15s;
  }
  .sessions-more-btn:hover { opacity: 1; }

  /* ── Chat area ── */
  .chat {
    flex: 1; overflow-y: auto; padding: 16px;
    display: flex; flex-direction: column; gap: 18px;
  }
  .msg { margin-bottom: 0; max-width: 100%; }
  .msg .msg-label {
    font-size: 11px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.6px; margin-bottom: 5px; display: flex;
    align-items: center; gap: 5px;
    color: var(--vscode-foreground); opacity: 0.5;
  }
  .msg.user .msg-label { color: var(--vscode-symbolIcon-methodForeground); opacity: 0.85; font-weight: 800; }
  .msg.assistant .msg-label { color: var(--vscode-symbolIcon-keywordForeground); opacity: 0.85; font-weight: 800; }
  .bubble {
    color: var(--vscode-foreground); padding: 10px 14px;
    border-radius: 10px; font-size: 13px; line-height: 1.65;
    position: relative; word-wrap: break-word;
    font-weight: 400;
  }
  .msg.user .bubble {
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-panel-border); border-top-right-radius: 2px;
    font-weight: 450;
  }
  .msg.assistant .bubble { background: transparent; padding-left: 0; padding-right: 0; border-radius: 0; }

  /* ── Rich assistant message formatting ── */
  .ai-section-header {
    display: flex; align-items: center; gap: 7px;
    font-size: 12.5px; font-weight: 700; margin: 10px 0 6px;
    color: var(--vscode-foreground);
    letter-spacing: 0.2px;
  }
  .ai-section-header:first-child { margin-top: 0; }
  .ai-section-header .section-icon { font-size: 14px; flex-shrink: 0; }
  .ai-section-header .section-count {
    font-size: 10px; font-weight: 600; padding: 1px 6px;
    border-radius: 8px; margin-left: 2px;
    background: var(--vscode-badge-background, rgba(255,255,255,0.1));
    color: var(--vscode-badge-foreground, #ccc);
  }
  .ai-file-list {
    list-style: none; margin: 0; padding: 0;
    display: flex; flex-direction: column; gap: 3px;
  }
  .ai-file-item {
    display: flex; align-items: center; gap: 8px;
    padding: 5px 10px; border-radius: 6px; font-size: 12.5px;
    font-family: var(--vscode-editor-font-family, 'Cascadia Code', 'Fira Code', 'Consolas', monospace);
    font-weight: 500; letter-spacing: 0.1px;
    color: var(--vscode-foreground); opacity: 0.92;
    background: var(--vscode-editor-background, rgba(255,255,255,0.03));
    border: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.06));
    transition: background 0.15s;
  }
  .ai-file-item:hover { background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.05)); }
  .ai-file-item .file-icon { font-size: 13px; flex-shrink: 0; }
  .ai-file-item .file-path { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ai-file-item.created .file-icon { color: #4ec94e; }
  .ai-file-item.modified .file-icon { color: #ddb04b; }
  .ai-file-item.failed .file-icon { color: #f48771; }
  .ai-warning-list {
    list-style: none; margin: 6px 0 0; padding: 0;
    display: flex; flex-direction: column; gap: 2px;
  }
  .ai-warning-item {
    display: flex; align-items: center; gap: 6px;
    padding: 4px 10px; font-size: 12px; font-weight: 500;
    color: #f48771; opacity: 0.85;
  }
  .ai-status-line {
    display: flex; align-items: center; gap: 7px;
    font-size: 13px; font-weight: 500;
    padding: 4px 0; color: var(--vscode-foreground);
  }
  .ai-status-line .status-icon { font-size: 15px; flex-shrink: 0; }
  .ai-diff-summary {
    margin: 8px 0 0; padding: 8px 12px;
    background: var(--vscode-editor-background, rgba(0,0,0,0.15));
    border-radius: 6px; border-left: 3px solid var(--vscode-symbolIcon-keywordForeground, #c586c0);
    font-size: 12px; line-height: 1.7; font-weight: 400;
    font-family: var(--vscode-editor-font-family, monospace);
  }
  .ai-diff-summary .diff-title { font-weight: 700; font-size: 12.5px; margin-bottom: 4px; display: block; }
  .ai-diff-summary .diff-added { color: #4ec94e; font-weight: 600; }
  .ai-diff-summary .diff-removed { color: #f48771; font-weight: 600; }
  .ai-diff-summary .diff-size { opacity: 0.7; }
  .ai-plain-text { white-space: pre-wrap; font-size: 13px; line-height: 1.65; font-weight: 400; }
  .msg-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
  .msg-actions { display: flex; gap: 4px; opacity: 0; transition: opacity 0.2s ease; }
  .msg:hover .msg-actions { opacity: 1; }
  .msg-actions button {
    background: transparent; border: none; color: var(--vscode-foreground);
    cursor: pointer; padding: 4px; border-radius: 4px;
    display: flex; align-items: center; justify-content: center;
    opacity: 0.6; transition: all 0.2s;
  }
  .msg-actions button:hover { opacity: 1 !important; background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.1)); }
  .msg-actions button svg { width: 14px; height: 14px; }
  .msg-actions button.restore-btn:hover { color: #f48771; }

  /* Checkpoint banner */
  .checkpoint-banner {
    display: flex; align-items: center; justify-content: center; gap: 8px;
    padding: 8px 12px; margin: 8px 0;
    background: var(--vscode-editorWidget-background, #252526);
    border: 1px solid var(--vscode-panel-border); border-radius: 6px; font-size: 12px;
  }
  .checkpoint-banner button { padding: 4px 12px; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; }
  .btn-keep { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .btn-discard { background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #fff); }
  .btn-keep:hover, .btn-discard:hover { opacity: 0.9; }

  /* Loading / typing */
  .loading-bar {
    height: 3px; background: var(--vscode-progressBar-background, #007acc);
    animation: loading-pulse 1.5s ease-in-out infinite; display: none; flex-shrink: 0;
  }
  .loading-bar.active { display: block; }
  @keyframes loading-pulse {
    0%   { width: 10%; margin-left: 0; }
    50%  { width: 60%; margin-left: 20%; }
    100% { width: 10%; margin-left: 90%; }
  }
  .typing { display: none; padding: 8px 16px; font-size: 12px; opacity: 0.7; animation: blink 1s step-end infinite; flex-shrink: 0; }
  .typing.active { display: block; }
  @keyframes blink { 50% { opacity: 0.3; } }

  /* ── Copilot-style chat input ── */
  .chat-input-wrapper {
    padding: 10px 11px 11px; flex-shrink: 0;
    border-top: 1px solid var(--vscode-panel-border);
    background: var(--vscode-sideBar-background);
    position: relative;
  }
  .chat-input-container {
    display: flex; flex-direction: column;
    border-radius: 10px;
    background: var(--vscode-input-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    transition: border-color 0.2s; overflow: visible;
  }
  .chat-input-container:focus-within { border-color: var(--vscode-focusBorder); }

  /* Top row: paperclip + chips + textarea */
  .input-main {
    display: flex; align-items: flex-start;
    padding: 9px 10px 6px; gap: 6px;
  }
  .attach-btn {
    flex-shrink: 0; width: 24px; height: 24px;
    display: flex; align-items: center; justify-content: center;
    background: transparent; border: none; color: var(--vscode-foreground);
    opacity: 0.55; cursor: pointer; border-radius: 5px; padding: 0; margin-top: 1px;
    transition: all 0.15s;
  }
  .attach-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.08)); }
  .input-content { flex: 1; display: flex; flex-direction: column; gap: 5px; min-width: 0; }

  /* Inline file chips (Copilot-style) */
  .inline-chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .inline-chips:empty { display: none; }
  .file-chip {
    display: inline-flex; align-items: center; gap: 3px;
    padding: 2px 6px 2px 4px;
    background: var(--vscode-badge-background, rgba(128,128,128,0.14));
    color: var(--vscode-badge-foreground, var(--vscode-foreground));
    border-radius: 4px; font-size: 11.5px; max-width: 190px;
    border: 1px solid var(--vscode-panel-border); transition: background 0.12s; cursor: default;
  }
  .file-chip:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.22)); }
  .file-chip .chip-plus { opacity: 0.65; font-size: 12px; line-height: 1; font-weight: 600; }
  .file-chip .lang-badge {
    font-size: 9.5px; font-weight: 700; padding: 0 3px; border-radius: 3px;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    flex-shrink: 0; text-transform: uppercase; letter-spacing: 0.3px;
  }
  .file-chip .chip-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .file-chip .chip-remove { cursor: pointer; opacity: 0.4; font-size: 13px; line-height: 1; margin-left: 2px; flex-shrink: 0; }
  .file-chip .chip-remove:hover { opacity: 1; }

  /* Textarea */
  .input-content textarea {
    width: 100%; resize: none; min-height: 20px; max-height: 160px;
    padding: 0; border: none; outline: none; background: transparent;
    color: var(--vscode-foreground); font-family: var(--vscode-font-family);
    font-size: 13px; line-height: 1.5; overflow-y: auto;
  }
  .input-content textarea::placeholder {
    color: var(--vscode-input-placeholderForeground, rgba(128,128,128,0.58));
  }
  /* Image preview bar */
  #imagePreview { overflow: hidden; }
  .image-preview-bar {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 10px; border-top: 1px solid var(--vscode-panel-border); font-size: 12px;
  }
  .image-preview-bar img { height: 36px; border-radius: 4px; object-fit: cover; }
  .img-name { opacity: 0.7; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .img-remove { cursor: pointer; opacity: 0.5; font-size: 16px; }
  .img-remove:hover { opacity: 1; }

  /* Toolbar */
  .chat-input-toolbar {
    display: flex; align-items: center; justify-content: space-between;
    padding: 4px 7px 6px; gap: 2px;
  }
  .toolbar-left { display: flex; align-items: center; gap: 1px; min-width: 0; overflow: hidden; }
  .toolbar-right { display: flex; align-items: center; gap: 3px; flex-shrink: 0; }

  /* Toolbar dropdown buttons (monitor, code-icon, model) */
  .toolbar-dropdown-btn {
    display: flex; align-items: center; gap: 3px;
    padding: 3px 5px; background: transparent; border: none;
    color: var(--vscode-foreground); cursor: pointer; border-radius: 5px;
    opacity: 0.62; font-size: 12px; font-family: var(--vscode-font-family);
    transition: all 0.12s; white-space: nowrap;
  }
  .toolbar-dropdown-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.08)); }
  .toolbar-model-btn {
    display: flex; align-items: center; gap: 3px;
    padding: 3px 5px; background: transparent; border: none;
    color: var(--vscode-foreground); cursor: pointer; border-radius: 5px;
    opacity: 0.72; font-size: 12px; font-family: var(--vscode-font-family);
    transition: all 0.12s; max-width: 140px; white-space: nowrap; overflow: hidden;
  }
  .toolbar-model-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.08)); }
  .toolbar-model-btn > span { overflow: hidden; text-overflow: ellipsis; }
  .dropdown-caret { opacity: 0.6; flex-shrink: 0; }

  .toolbar-btn {
    display: flex; align-items: center; justify-content: center;
    width: 26px; height: 26px; border-radius: 5px; border: none;
    background: transparent; color: var(--vscode-foreground);
    cursor: pointer; opacity: 0.58; padding: 0; transition: all 0.12s;
  }
  .toolbar-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.08)); }

  .toolbar-send-btn {
    width: 28px; height: 28px; min-width: 28px;
    border-radius: 6px; border: none;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    cursor: pointer; display: flex; align-items: center; justify-content: center;
    transition: opacity 0.12s; padding: 0;
  }
  .toolbar-send-btn:hover { opacity: 0.85; }
  .toolbar-send-btn:active { opacity: 0.7; }
  .toolbar-send-btn:disabled { opacity: 0.35; cursor: not-allowed; }

  /* Floating model / mode picker */
  .floating-picker {
    display: none; position: absolute; z-index: 200;
    background: var(--vscode-dropdown-background, var(--vscode-editorWidget-background, #252526));
    border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border));
    border-radius: 6px; overflow: hidden; min-width: 160px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.25);
  }
  .floating-picker.open { display: block; }
  .picker-item {
    display: block; width: 100%; text-align: left;
    padding: 7px 14px; border: none; background: transparent;
    color: var(--vscode-foreground); font-size: 12px;
    font-family: var(--vscode-font-family); cursor: pointer; opacity: 0.85;
    transition: background 0.12s; white-space: nowrap;
  }
  .picker-item:hover { background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.07)); opacity: 1; }
  .picker-item.selected { opacity: 1; font-weight: 600; }
  .picker-item .picker-check {
    display: inline-block; width: 14px; margin-right: 4px;
    font-size: 11px; opacity: 0.8;
  }
  .picker-group-header {
    display: flex; align-items: center; gap: 6px;
    padding: 6px 14px 4px; font-size: 10px; font-weight: 700;
    letter-spacing: 0.7px; text-transform: uppercase;
    color: var(--vscode-foreground); opacity: 0.45;
    pointer-events: none; user-select: none;
  }
  .picker-group-header:first-child { margin-top: 0; }
  .picker-divider {
    height: 1px; margin: 4px 10px;
    background: var(--vscode-panel-border, rgba(255,255,255,0.12));
    opacity: 0.7; pointer-events: none;
  }
  .picker-group-header .key-dot {
    width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;
  }
  .picker-group-header .key-dot.green { background: #4ec94e; }
  .picker-group-header .key-dot.gray { background: #888; }
  .picker-item.no-key { opacity: 0.55; }
  .picker-item.no-key:hover { opacity: 0.8; }
  .picker-item .key-badge {
    display: inline-block; font-size: 9px; padding: 1px 5px;
    border-radius: 3px; margin-left: 6px; vertical-align: middle;
    background: rgba(78,201,78,0.15); color: #4ec94e; font-weight: 600;
  }
  .picker-item.no-key .key-badge {
    background: rgba(136,136,136,0.15); color: #999;
  }

  /* Plan actions */
  .plan-actions { display: flex; gap: 6px; margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--vscode-panel-border); }
  .plan-actions button { padding: 5px 14px; font-size: 12px; border-radius: 4px; cursor: pointer; border: none; }
  .plan-execute-btn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .plan-execute-btn:hover { opacity: 0.9; }
  .plan-copy-btn { background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #fff); }
  .plan-copy-btn:hover { opacity: 0.9; }
  .bubble .diff-summary { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; line-height: 1.6; }

  /* ── Login overlay ── */
  .login-overlay {
    position: fixed; inset: 0; z-index: 999;
    background: var(--vscode-sideBar-background, #1e1e1e);
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 16px; padding: 24px; text-align: center;
  }
  .login-overlay.hidden { display: none !important; }
  .login-overlay .logo { font-size: 36px; margin-bottom: 4px; }
  .login-overlay h2 { margin: 0; font-size: 18px; color: var(--vscode-foreground); }
  .login-overlay p { margin: 0; font-size: 13px; opacity: 0.65; max-width: 260px; line-height: 1.5; }
  .google-btn {
    display: inline-flex; align-items: center; gap: 10px; padding: 10px 24px;
    background: #4285f4; color: #fff; font-size: 14px; font-weight: 600;
    border: none; border-radius: 6px; cursor: pointer;
    transition: opacity 0.15s, transform 0.1s; margin-top: 8px;
  }
  .google-btn:hover { opacity: 0.92; transform: translateY(-1px); }
  .google-btn:active { transform: translateY(0); }
  .google-btn:disabled { opacity: 0.6; cursor: not-allowed; transform: none; }
  .google-btn .g-icon {
    width: 20px; height: 20px; border-radius: 50%; background: #fff;
    display: flex; align-items: center; justify-content: center; font-size: 13px;
  }

  /* ── User bar ── */
  .user-bar {
    display: flex; align-items: center; gap: 8px;
    padding: 5px 10px; font-size: 12px;
    border-bottom: 1px solid var(--vscode-panel-border); flex-shrink: 0;
  }
  .user-bar.hidden { display: none !important; }
  .user-bar img { width: 20px; height: 20px; border-radius: 50%; border: 1px solid var(--vscode-panel-border); }
  .user-bar .user-name { flex: 1; opacity: 0.85; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .user-bar .sign-out-btn {
    background: none; border: none; color: var(--vscode-foreground);
    opacity: 0.5; cursor: pointer; font-size: 11px;
    padding: 2px 6px; border-radius: 3px; transition: all 0.15s;
  }
  .user-bar .sign-out-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.1)); }
  .user-bar .sign-out-btn:disabled { opacity: 0.3; cursor: not-allowed; }

  /* Generic button reset for checkpoint banner etc. */
  button { padding: 8px 14px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; cursor: pointer; border-radius: 4px; }
  button:disabled { opacity: 0.5; }

  @media (max-width: 300px) {
    .toolbar-model-btn { max-width: 80px; }
    .toolbar-dropdown-btn { padding: 3px 3px; }
  }

  /* ── Settings / Configure-Tools Modal ── */
  .settings-backdrop {
    display: none; position: fixed; inset: 0; z-index: 500;
    background: rgba(0,0,0,0.45);
  }
  .settings-backdrop.open { display: block; }
  .settings-modal {
    position: fixed; inset: 0; z-index: 501;
    display: none; flex-direction: column;
    background: var(--vscode-sideBar-background, #1e1e1e);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 0;
    overflow: hidden;
  }
  .settings-modal.open { display: flex; }
  .settings-modal-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 14px; border-bottom: 1px solid var(--vscode-panel-border);
    flex-shrink: 0;
  }
  .settings-modal-header h3 {
    margin: 0; font-size: 13px; font-weight: 700; letter-spacing: 0.2px;
    color: var(--vscode-foreground);
  }
  .settings-close-btn {
    width: 24px; height: 24px; display: flex; align-items: center; justify-content: center;
    background: transparent; border: none; color: var(--vscode-foreground);
    cursor: pointer; opacity: 0.55; border-radius: 4px; padding: 0; font-size: 18px;
    line-height: 1; transition: opacity 0.12s;
  }
  .settings-close-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.1)); }
  .settings-modal-body { flex: 1; overflow-y: auto; padding: 14px; }
  .settings-section-title {
    font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px;
    opacity: 0.5; margin: 0 0 10px; color: var(--vscode-foreground);
  }
  .model-key-row {
    display: flex; flex-direction: column; gap: 5px;
    padding: 10px 0; border-bottom: 1px solid var(--vscode-panel-border);
  }
  .model-key-row:last-child { border-bottom: none; }
  .model-key-top { display: flex; align-items: center; gap: 8px; }
  .model-key-name { flex: 1; font-size: 12.5px; font-weight: 600; color: var(--vscode-foreground); }
  .model-key-ctx {
    font-size: 10px; font-weight: 700; padding: 1px 5px; border-radius: 3px;
    background: var(--vscode-badge-background, rgba(128,128,128,0.15));
    color: var(--vscode-badge-foreground, var(--vscode-foreground));
    opacity: 0.75; text-transform: uppercase; letter-spacing: 0.3px;
  }
  .model-key-status {
    font-size: 11px; font-weight: 600; flex-shrink: 0;
  }
  .model-key-status.set   { color: #3dc965; }
  .model-key-status.unset { color: var(--vscode-foreground); opacity: 0.38; }
  .model-key-input-row { display: flex; gap: 5px; }
  .model-key-eye-btn {
    padding: 5px 8px; border-radius: 5px; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    background: var(--vscode-input-background); color: var(--vscode-foreground); cursor: pointer;
    flex-shrink: 0; opacity: 0.6; transition: opacity 0.12s; display: flex; align-items: center; justify-content: center;
  }
  .model-key-eye-btn:hover { opacity: 1; }
  .model-key-input {
    flex: 1; padding: 5px 8px;
    background: var(--vscode-input-background); color: var(--vscode-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: 5px; font-size: 12px; font-family: var(--vscode-font-family);
    outline: none; min-width: 0;
  }
  .model-key-input:focus { border-color: var(--vscode-focusBorder); }
  .model-key-save-btn {
    padding: 5px 12px; border-radius: 5px; border: none; cursor: pointer; font-size: 12px;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    transition: opacity 0.12s; flex-shrink: 0; font-family: var(--vscode-font-family);
  }
  .model-key-save-btn:hover { opacity: 0.85; }
  .model-key-del-btn {
    padding: 5px 8px; border-radius: 5px; border: none; cursor: pointer; font-size: 12px;
    background: transparent; color: var(--vscode-foreground); opacity: 0.45;
    transition: opacity 0.12s; flex-shrink: 0; font-family: var(--vscode-font-family);
    display: none;
  }
  .model-key-del-btn.visible { display: block; }
  .model-key-del-btn:hover { opacity: 1; color: #f48771; }
  .provider-section-header {
    font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
    color: var(--vscode-foreground); opacity: 0.45;
    padding: 12px 0 4px 0; margin-bottom: 2px;
    border-top: 1px solid var(--vscode-panel-border);
  }
  .provider-section-header:first-child { border-top: none; padding-top: 2px; }
  .settings-active-badge {
    font-size: 10px; padding: 1px 6px; border-radius: 3px;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    font-weight: 600; margin-left: 4px;
  }
  .model-key-set-active-btn {
    padding: 3px 8px; font-size: 11px; border-radius: 4px; border: none; cursor: pointer;
    background: transparent; color: var(--vscode-foreground); opacity: 0.5;
    font-family: var(--vscode-font-family); transition: all 0.12s; flex-shrink: 0;
  }
  .model-key-set-active-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.08)); }
  .settings-msg {
    font-size: 11.5px; padding: 4px 0; opacity: 0.7; min-height: 18px; color: var(--vscode-foreground);
  }
  .settings-msg.ok  { color: #3dc965; opacity: 1; }
  .settings-msg.err { color: #f48771; opacity: 1; }
</style>
</head>

<body>
  <!-- LOGIN OVERLAY -->
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
    <button class="sign-out-btn" id="signOutBtn">Sign out</button>
  </div>

  <!-- SESSIONS PANEL -->
  <div class="sessions-panel" id="sessionsPanel">
    <div class="sessions-header">
      <span class="sessions-title">SESSIONS</span>
      <div class="sessions-actions">
        <!-- New chat: compose / pencil-plus icon -->
        <button class="session-icon-btn" id="newChat" title="New chat">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M13.23 1h-1.46L3.52 9.25l-.16.22L1 13.59 2.41 15l4.12-2.36.22-.16L15 4.23V2.77L13.23 1zM2.41 13.59l1.51-3 1.45 1.45-2.96 1.55zm3.83-2.06L4.47 9.76l8-8 1.77 1.77-8 8z"/>
          </svg>
        </button>
      
      </div>
    </div>
    <div class="sessions-list" id="sessionsList"></div>
    <div class="sessions-footer" id="sessionsFooter" style="display:none">
      <button class="sessions-more-btn" id="sessionsMoreBtn"></button>
    </div>
  </div>

  <div class="loading-bar" id="loadingBar"></div>
  <div class="chat" id="chat"></div>
  <div class="typing" id="typingIndicator">⏳ Working… generating code in the editor</div>

  <!-- Copilot-style chat input -->
  <div class="chat-input-wrapper">
    <div class="chat-input-container">
      <!-- Top: paperclip + inline chips + textarea -->
      <div class="input-main">
        <!-- Attach / upload files: paperclip -->
        <button class="attach-btn" id="addContextBtn" title="Attach files or upload">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
            <path d="M21.59 11.59l-9.17 9.17a6 6 0 0 1-8.49-8.49l8.18-8.18a4 4 0 0 1 5.66 5.66L9.6 17.92a2 2 0 0 1-2.83-2.83l7.07-7.07-1.41-1.41-7.07 7.07a4 4 0 0 0 5.65 5.65l8.18-8.18a6 6 0 0 0-8.49-8.49L2.52 11.1a8 8 0 0 0 11.31 11.31l9.17-9.17-1.41-1.41z"/>
          </svg>
        </button>
        <div class="input-content">
          <div class="inline-chips" id="attachedFiles"></div>
          <textarea id="input" rows="1" placeholder="Describe what to build next"></textarea>
        </div>
      </div>
      <div id="imagePreview" style="display:none"></div>
      <!-- Toolbar -->
      <div class="chat-input-toolbar">
        <div class="toolbar-left">
          <!-- Upload file from local system -->
          <button class="toolbar-btn" id="uploadLocalFileBtn" title="Upload file from your computer">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M7.5 1.5a.5.5 0 0 1 1 0V8h2.793l-3.293-3.293a.5.5 0 0 1 .707-.707l4 4a.5.5 0 0 1 0 .707l-4 4a.5.5 0 0 1-.707-.707L10.293 9H8.5v4.5a.5.5 0 0 1-1 0V9H5.707l3.293-3.293V1.5z" style="display:none"/>
              <path d="M8 1l3.5 4H9.5v5h-3V5H4.5L8 1zM3 12h10v1H3v-1z"/>
            </svg>
          </button>
          <input type="file" id="localFileInput" multiple style="display:none" />
          <!-- Mode picker: same style as model button -->
          <button class="toolbar-model-btn" id="modeMenuBtn" title="Chat mode (Ask / Agent / Plan)">
            <span id="modeLabel">Agent</span>
            <svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor" class="dropdown-caret">
              <path d="M8 10.5L3 5.5h10L8 10.5z"/>
            </svg>
          </button>
          <!-- Model selector -->
          <button class="toolbar-model-btn" id="modelMenuBtn" title="Select model">
            <span id="modelLabel">Loading…</span>
            <svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor" class="dropdown-caret">
              <path d="M8 10.5L3 5.5h10L8 10.5z"/>
            </svg>
          </button>
        </div>
        <div class="toolbar-right">
          <!-- Tools / configure: sliders tune icon -->
          <button class="toolbar-btn" id="toolsBtn" title="Configure tools">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M3.5 2a.5.5 0 0 1 .5.5V5h1.5a.5.5 0 0 1 0 1H4v7.5a.5.5 0 0 1-1 0V6H1.5a.5.5 0 0 1 0-1H3V2.5a.5.5 0 0 1 .5-.5zm5 0a.5.5 0 0 1 .5.5V7h1.5a.5.5 0 0 1 0 1H9v5.5a.5.5 0 0 1-1 0V8H6.5a.5.5 0 0 1 0-1H8V2.5a.5.5 0 0 1 .5-.5zm5 0a.5.5 0 0 1 .5.5v2h1.5a.5.5 0 0 1 0 1H14v8.5a.5.5 0 0 1-1 0V5.5h-1.5a.5.5 0 0 1 0-1H13V2.5a.5.5 0 0 1 .5-.5z"/>
            </svg>
          </button>
          <!-- Send: paper-plane / send arrow -->
          <button id="send" class="toolbar-send-btn" title="Send message (Enter)" aria-label="Send">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M1 1.5l14 6.5-14 6.5.92-6.5L1 1.5zm1.38 1.34L2.62 7H9V6L2.38 2.84zm.24 7.82L9 9v-1l-6.38-.84L2.62 11.16z"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
    <input type="file" id="imageInput" accept="image/png,image/jpeg,image/gif,image/webp" style="display:none" />
    <!-- Hidden selects for backward-compat -->
    <select id="modeSelect" style="display:none">
      <option value="ask">Ask</option>
      <option value="agent" selected>Agent</option>
      <option value="plan">Plan</option>
    </select>
    <select id="modelSelect" style="display:none"><option>Loading…</option></select>
    <!-- Floating pickers -->
    <div class="floating-picker" id="modePicker">
      <button class="picker-item" data-mode="ask"><span class="picker-check"></span>Ask</button>
      <button class="picker-item selected" data-mode="agent"><span class="picker-check">✓</span>Agent</button>
      <button class="picker-item" data-mode="plan"><span class="picker-check"></span>Plan</button>
    </div>
    <style>
      #modePicker { min-width: 120px; }
    </style>
    <div class="floating-picker" id="modelPicker"></div>
  </div>

  <!-- Settings / Configure-tools modal -->
  <div class="settings-backdrop" id="settingsBackdrop"></div>
  <div class="settings-modal" id="settingsModal">
    <div class="settings-modal-header">
      <h3>
        <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" style="vertical-align:middle;margin-right:6px;opacity:0.75">
          <path d="M3.5 2a.5.5 0 0 1 .5.5V5h1.5a.5.5 0 0 1 0 1H4v7.5a.5.5 0 0 1-1 0V6H1.5a.5.5 0 0 1 0-1H3V2.5a.5.5 0 0 1 .5-.5zm5 0a.5.5 0 0 1 .5.5V7h1.5a.5.5 0 0 1 0 1H9v5.5a.5.5 0 0 1-1 0V8H6.5a.5.5 0 0 1 0-1H8V2.5a.5.5 0 0 1 .5-.5zm5 0a.5.5 0 0 1 .5.5v2h1.5a.5.5 0 0 1 0 1H14v8.5a.5.5 0 0 1-1 0V5.5h-1.5a.5.5 0 0 1 0-1H13V2.5a.5.5 0 0 1 .5-.5z"/>
        </svg>Configure Tools
      </h3>
      <button class="settings-close-btn" id="settingsCloseBtn" title="Close">&#xd7;</button>
    </div>
    <div class="settings-modal-body">
      <p class="settings-section-title">API Keys &amp; Models</p>
      <div class="settings-msg" id="settingsMsg"></div>
      <div id="modelKeyList">
        <div style="padding:20px;text-align:center;opacity:0.45;font-size:12px;">Loading…</div>
      </div>
    </div>
  </div>

<script nonce="${nonce}">
  console.log('🚀 Prompt2Code webview script loaded');
  
  const vscode = acquireVsCodeApi();

  // ══════════════════════════════════════════════
  // REGISTER MESSAGE LISTENER FIRST — before anything else
  // so we never miss messages from the extension
  // ══════════════════════════════════════════════
  const _pendingMessages = [];
  window.addEventListener('message', event => {
    const msg = event.data;
    if (typeof _handleMessage === 'function') {
      _handleMessage(msg);
    } else {
      _pendingMessages.push(msg);
    }
  });

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
  const modeSelect = document.getElementById('modeSelect');

  // ── Auth elements ──
  const loginOverlay = document.getElementById('loginOverlay');
  const googleSignInBtn = document.getElementById('googleSignInBtn');
  const userBar = document.getElementById('userBar');
  const userAvatar = document.getElementById('userAvatar');
  const userName = document.getElementById('userName');
  const signOutBtn = document.getElementById('signOutBtn');

  // ── Error message display for login overlay ──
  function showLoginError(message) {
    const overlay = document.getElementById('loginOverlay');
    if (!overlay) return;
    let err = document.getElementById('loginErrorMsg');
    if (!err) {
      err = document.createElement('div');
      err.id = 'loginErrorMsg';
      err.style.color = '#f48771';
      err.style.fontSize = '13px';
      err.style.marginTop = '12px';
      overlay.appendChild(err);
    }
    err.textContent = message;
    err.style.display = 'block';
  }

  // Current auth state
  let isSignedIn = false;
  let currentUser = null;

  // Sign in button handler
  if (googleSignInBtn) {
    googleSignInBtn.addEventListener('click', () => {
      console.log('🔐 Sign in button clicked');
      googleSignInBtn.disabled = true;
      googleSignInBtn.textContent = 'Opening browser…';
      
      vscode.postMessage({ type: 'googleSignIn' });
      
      // After sign-in completes, request fresh auth state
      setTimeout(() => {
        console.log('🔄 Requesting auth state refresh');
        vscode.postMessage({ type: 'requestAuthState' });
      }, 2000);
      
      // Re-enable after timeout in case of error
      setTimeout(() => {
        if (!isSignedIn) {
          googleSignInBtn.disabled = false;
          googleSignInBtn.innerHTML = '<span class="g-icon">G</span> Sign in with Google';
        }
      }, 10000);
    });
    console.log('✅ Sign in button handler attached');
  } else {
    console.error('❌ googleSignInBtn element not found in DOM!');
  }

  // Sign out button handler
  if (signOutBtn) {
    signOutBtn.addEventListener('click', () => {
      console.log(' Sign out button clicked');
      signOutBtn.disabled = true;
      signOutBtn.textContent = '⏳ Signing out...';
      
      vscode.postMessage({ type: 'googleSignOut' });
      
      setTimeout(() => {
        signOutBtn.disabled = false;
        signOutBtn.textContent = ' Sign out';
      }, 3000);
    });
  }

  // Apply auth state to UI
  function applyAuthState(signedIn, user) {
    console.log('📋 applyAuthState called:', { 
      signedIn, 
      user, 
      loginOverlayExists: !!loginOverlay,
      userBarExists: !!userBar 
    });
    
    isSignedIn = signedIn;
    currentUser = user;

    if (signedIn && user) {
      console.log('✅ User is signed in:', user.email || user.name);
      
      // Hide login overlay - use multiple methods to ensure it works
      if (loginOverlay) {
        console.log('  - Hiding login overlay');
        loginOverlay.style.display = 'none';
        loginOverlay.classList.add('hidden');
        console.log('  - Login overlay display:', window.getComputedStyle(loginOverlay).display);
      } else {
        console.error('❌ loginOverlay element not found!');
      }
      
      // Show user bar - use multiple methods to ensure it works
      if (userBar) {
        console.log('  - Showing user bar');
        userBar.style.display = 'flex';
        userBar.classList.remove('hidden');
        console.log('  - User bar display:', window.getComputedStyle(userBar).display);
      } else {
        console.error('❌ userBar element not found!');
      }
      
      // Set user info
      if (userAvatar && user.picture) {
        console.log('  - Setting avatar:', user.picture);
        userAvatar.src = user.picture;
        userAvatar.style.display = 'block';
      }
      if (userName) {
        const displayName = user.name || user.email || 'User';
        console.log('  - Setting user name:', displayName);
        userName.textContent = displayName;
      }
      
      // Reset sign-in button
      if (googleSignInBtn) {
        googleSignInBtn.disabled = false;
        googleSignInBtn.innerHTML = '<span class="g-icon">G</span> Sign in with Google';
      }
      
      console.log('✅ Auth UI update complete - user should be logged in');
      
    } else {
      console.log('❌ User is NOT signed in');
      
      // Show login overlay
      if (loginOverlay) {
        console.log('  - Showing login overlay');
        loginOverlay.style.display = 'flex';
        loginOverlay.classList.remove('hidden');
      }
      
      // Hide user bar
      if (userBar) {
        console.log('  - Hiding user bar');
        userBar.style.display = 'none';
        userBar.classList.add('hidden');
      }
      
      console.log('✅ Auth UI update complete - showing login screen');
    }
  }

  let loading = false;
  let availableModels = [];
  let currentMode = 'agent';

  // ── Session management ──
  let sessions = [];
  let activeSessionId = null;
  let _sessionIdCounter = 0;
  const SESSIONS_VISIBLE = 3;
  const sessionsListEl = document.getElementById('sessionsList');
  const sessionsFooterEl = document.getElementById('sessionsFooter');
  const sessionsMoreBtn = document.getElementById('sessionsMoreBtn');

  function _fmtTimeAgo(ts) {
    const diff = Date.now() - ts;
    const s = Math.floor(diff / 1000);
    if (s < 60) return 'just now';
    const m = Math.floor(s / 60);
    if (m < 60) return m + ' min ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + ' hr ago';
    const d = Math.floor(h / 24);
    if (d < 7) return d + (d === 1 ? ' day ago' : ' days ago');
    const w = Math.floor(d / 7);
    return w + (w === 1 ? ' wk ago' : ' wks ago');
  }

  function renderSessions() {
    if (!sessionsListEl) return;
    const visible = sessions.slice(0, SESSIONS_VISIBLE);
    const hidden = sessions.length - visible.length;
    sessionsListEl.innerHTML = '';
    for (const s of visible) {
      const item = document.createElement('div');
      item.className = 'session-item' + (s.id === activeSessionId ? ' active' : '');
      item.dataset.sid = s.id;
      const title = s.title.length > 50 ? s.title.slice(0, 50) + '\u2026' : s.title;
      item.innerHTML =
        '<div class="session-item-top">' +
          '<div class="session-bullet"></div>' +
          '<span class="session-title" title="' + s.title + '">' + title + '</span>' +
          '<span class="session-icon"><svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M1 3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H9v1h1v1H6v-1h1v-1H2a1 1 0 0 1-1-1V3zm13 7V3H2v7h12z"/></svg></span>' +
        '</div>' +
        '<div class="session-item-bottom">' +
          '<span class="session-status">' + (s.status || 'In progress') + '</span>' +
          '<span class="session-time">' + _fmtTimeAgo(s.ts) + '</span>' +
        '</div>';
      sessionsListEl.appendChild(item);
    }
    if (hidden > 0 && sessionsFooterEl && sessionsMoreBtn) {
      sessionsFooterEl.style.display = '';
      sessionsMoreBtn.textContent = 'MORE (' + hidden + ')';
    } else if (sessionsFooterEl) {
      sessionsFooterEl.style.display = 'none';
    }
  }

  function createSession(title) {
    const s = { id: ++_sessionIdCounter, title: title || 'New chat', status: 'In progress', ts: Date.now() };
    sessions.unshift(s);
    activeSessionId = s.id;
    renderSessions();
    return s;
  }

  function completeActiveSession(elapsed) {
    const s = sessions.find(x => x.id === activeSessionId);
    if (s && s.status === 'In progress') {
      s.status = elapsed ? 'Completed in ' + elapsed + '.' : 'Completed';
      renderSessions();
    }
  }

  // Track session elapsed time
  let _sessionStartTs = 0;

  // ── Image attachment state ──
  let pendingImage = null; // { base64, mimeType, fileName }

  if (addImage) addImage.onclick = () => { if (imageInput) imageInput.click(); };

  if (imageInput) imageInput.addEventListener('change', (e) => {
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

  // ── Mode selector (dropdown) ──
  modeSelect.addEventListener('change', () => {
    const mode = modeSelect.value;
    if (mode === currentMode) return;
    currentMode = mode;
    vscode.postMessage({ type: 'setMode', mode });

    // Update placeholder
    const placeholders = {
      ask: 'Ask a question about your code',
      agent: 'Describe what to build next',
      plan: 'Describe what you want to build'
    };
    input.placeholder = placeholders[mode] || placeholders.agent;
  });

  // ── Tracked / attached files state ──
  // { relPath, fileName, languageId, source: 'active'|'manual' }
  let trackedFiles = [];

  function renderChips() {
    if (!attachedFilesEl) return;
    attachedFilesEl.innerHTML = '';
    for (const f of trackedFiles) {
      const chip = document.createElement('span');
      chip.className = 'file-chip';
      const lang = (f.languageId || '').toUpperCase().slice(0, 4);
      chip.innerHTML =
        '<span class="chip-plus">+</span>' +
        (lang ? '<span class="lang-badge">' + lang + '</span>' : '') +
        '<span class="chip-name" title="' + f.relPath + '">' + f.fileName + '</span>' +
        '<span class="chip-remove" title="Remove">\u00d7</span>';
      chip.querySelector('.chip-remove').onclick = () => {
        trackedFiles = trackedFiles.filter(t => t.relPath !== f.relPath);
        renderChips();
        vscode.postMessage({ type: 'removeTrackedFile', relPath: f.relPath });
      };
      attachedFilesEl.appendChild(chip);
    }
  }

  if (send) send.onclick = () => {
    if (loading) return;

    // If an image is attached, send as image message
    if (pendingImage) {
      const msg = input.value.trim() || 'Recreate this UI exactly as shown in the image';
      if (!activeSessionId || chat.children.length === 0) {
        createSession(msg);
        _sessionStartTs = Date.now();
      }
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
    const msgText = input.value.trim();
    // Start a new session on first message in empty chat
    if (!activeSessionId || chat.children.length === 0) {
      createSession(msgText);
      _sessionStartTs = Date.now();
    }
    const files = trackedFiles.filter(f => !f.localContent).map(f => f.relPath);
    const localFiles = trackedFiles.filter(f => f.localContent).map(f => ({ name: f.fileName, content: f.localContent }));
    vscode.postMessage({ type: 'sendMessage', message: msgText, attachedFiles: files, localFiles });
    // Clear local-uploaded chips after send
    trackedFiles = trackedFiles.filter(f => f.source !== 'manual' || !f.localContent);
    renderChips();
    input.value = '';
  };

  if (newChat) newChat.onclick = () => {
    completeActiveSession();
    activeSessionId = null;
    vscode.postMessage({ type: 'newChat' });
  };

  if (close) close.onclick = () => {
    vscode.postMessage({ type: 'closePanel' });
  };

  if (addContextBtn) addContextBtn.onclick = () => {
    vscode.postMessage({ type: 'pickFile' });
  };

  if (addFile) addFile.onclick = () => {
    vscode.postMessage({ type: 'pickFile' });
  };

  // Model selector (hidden native select, kept for compat)
  if (modelSelect) modelSelect.onchange = () => {
    const selectedId = modelSelect.value;
    vscode.postMessage({ type: 'selectModel', modelId: selectedId });
  };

  // ── Floating picker helpers ──
  const modePicker  = document.getElementById('modePicker');
  const modelPicker = document.getElementById('modelPicker');

  function openPicker(picker, anchorBtn) {
    if (!picker) return;
    // Close any open pickers first
    document.querySelectorAll('.floating-picker.open').forEach(p => p.classList.remove('open'));
    // Position below / near anchor
    const wrapper = document.querySelector('.chat-input-wrapper');
    const wRect = wrapper ? wrapper.getBoundingClientRect() : { bottom: 0, left: 0 };
    const bRect = anchorBtn.getBoundingClientRect();
    picker.style.bottom = (window.innerHeight - bRect.top + 4) + 'px';
    picker.style.left = Math.max(0, bRect.left - (wrapper ? wrapper.getBoundingClientRect().left : 0)) + 'px';
    picker.classList.add('open');
    // Close on outside click
    const close = (e) => {
      if (!picker.contains(e.target) && e.target !== anchorBtn) {
        picker.classList.remove('open');
        document.removeEventListener('mousedown', close, true);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', close, true), 50);
  }

  // Mode menu button → floating picker
  const modeMenuBtn = document.getElementById('modeMenuBtn');
  if (modeMenuBtn && modePicker) {
    modeMenuBtn.onclick = () => openPicker(modePicker, modeMenuBtn);
    modePicker.querySelectorAll('.picker-item').forEach(btn => {
      btn.onclick = () => {
        const mode = btn.dataset.mode;
        if (!mode || mode === currentMode) { modePicker.classList.remove('open'); return; }
        currentMode = mode;
        if (modeSelect) modeSelect.value = mode;
        vscode.postMessage({ type: 'setMode', mode });
        const placeholders = { ask: 'Ask a question about your code', agent: 'Describe what to build next', plan: 'Describe what you want to build' };
        if (input) input.placeholder = placeholders[mode] || placeholders.agent;
        // Update checkmarks
        // Sync label and checkmarks
        const modeLabelEl = document.getElementById('modeLabel');
        if (modeLabelEl) modeLabelEl.textContent = btn.textContent.replace('\u2713', '').trim();
        modePicker.querySelectorAll('.picker-item').forEach(b => {
          b.classList.toggle('selected', b.dataset.mode === mode);
          b.querySelector('.picker-check').textContent = b.dataset.mode === mode ? '\u2713' : '';
        });
        modePicker.classList.remove('open');
      };
    });
  }

  // Model menu button → floating picker
  const modelMenuBtn = document.getElementById('modelMenuBtn');
  if (modelMenuBtn && modelPicker) {
    modelMenuBtn.onclick = () => openPicker(modelPicker, modelMenuBtn);
  }

  // Upload local file button → opens system file picker
  const uploadLocalFileBtn = document.getElementById('uploadLocalFileBtn');
  const localFileInput = document.getElementById('localFileInput');
  if (uploadLocalFileBtn && localFileInput) {
    uploadLocalFileBtn.onclick = () => localFileInput.click();
    localFileInput.addEventListener('change', (e) => {
      const files = Array.from(e.target.files || []);
      if (!files.length) return;
      for (const file of files) {
        const reader = new FileReader();
        reader.onload = () => {
          const content = reader.result;
          // Add as a tracked chip and send content as context
          const alreadyTracked = trackedFiles.find(t => t.fileName === file.name);
          if (!alreadyTracked) {
            trackedFiles.push({ relPath: file.name, fileName: file.name, languageId: '', source: 'manual', localContent: content });
            renderChips();
          }
        };
        reader.readAsText(file);
      }
      localFileInput.value = '';
    });
  }

  // Auto-grow textarea (Copilot-like)
  if (input) {
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 140) + 'px';
    });

    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (send) send.click();
        input.style.height = 'auto';
      }
    });
  }

  // ═══════════════════════════════════════════════
  // Now define the real message handler and flush
  // any messages that arrived before we were ready
  // ═══════════════════════════════════════════════
  function _handleMessage(msg) {
    console.log('📨 Webview processing message:', msg.type);

    if (msg.type === 'authState') { 
      console.log('🔐 Processing authState message:', { 
        signedIn: msg.signedIn, 
        user: msg.user ? msg.user.email : 'null' 
      });
      applyAuthState(msg.signedIn, msg.user); 
      return;
    }
    if (msg.type === 'userMessage') add('You', msg.message, 'user');
    if (msg.type === 'assistantMessage') {
      add('AI', msg.message, 'assistant');
      // Mark session complete with elapsed time
      if (_sessionStartTs > 0) {
        const elapsed = Math.round((Date.now() - _sessionStartTs) / 1000);
        completeActiveSession(elapsed + 's');
        _sessionStartTs = 0;
      } else {
        completeActiveSession();
      }
    }
    if (msg.type === 'linkCheckpoint') {
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
      if (send) send.disabled = loading;
      if (input) input.disabled = loading;
      if (loadingBar) loadingBar.className = msg.isLoading ? 'loading-bar active' : 'loading-bar';
      if (typingIndicator) typingIndicator.className = msg.isLoading ? 'typing active' : 'typing';
    }
    if (msg.type === 'clearMessages' && chat) chat.innerHTML = '';
    if (msg.type === 'error') {
      showLoginError(msg.message);
      if (isSignedIn) add('Error', msg.message, 'assistant');
    }
    if (msg.type === 'modeChanged') {
      currentMode = msg.mode;
      if (modeSelect) modeSelect.value = msg.mode;
      // Sync mode label button text
      const modeLabelEl = document.getElementById('modeLabel');
      if (modeLabelEl) {
        const labels = { ask: 'Ask', agent: 'Agent', plan: 'Plan' };
        modeLabelEl.textContent = labels[msg.mode] || msg.mode;
      }
      // Sync mode picker checkmarks
      if (modePicker) {
        modePicker.querySelectorAll('.picker-item').forEach(b => {
          b.classList.toggle('selected', b.dataset.mode === msg.mode);
          b.querySelector('.picker-check').textContent = b.dataset.mode === msg.mode ? '\u2713' : '';
        });
      }
    }
    if (msg.type === 'planMessage') {
      addPlan(msg.message, msg.originalRequest);
    }
    if (msg.type === 'checkpoint') addCheckpointBanner(msg.id);
    if (msg.type === 'insertFileRef') {
      const refs = msg.ref.split(/\\s+/).filter(Boolean);
      for (const r of refs) {
        const cleaned = r.replace(/^@file\\s*/i, '');
        if (cleaned && !trackedFiles.find(t => t.relPath === cleaned)) {
          const parts = cleaned.split('/');
          trackedFiles.push({ relPath: cleaned, fileName: parts[parts.length - 1], languageId: '', source: 'manual' });
        }
      }
      renderChips();
      if (input) input.focus();
    }
    if (msg.type === 'activeFile') {
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
      if (modelSelect) {
        modelSelect.innerHTML = '';
        // Group by key status in <optgroup>
        const withKey = availableModels.filter(m => m.hasKey);
        const noKey = availableModels.filter(m => !m.hasKey);
        if (withKey.length > 0) {
          const grp = document.createElement('optgroup');
          grp.label = '\u2705 API Key Set';
          for (const m of withKey) {
            const opt = document.createElement('option');
            opt.value = m.id;
            opt.textContent = m.label + ' (' + m.ctx + ')';
            if (m.id === msg.activeModel) { opt.selected = true; }
            grp.appendChild(opt);
          }
          modelSelect.appendChild(grp);
        }
        if (noKey.length > 0) {
          const grp = document.createElement('optgroup');
          grp.label = '\uD83D\uDD12 No API Key';
          for (const m of noKey) {
            const opt = document.createElement('option');
            opt.value = m.id;
            opt.textContent = m.label + ' (' + m.ctx + ')';
            if (m.id === msg.activeModel) { opt.selected = true; }
            grp.appendChild(opt);
          }
          modelSelect.appendChild(grp);
        }
      }
      // Update model label button
      const modelLabelEl = document.getElementById('modelLabel');
      if (modelLabelEl) {
        const active = availableModels.find(m => m.id === msg.activeModel);
        if (active) modelLabelEl.textContent = active.label;
      }
      // Populate model picker — grouped by API key status
      if (modelPicker) {
        modelPicker.innerHTML = '';
        const withKey = availableModels.filter(m => m.hasKey);
        const noKey = availableModels.filter(m => !m.hasKey);
        if (withKey.length > 0) {
          const hdr = document.createElement('div');
          hdr.className = 'picker-group-header';
          hdr.innerHTML = '<span class="key-dot green"></span> API Key Set';
          modelPicker.appendChild(hdr);
          for (const m of withKey) {
            const btn = document.createElement('button');
            btn.className = 'picker-item' + (m.id === msg.activeModel ? ' selected' : '');
            btn.setAttribute('data-model-id', m.id);
            btn.innerHTML =
              '<span class="picker-check">' + (m.id === msg.activeModel ? '\u2713' : '') + '</span>' +
              m.label + ' <span style="opacity:0.45;font-size:10px">(' + m.ctx + ')</span>';
            btn.onclick = () => {
              modelPicker.classList.remove('open');
              vscode.postMessage({ type: 'selectModel', modelId: m.id });
            };
            modelPicker.appendChild(btn);
          }
        }
        if (noKey.length > 0) {
          if (withKey.length > 0) {
            const divider = document.createElement('div');
            divider.className = 'picker-divider';
            modelPicker.appendChild(divider);
          }
          const hdr = document.createElement('div');
          hdr.className = 'picker-group-header';
          hdr.innerHTML = '<span class="key-dot gray"></span> No API Key';
          modelPicker.appendChild(hdr);
          for (const m of noKey) {
            const btn = document.createElement('button');
            btn.className = 'picker-item no-key' + (m.id === msg.activeModel ? ' selected' : '');
            btn.setAttribute('data-model-id', m.id);
            btn.innerHTML =
              '<span class="picker-check">' + (m.id === msg.activeModel ? '\u2713' : '') + '</span>' +
              m.label + ' <span style="opacity:0.45;font-size:10px">(' + m.ctx + ')</span>';
            btn.onclick = () => {
              modelPicker.classList.remove('open');
              vscode.postMessage({ type: 'selectModel', modelId: m.id });
            };
            modelPicker.appendChild(btn);
          }
        }
      }
    }
    if (msg.type === 'modelChangeResult') {
      if (msg.success) {
        if (modelSelect) modelSelect.value = msg.activeModel;
        const modelLabelEl = document.getElementById('modelLabel');
        if (modelLabelEl) {
          const active = availableModels.find(m => m.id === msg.activeModel);
          if (active) {
            modelLabelEl.textContent = active.label;
            // When a key is now set for this model, update hasKey flag
            active.hasKey = true;
          }
        }
        // Update picker checkmarks using data-model-id attribute
        if (modelPicker) {
          modelPicker.querySelectorAll('.picker-item').forEach(btn => {
            const id = btn.getAttribute('data-model-id');
            const isActive = id === msg.activeModel;
            btn.classList.toggle('selected', isActive);
            const check = btn.querySelector('.picker-check');
            if (check) check.textContent = isActive ? '\u2713' : '';
          });
        }
      } else {
        const cur = availableModels.find(m => m.id === msg.activeModel);
        if (cur && modelSelect) { modelSelect.value = cur.id; }
        if (msg.error) {
          add('Error', msg.error, 'assistant');
        }
      }
    }
    if (msg.type === 'apiKeysState') {
      renderModelKeyList(msg.keys, msg.activeModel);
    }
    if (msg.type === 'apiKeyResult') {
      showSettingsMsg(msg.success ? '✓ ' + msg.message : '✕ ' + msg.message, msg.success ? 'ok' : 'err');
      if (msg.success) {
        // Refresh the list to show updated key status
        vscode.postMessage({ type: 'requestApiKeys' });
      }
    }
  }

  // Process any messages that arrived before this point
  console.log('📬 Processing', _pendingMessages.length, 'queued messages');
  for (const msg of _pendingMessages) {
    _handleMessage(msg);
  }
  _pendingMessages.length = 0;

  // Tell the extension we're ready to receive messages
  console.log('✅ Webview ready, notifying extension');
  vscode.postMessage({ type: 'webviewReady' });

  // ── Settings modal ──────────────────────────────────────────
  const settingsModal    = document.getElementById('settingsModal');
  const settingsBackdrop = document.getElementById('settingsBackdrop');
  const settingsCloseBtn = document.getElementById('settingsCloseBtn');
  const settingsMsg      = document.getElementById('settingsMsg');
  const modelKeyList     = document.getElementById('modelKeyList');
  const toolsBtn         = document.getElementById('toolsBtn');

  function openSettings() {
    if (settingsModal)    settingsModal.classList.add('open');
    if (settingsBackdrop) settingsBackdrop.classList.add('open');
    // Ask extension for current key state
    vscode.postMessage({ type: 'requestApiKeys' });
    if (settingsMsg) { settingsMsg.textContent = ''; settingsMsg.className = 'settings-msg'; }
  }
  function closeSettings() {
    if (settingsModal)    settingsModal.classList.remove('open');
    if (settingsBackdrop) settingsBackdrop.classList.remove('open');
  }

  if (toolsBtn)         toolsBtn.onclick         = openSettings;
  if (settingsCloseBtn) settingsCloseBtn.onclick  = closeSettings;
  if (settingsBackdrop) settingsBackdrop.onclick  = closeSettings;

  // Render per-model key rows when extension replies with apiKeysState
  function renderModelKeyList(keysState, activeModelId) {
    if (!modelKeyList) return;
    modelKeyList.innerHTML = '';

    const providerMeta = [
      { id: 'groq',      label: 'Groq',           placeholder: 'gsk_… Enter Groq API key' },
      { id: 'openai',    label: 'OpenAI',          placeholder: 'sk-… Enter OpenAI API key' },
      { id: 'anthropic', label: 'Anthropic',       placeholder: 'sk-ant-… Enter Anthropic API key' },
      { id: 'gemini',    label: 'Google Gemini',   placeholder: 'AIza… Enter Gemini API key' },
    ];

    for (const prov of providerMeta) {
      const provModels = availableModels.filter(m => m.provider === prov.id);
      if (!provModels.length) continue;

      const sectionHeader = document.createElement('div');
      sectionHeader.className = 'provider-section-header';
      sectionHeader.textContent = prov.label + ' Models';
      modelKeyList.appendChild(sectionHeader);

      for (const m of provModels) {
        const maskedKey = (keysState && keysState[m.id]) || '';
        const hasKey = !!maskedKey;
        const isActive = m.id === activeModelId;
        const row = document.createElement('div');
        row.className = 'model-key-row';
        row.innerHTML =
          '<div class="model-key-top">' +
            '<span class="model-key-name">' + m.label +
              (isActive ? '<span class="settings-active-badge">active</span>' : '') +
            '</span>' +
            '<span class="model-key-ctx">' + m.ctx + '</span>' +
            '<span class="model-key-status ' + (hasKey ? 'set' : 'unset') + '">' +
              (hasKey ? '● Key set' : '○ No key') +
            '</span>' +
          '</div>' +
          '<div class="model-key-input-row">' +
            '<input class="model-key-input" type="password" placeholder="' + prov.placeholder + '" ' +
              'data-model="' + m.id + '" data-original="' + maskedKey + '" autocomplete="off" />' +
            '<button class="model-key-eye-btn" title="Show/hide key" tabindex="-1">' +
              '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 3C4.5 3 1.5 5.5 0 8c1.5 2.5 4.5 5 8 5s6.5-2.5 8-5c-1.5-2.5-4.5-5-8-5zm0 8.5A3.5 3.5 0 1 1 8 4.5a3.5 3.5 0 0 1 0 7zm0-5.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg>' +
            '</button>' +
            '<button class="model-key-save-btn" data-model="' + m.id + '">Save</button>' +
            '<button class="model-key-del-btn' + (hasKey ? ' visible' : '') + '" data-model="' + m.id + '" title="Remove key">✕</button>' +
          '</div>' +
          (!isActive ? '<div style="margin-top:2px"><button class="model-key-set-active-btn" data-model="' + m.id + '">Set as active model</button></div>' : '') +
          '';
        const inp     = row.querySelector('.model-key-input');
        const eyeBtn  = row.querySelector('.model-key-eye-btn');
        const save    = row.querySelector('.model-key-save-btn');
        const del     = row.querySelector('.model-key-del-btn');
        const setActive = row.querySelector('.model-key-set-active-btn');

        if (maskedKey) { inp.value = maskedKey; }

        const eyeOpen  = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 3C4.5 3 1.5 5.5 0 8c1.5 2.5 4.5 5 8 5s6.5-2.5 8-5c-1.5-2.5-4.5-5-8-5zm0 8.5A3.5 3.5 0 1 1 8 4.5a3.5 3.5 0 0 1 0 7zm0-5.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg>';
        const eyeClosed = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M13.36 2.64 12.3 1.58C10.94 2.47 9.51 3 8 3 4.5 3 1.5 5.5 0 8c.72 1.2 1.72 2.24 2.9 3.02L1.58 12.3l1.06 1.06 10.72-10.72zm-9.1 9.1A5.94 5.94 0 0 1 2 8c1.3-2.17 3.8-4 6-4 .9 0 1.8.25 2.64.67L11.3 5.33A3.5 3.5 0 0 0 6.16 10.2l-1.9 1.54zM8 13c-1.49 0-2.94-.53-4.3-1.42l1.07-1.07A3.5 3.5 0 0 0 9.84 5.8l1.07-1.07C12.5 5.75 14 6.9 14 8c-1.5 2.5-3.5 5-6 5z"/></svg>';
        if (eyeBtn) eyeBtn.onclick = (e) => {
          e.preventDefault();
          const isPassword = inp.type === 'password';
          inp.type = isPassword ? 'text' : 'password';
          eyeBtn.innerHTML = isPassword ? eyeClosed : eyeOpen;
          eyeBtn.title = isPassword ? 'Hide key' : 'Show key';
        };

        save.onclick = () => {
          const val = inp.value.trim();
          if (!val) { showSettingsMsg('Enter a key first.', 'err'); return; }
          if (val === inp.dataset.original) { showSettingsMsg('Key is already saved.', 'ok'); return; }
          showSettingsMsg('Saving…', '');
          vscode.postMessage({ type: 'setApiKey', modelId: m.id, apiKey: val });
        };
        if (del) del.onclick = () => {
          showSettingsMsg('Removing key…', '');
          vscode.postMessage({ type: 'deleteApiKey', modelId: m.id });
        };
        if (setActive) setActive.onclick = () => {
          vscode.postMessage({ type: 'selectModel', modelId: m.id });
          closeSettings();
        };
        inp.addEventListener('keydown', e => { if (e.key === 'Enter') save.click(); });
        modelKeyList.appendChild(row);
      }
    }
  }

  function showSettingsMsg(text, type) {
    if (!settingsMsg) return;
    settingsMsg.textContent = text;
    settingsMsg.className = 'settings-msg' + (type ? ' ' + type : '');
  }

  renderSessions();

  function add(title, text, cls) {
    const div = document.createElement('div');
    div.className = 'msg ' + cls;

    // Header row: title + action buttons
    const header = document.createElement('div');
    header.className = 'msg-header';

    const label = document.createElement('span');
    label.className = 'msg-label';
    
    if (cls === 'assistant') {
      label.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="margin-right:6px;vertical-align:middle;"><path d="M12 2L14.5 9.5L22 12L14.5 14.5L12 22L9.5 14.5L2 12L9.5 9.5L12 2Z"/></svg>' + title;
    } else {
      label.textContent = title;
    }
    header.appendChild(label);

    const actions = document.createElement('span');
    actions.className = 'msg-actions';

    if (cls === 'user') {
      // 1. Edit button — loads text back into input
      const editBtn = document.createElement('button');
      editBtn.title = 'Edit & Resend';
      editBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M13.23 1h-1.46L3.52 9.25l-.16.22L1 13.59 2.41 15l4.12-2.36.22-.16L15 4.23V2.77L13.23 1zM2.41 13.59l1.51-3 1.45 1.45-2.96 1.55zm3.83-2.06L4.47 9.76l8-8 1.77 1.77-8 8z"/></svg>';
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
      copyBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M4 4l1-1h5.414L14 6.586V14l-1 1H5l-1-1V4zm9 3l-3-3H5v10h8V7zM3 1L2 2v10l1 1V2h6.414l-1-1H3z"/></svg>';
      copyBtn.onclick = () => {
        vscode.postMessage({ type: 'copyCode', code: text });
        copyBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M13.854 3.646a.5.5 0 0 1 0 .708l-7 7a.5.5 0 0 1-.708 0l-3.5-3.5a.5.5 0 1 1 .708-.708L6.5 10.293l6.646-6.647a.5.5 0 0 1 .708 0z"/></svg>';
        setTimeout(() => { copyBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M4 4l1-1h5.414L14 6.586V14l-1 1H5l-1-1V4zm9 3l-3-3H5v10h8V7zM3 1L2 2v10l1 1V2h6.414l-1-1H3z"/></svg>'; }, 1200);
      };
      actions.appendChild(copyBtn);

      // 3. Restore button — reverts editor to state before this prompt ran
      //    (hidden until a checkpoint is linked via 'linkCheckpoint' message)
      const restoreBtn = document.createElement('button');
      restoreBtn.title = 'Restore code to before this change';
      restoreBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M4.5 2A3.5 3.5 0 0 0 1 5.5v1h1v-1A2.5 2.5 0 0 1 4.5 3h4.3L7.1 4.7l.8.6 2.5-2.5v-.6L7.9 0l-.8.6L8.8 2H4.5zM15 5.5a3.5 3.5 0 0 0-3.5-3.5v1A2.5 2.5 0 0 1 14 5.5v5a2.5 2.5 0 0 1-2.5 2.5h-8A2.5 2.5 0 0 1 1 10.5v-1H0v1A3.5 3.5 0 0 0 3.5 14h8a3.5 3.5 0 0 0 3.5-3.5v-5z"/></svg>';
      restoreBtn.className = 'restore-btn';
      restoreBtn.style.display = 'none';
      restoreBtn.onclick = () => {
        const cpId = div.dataset.checkpointId;
        if (cpId) {
          vscode.postMessage({ type: 'checkpointAction', action: 'discard', id: cpId });
          restoreBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M13.854 3.646a.5.5 0 0 1 0 .708l-7 7a.5.5 0 0 1-.708 0l-3.5-3.5a.5.5 0 1 1 .708-.708L6.5 10.293l6.646-6.647a.5.5 0 0 1 .708 0z"/></svg>';
          setTimeout(() => { restoreBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M4.5 2A3.5 3.5 0 0 0 1 5.5v1h1v-1A2.5 2.5 0 0 1 4.5 3h4.3L7.1 4.7l.8.6 2.5-2.5v-.6L7.9 0l-.8.6L8.8 2H4.5zM15 5.5a3.5 3.5 0 0 0-3.5-3.5v1A2.5 2.5 0 0 1 14 5.5v5a2.5 2.5 0 0 1-2.5 2.5h-8A2.5 2.5 0 0 1 1 10.5v-1H0v1A3.5 3.5 0 0 0 3.5 14h8a3.5 3.5 0 0 0 3.5-3.5v-5z"/></svg>'; }, 2000);
        }
      };
      actions.appendChild(restoreBtn);
    } else {
      // Assistant messages: copy button only
      const copyBtn = document.createElement('button');
      copyBtn.title = 'Copy';
      copyBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M4 4l1-1h5.414L14 6.586V14l-1 1H5l-1-1V4zm9 3l-3-3H5v10h8V7zM3 1L2 2v10l1 1V2h6.414l-1-1H3z"/></svg>';
      copyBtn.onclick = () => {
        vscode.postMessage({ type: 'copyCode', code: text });
        copyBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M13.854 3.646a.5.5 0 0 1 0 .708l-7 7a.5.5 0 0 1-.708 0l-3.5-3.5a.5.5 0 1 1 .708-.708L6.5 10.293l6.646-6.647a.5.5 0 0 1 .708 0z"/></svg>';
        setTimeout(() => { copyBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M4 4l1-1h5.414L14 6.586V14l-1 1H5l-1-1V4zm9 3l-3-3H5v10h8V7zM3 1L2 2v10l1 1V2h6.414l-1-1H3z"/></svg>'; }, 1200);
      };
      actions.appendChild(copyBtn);
    }

    header.appendChild(actions);

    const bubble = document.createElement('div');
    bubble.className = 'bubble';

    if (cls === 'assistant') {
      bubble.innerHTML = formatAssistantMessage(text);
    } else {
      bubble.textContent = text;
    }

    div.appendChild(header);
    div.appendChild(bubble);
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
  }

  /** Convert AI plain-text summary into rich HTML with proper styling */
  function formatAssistantMessage(text) {
    // Detect file-summary messages (created/modified/failed pattern)
    const hasFileSummary = /(\u2705|✅)\\s*(Created|Generated)\\s+\\d+/i.test(text)
      || /(\uD83D\uDD27|🔧)\\s*Modified\\s+\\d+/i.test(text)
      || /(⚠️)\\s*Failed/i.test(text);
    // Detect diff summary messages
    const hasDiff = /📋 Changes made to/i.test(text);
    // Detect loading/status messages
    const isStatusMsg = /^(⏳|🔍|🖼️|⌛|🚀)/.test(text.trim());

    if (!hasFileSummary && !hasDiff && !isStatusMsg) {
      // Regular text message — preserve whitespace, escape HTML
      return '<div class="ai-plain-text">' + escapeHtml(text) + '</div>';
    }

    if (isStatusMsg && !hasFileSummary && !hasDiff) {
      return '<div class="ai-status-line"><span class="status-icon">' + text.trim().charAt(0) + text.trim().charAt(1) + '</span>' + escapeHtml(text.trim().substring(text.trim().match(/^\\S+\\s?/)?.[0]?.length || 0)) + '</div>';
    }

    let html = '';
    const lines = text.split('\\n');
    let currentFiles = [];
    let currentType = '';
    let inDiff = false;
    let diffLines = [];

    function flushFiles() {
      if (currentFiles.length === 0) return;
      const typeClass = currentType === 'created' ? 'created' : currentType === 'modified' ? 'modified' : 'failed';
      const icon = currentType === 'created' ? '📄' : currentType === 'modified' ? '✏️' : '❌';
      html += '<ul class="ai-file-list">';
      for (const f of currentFiles) {
        html += '<li class="ai-file-item ' + typeClass + '"><span class="file-icon">' + icon + '</span><span class="file-path">' + escapeHtml(f) + '</span></li>';
      }
      html += '</ul>';
      currentFiles = [];
    }

    function flushDiff() {
      if (diffLines.length === 0) return;
      html += '<div class="ai-diff-summary">';
      for (const dl of diffLines) {
        // Highlight specific diff parts
        let line = escapeHtml(dl);
        line = line.replace(/(✚\\s*\\d+\\s*lines?\\s*added)/g, '<span class="diff-added">$1</span>');
        line = line.replace(/(─\\s*\\d+\\s*lines?\\s*removed)/g, '<span class="diff-removed">$1</span>');
        line = line.replace(/(📏.*)/g, '<span class="diff-size">$1</span>');
        if (/📋 Changes made to/.test(dl)) {
          line = '<span class="diff-title">' + line + '</span>';
        }
        html += line + '\\n';
      }
      html += '</div>';
      diffLines = [];
      inDiff = false;
    }

    for (const line of lines) {
      const trimmed = line.trim();

      // Section headers: "✅ Created N files:", "🔧 Modified N files:", "⚠️ Failed"
      const createdMatch = trimmed.match(/^(✅|\u2705)\\s*(Created|Generated)\\s+(\\d+)/i);
      const modifiedMatch = trimmed.match(/^(🔧|\uD83D\uDD27)\\s*Modified\\s+(\\d+)/i);
      const failedMatch = trimmed.match(/^(⚠️)\\s*Failed/i);

      if (createdMatch) {
        flushFiles(); flushDiff();
        currentType = 'created';
        html += '<div class="ai-section-header"><span class="section-icon">✅</span>' + escapeHtml(trimmed.replace(/^(✅|\u2705)\\s*/, '')) + '</div>';
        continue;
      }
      if (modifiedMatch) {
        flushFiles(); flushDiff();
        currentType = 'modified';
        html += '<div class="ai-section-header"><span class="section-icon">🔧</span>' + escapeHtml(trimmed.replace(/^(🔧|\uD83D\uDD27)\\s*/, '')) + '</div>';
        continue;
      }
      if (failedMatch) {
        flushFiles(); flushDiff();
        currentType = 'failed';
        html += '<div class="ai-section-header" style="color:#f48771"><span class="section-icon">⚠️</span>' + escapeHtml(trimmed.replace(/^⚠️\\s*/, '')) + '</div>';
        continue;
      }

      // Diff block detection
      if (/📋 Changes made to/.test(trimmed)) {
        flushFiles();
        inDiff = true;
        diffLines.push(trimmed);
        continue;
      }
      if (inDiff) {
        if (trimmed === '' && diffLines.length > 3) {
          flushDiff();
        } else {
          diffLines.push(trimmed);
        }
        continue;
      }

      // File path lines: "  📄 path/to/file" or "  ✏️ path" or "  ❌ path"
      const fileLineMatch = trimmed.match(/^(📄|✏️|❌|📦)?\\s*(.+\\..{1,8})$/);
      if (fileLineMatch && currentType) {
        currentFiles.push(fileLineMatch[2].trim());
        continue;
      }

      // Status lines like "⏳ ..."
      if (/^(⏳|🔍|🖼️)/.test(trimmed)) {
        flushFiles(); flushDiff();
        html += '<div class="ai-status-line"><span class="status-icon">' + trimmed.substring(0, 2) + '</span>' + escapeHtml(trimmed.substring(2).trim()) + '</div>';
        continue;
      }

      // Skip empty lines between sections
      if (trimmed === '') {
        flushFiles();
        continue;
      }

      // Anything else: plain text
      flushFiles(); flushDiff();
      html += '<div class="ai-plain-text">' + escapeHtml(trimmed) + '</div>';
    }
    flushFiles();
    flushDiff();
    return html || '<div class="ai-plain-text">' + escapeHtml(text) + '</div>';
  }

  function escapeHtml(str) {
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
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
    label.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="margin-right:6px;vertical-align:middle;"><path d="M12 2L14.5 9.5L22 12L14.5 14.5L12 22L9.5 14.5L2 12L9.5 9.5L12 2Z"/></svg>' + '📋 Plan';
    header.appendChild(label);

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;

    const actions = document.createElement('div');
    actions.className = 'plan-actions';

    const execBtn = document.createElement('button');
    execBtn.className = 'plan-execute-btn';
    execBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style="margin-right:6px;vertical-align:middle;"><path d="M14 8L3 14V2l11 6z"/></svg>Execute Plan';
    execBtn.onclick = () => {
      execBtn.disabled = true;
      execBtn.textContent = '⏳ Executing…';
      vscode.postMessage({ type: 'executePlan', plan: text });
    };

    const copyBtn = document.createElement('button');
    copyBtn.className = 'plan-copy-btn';
    copyBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style="margin-right:6px;vertical-align:middle;"><path d="M4 4l1-1h5.414L14 6.586V14l-1 1H5l-1-1V4zm9 3l-3-3H5v10h8V7zM3 1L2 2v10l1 1V2h6.414l-1-1H3z"/></svg>Copy Plan';
    copyBtn.onclick = () => {
      vscode.postMessage({ type: 'copyCode', code: text });
      copyBtn.innerHTML = '✓ Copied';
      setTimeout(() => { copyBtn.innerHTML = '📋 Copy Plan'; }, 1500);
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
