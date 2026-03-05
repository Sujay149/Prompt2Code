import * as vscode from 'vscode';
import * as path from 'path';

// ════════════════════════════════════════════════════════════════
// Four-Layer Prompt Architecture for Prompt2Code
//
// Layer 1 — System Prompt:   AI identity, behavior & capabilities
// Layer 2 — Editor Context:  Current editor state awareness
// Layer 3 — Codebase RAG:    Relevant project files & structure
// Layer 4 — Completion:      User instruction + generation rules
// ════════════════════════════════════════════════════════════════

/** Structured editor state for Layer 2 */
export interface EditorContext {
  fileName: string;
  filePath: string;
  language: string;
  lineNumber: number;
  fileContent: string;
  cursorContext: string;
  selectedCode: string;
}

/** Structured codebase context for Layer 3 */
export interface CodebaseContext {
  fileTree: string;
  retrievedFiles: { path: string; content: string }[];
}

export class PromptBuilder {

  // ═══════════════════════════════════════════════════════════
  // LAYER 1 — System Prompt (Core AI Behavior & Capabilities)
  // ═══════════════════════════════════════════════════════════

  /**
   * Build the Prompt2Code system prompt that defines identity,
   * capabilities, and behavioral rules.
   */
  buildSystemPrompt(): string {
    return [
      'You are Prompt2Code, an AI coding assistant for Visual Studio Code created by Sujay Babu Thota.',
      '',
      'Your goal is to help developers write, understand, debug, and improve code efficiently inside the editor.',
      '',
      'Capabilities include:',
      '- Code generation',
      '- Code explanation',
      '- Bug detection',
      '- Code refactoring',
      '- UI generation',
      '- Architecture suggestions',
      '- Multi-file feature implementation',
      '- Terminal command generation',
      '',
      'You operate within a developer workspace and must consider the existing project structure and dependencies before generating solutions.',
      '',
      'Always prioritize:',
      '- correctness',
      '- clean code',
      '- modern best practices',
      '- maintainability',
      '',
      'Avoid unnecessary explanations unless requested.',
      '',
      'If code errors or bugs are detected, clearly explain the issue and provide a corrected implementation.',
      '',
      'If generating multi-file code, clearly label each file path.',
      '',
      'If the request involves UI, prefer modern patterns such as React components and responsive layouts.',
      '',
      'Never generate malicious code such as malware, exploits, or security bypass tools.',
    ].join('\n');
  }

  // ═══════════════════════════════════════════════════════════
  // LAYER 2 — Editor Context Prompt (Current Editor State)
  // ═══════════════════════════════════════════════════════════

  /**
   * Capture the current editor state as a structured context object.
   */
  captureEditorContext(editor?: vscode.TextEditor): EditorContext | null {
    if (!editor) { return null; }

    const doc = editor.document;
    const position = editor.selection.active;
    const selection = editor.selection;

    const fileName = path.basename(doc.uri.fsPath);
    const filePath = vscode.workspace.asRelativePath(doc.uri, false);
    const language = this.normalizeLanguage(doc.languageId);
    const lineNumber = position.line + 1;

    // Current file content (capped for context window)
    const fileContent = doc.getText();

    // Nearby code around cursor (±10 lines)
    const cursorContext = this.buildContext(doc, position, 10);

    // Selected code (if any)
    const selectedCode = selection.isEmpty ? '' : doc.getText(selection);

    return {
      fileName,
      filePath,
      language,
      lineNumber,
      fileContent,
      cursorContext,
      selectedCode,
    };
  }

  /**
   * Format the editor context into a prompt string for Layer 2.
   */
  buildEditorContextPrompt(ctx: EditorContext | null, maxFileChars: number = 15000): string {
    if (!ctx) { return ''; }

    const parts: string[] = [
      '── Editor Context ──',
      `Active File: ${ctx.filePath}`,
      `Cursor Position: Line ${ctx.lineNumber}`,
      `Programming Language: ${ctx.language}`,
    ];

    // Current file content (trimmed if too large)
    if (ctx.fileContent) {
      const content = ctx.fileContent.length > maxFileChars
        ? ctx.fileContent.substring(0, maxFileChars) + '\n/* ...truncated... */'
        : ctx.fileContent;
      parts.push('', 'Current File Content:', content);
    }

    // Nearby code around cursor
    if (ctx.cursorContext) {
      parts.push('', 'Nearby Code Around Cursor:', ctx.cursorContext);
    }

    // Selected code
    if (ctx.selectedCode) {
      parts.push('', 'User Selection:', ctx.selectedCode);
    }

    return parts.join('\n');
  }

  // ═══════════════════════════════════════════════════════════
  // LAYER 3 — Codebase Retrieval Prompt (RAG Layer)
  // ═══════════════════════════════════════════════════════════

  /**
   * Format codebase retrieval context into a prompt string for Layer 3.
   */
  buildCodebaseRetrievalPrompt(codebaseCtx: CodebaseContext | null): string {
    if (!codebaseCtx) { return ''; }

    const parts: string[] = ['── Relevant Project Context ──'];

    // Project structure (file tree)
    if (codebaseCtx.fileTree) {
      parts.push('', 'Project Structure:', codebaseCtx.fileTree);
    }

    // Retrieved files
    if (codebaseCtx.retrievedFiles.length > 0) {
      parts.push('', 'Retrieved Files:');
      for (const file of codebaseCtx.retrievedFiles) {
        parts.push(``, `File: ${file.path}`, file.content);
      }
    }

    parts.push(
      '',
      'Use this context to understand how the project is structured and follow existing patterns.',
      'Avoid generating duplicate functionality if similar code already exists.',
      'Prefer reusing existing utilities or components when possible.'
    );

    return parts.join('\n');
  }

  // ═══════════════════════════════════════════════════════════
  // LAYER 4 — Completion Prompt (Copilot-Style Generation)
  // ═══════════════════════════════════════════════════════════

  /**
   * Build the completion prompt that merges the user request with
   * generation instructions.
   */
  buildCompletionPrompt(userPrompt: string): string {
    return [
      '── User Request ──',
      userPrompt,
      '',
      '── Instructions ──',
      'Analyze the current editor context and retrieved project files.',
      '',
      'If the user is writing code, generate a continuation that fits naturally with the surrounding code.',
      '',
      'If implementing a feature, produce complete working code.',
      '',
      'If multiple files are required, clearly label them using:',
      '  File: path/to/file',
      '',
      'Focus on:',
      '- clean architecture',
      '- correct imports',
      '- consistency with existing project code',
      '',
      'If a bug exists, explain the issue briefly and provide a corrected version.',
      '',
      'Keep responses concise and developer-focused.',
    ].join('\n');
  }

  // ═══════════════════════════════════════════════════════════
  // COMBINED — Merge all four layers into a final prompt
  // ═══════════════════════════════════════════════════════════

  /**
   * Build the complete four-layer prompt for the AI model.
   *
   * Returns { systemMessage, userMessage } ready to be sent as
   * GroqMessage[] (system + user roles).
   */
  buildFourLayerPrompt(opts: {
    editorContext?: EditorContext | null;
    codebaseContext?: CodebaseContext | null;
    userPrompt: string;
    maxFileChars?: number;
  }): { systemMessage: string; userMessage: string } {
    // Layer 1 — System Prompt
    const systemMessage = this.buildSystemPrompt();

    // Layers 2 + 3 + 4 combined into the user message
    const layers: string[] = [];

    // Layer 2 — Editor Context
    const editorCtx = this.buildEditorContextPrompt(opts.editorContext ?? null, opts.maxFileChars);
    if (editorCtx) { layers.push(editorCtx); }

    // Layer 3 — Codebase Retrieval (RAG)
    const codebaseCtx = this.buildCodebaseRetrievalPrompt(opts.codebaseContext ?? null);
    if (codebaseCtx) { layers.push(codebaseCtx); }

    // Layer 4 — Completion Prompt
    layers.push(this.buildCompletionPrompt(opts.userPrompt));

    const userMessage = layers.join('\n\n');

    return { systemMessage, userMessage };
  }

  // ═══════════════════════════════════════════════════════════
  // EXISTING UTILITIES (preserved for backward compatibility)
  // ═══════════════════════════════════════════════════════════

  /**
   * Build context from surrounding code
   */
  buildContext(document: vscode.TextDocument, position: vscode.Position, maxLines: number = 10): string {
    const startLine = Math.max(0, position.line - maxLines);
    const endLine = Math.min(document.lineCount - 1, position.line + maxLines);

    const range = new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).text.length);
    return document.getText(range);
  }

  /**
   * Get code prefix (before cursor)
   */
  getPrefix(document: vscode.TextDocument, position: vscode.Position, maxChars: number = 2000): string {
    const startPos = document.offsetAt(position) - maxChars;
    const startOffset = Math.max(0, startPos);
    
    const range = new vscode.Range(
      document.positionAt(startOffset),
      position
    );

    return document.getText(range);
  }

  /**
   * Get code suffix (after cursor)
   */
  getSuffix(document: vscode.TextDocument, position: vscode.Position, maxChars: number = 1000): string {
    const endPos = document.offsetAt(position) + maxChars;
    const documentEnd = document.offsetAt(new vscode.Position(document.lineCount - 1, 0)) + 
                        document.lineAt(document.lineCount - 1).text.length;
    const endOffset = Math.min(documentEnd, endPos);
    
    const range = new vscode.Range(
      position,
      document.positionAt(endOffset)
    );

    return document.getText(range);
  }

  /**
   * Determine if current context suggests inline completion
   */
  shouldUseInlineCompletion(document: vscode.TextDocument, position: vscode.Position): boolean {
    const line = document.lineAt(position.line);
    const textBeforeCursor = line.text.substring(0, position.character);
    const textAfterCursor = line.text.substring(position.character);

    // Don't suggest inline completion if we're in a comment (except for instruction generation)
    if (this.isInComment(textBeforeCursor, document.languageId)) {
      return false;
    }

    // Suggest completion if there's code before cursor and we're at end of line or mid-statement
    if (textBeforeCursor.trim().length > 0) {
      // Check if it looks like incomplete code
      const endsWithOperator = /[+\-*\/=<>,.(\[]$/.test(textBeforeCursor.trim());
      const endsWithKeyword = /\b(function|const|let|var|return|if|for|while)\s*$/.test(textBeforeCursor);
      
      return endsWithOperator || endsWithKeyword || textAfterCursor.trim().length === 0;
    }

    return false;
  }

  /**
   * Check if position is inside a comment
   */
  private isInComment(text: string, language: string): boolean {
    const trimmed = text.trim();
    
    // Check for single-line comments
    if (trimmed.startsWith('//') || trimmed.startsWith('#')) {
      return true;
    }

    // Check for HTML comments
    if (trimmed.startsWith('<!--')) {
      return true;
    }

    // Check for multi-line comments
    if (trimmed.startsWith('/*') || text.includes('/*')) {
      return true;
    }

    return false;
  }

  /**
   * Extract file-level context (imports, class definitions, etc.)
   */
  extractFileLevelContext(document: vscode.TextDocument): string {
    const lines = [];
    const maxLines = Math.min(50, document.lineCount);

    // Get first N lines which typically contain imports and top-level declarations
    for (let i = 0; i < maxLines; i++) {
      const line = document.lineAt(i).text;
      
      // Include imports, class definitions, function declarations
      if (
        line.includes('import ') ||
        line.includes('export ') ||
        line.includes('class ') ||
        line.includes('interface ') ||
        line.includes('type ') ||
        line.includes('function ') ||
        line.includes('const ') ||
        line.includes('let ') ||
        line.includes('var ')
      ) {
        lines.push(line);
      }
    }

    return lines.join('\n');
  }

  /**
   * Normalize language identifier
   */
  normalizeLanguage(languageId: string): string {
    const languageMap: Record<string, string> = {
      'javascriptreact': 'React (JSX)',
      'typescriptreact': 'React (TSX)',
      'javascript': 'JavaScript',
      'typescript': 'TypeScript',
      'html': 'HTML',
      'css': 'CSS',
      'scss': 'SCSS',
      'python': 'Python',
      'java': 'Java',
      'cpp': 'C++',
      'c': 'C'
    };

    return languageMap[languageId] || languageId;
  }
}
