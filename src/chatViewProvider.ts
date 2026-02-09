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

    // Send available models + current selection to webview
    this.sendModelListToWebview();

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

        case 'selectModel': {
          await this.handleModelSelection(data.modelId);
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
          const before = textNow.substring(0, startOffset);
          const after = textNow.substring(startOffset);
          // The streamed region starts at startOffset — find what's currently there
          // and replace with the final accumulated newBlock if it doesn't match.
          if (!after.startsWith(newBlock)) {
            // Determine end of the region the updater was writing into
            const currentRegionLen = textNow.length - (doc.getText().length - originalLen - startOffset > 0
              ? doc.getText().length - originalLen
              : textNow.length - newBlock.length);
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
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
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
  /* ── Model selector ── */
  .model-selector-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-top: 1px solid var(--vscode-panel-border);
    background: var(--vscode-sideBar-background);
  }
  .model-selector-bar label {
    font-size: 11px;
    opacity: 0.7;
    white-space: nowrap;
  }
  .model-selector-bar select {
    flex: 1;
    min-width: 0;
    padding: 3px 6px;
    font-size: 11px;
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-dropdown-background, var(--vscode-input-background));
    border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border));
    border-radius: 4px;
    outline: none;
    cursor: pointer;
    appearance: auto;
  }
  .model-selector-bar select:focus {
    border-color: var(--vscode-focusBorder);
  }
  .model-selector-bar .model-ctx {
    font-size: 10px;
    opacity: 0.5;
    white-space: nowrap;
  }
  /* ── Diff summary styling in bubble ── */
  .bubble .diff-summary {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px;
    line-height: 1.6;
  }
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
  <div class="model-selector-bar">
    <label>Model:</label>
    <select id="modelSelect"><option>Loading…</option></select>
    <span class="model-ctx" id="modelCtx"></span>
  </div>
  <div class="chat-input-wrapper">
    <div class="chat-input">
      <button id="addFile" class="icon-btn" title="Add file to context">+</button>
      <textarea id="input" rows="1" placeholder="Ask Prompt2Code… (use @file or @workspace)"></textarea>
      <button id="send" class="send-btn" title="Send">&#10148;</button>
    </div>
  </div>

<script nonce="${nonce}">
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
  const modelSelect = document.getElementById('modelSelect');
  const modelCtx = document.getElementById('modelCtx');

  let loading = false;
  let availableModels = [];

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
      // Show ctx window for the current model
      const cur = availableModels.find(m => m.id === msg.activeModel);
      modelCtx.textContent = cur ? cur.ctx + ' context' : '';
    }
    if (msg.type === 'modelChangeResult') {
      if (msg.success) {
        modelSelect.value = msg.activeModel;
        const cur = availableModels.find(m => m.id === msg.activeModel);
        modelCtx.textContent = cur ? cur.ctx + ' context' : '';
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
</script>
</body>
</html>`;
  }
}
