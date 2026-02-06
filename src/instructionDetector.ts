import * as vscode from 'vscode';

export interface InstructionMatch {
  instruction: string;
  range: vscode.Range;
  type: 'html-comment' | 'single-line-comment' | 'multi-line-comment';
  language: string;
}

export class InstructionDetector {
  private readonly instructionKeywords = ['create', 'generate', 'build', 'make'];

  /**
   * Detect if the current cursor position is at an instruction comment
   */
  detectInstruction(document: vscode.TextDocument, position: vscode.Position): InstructionMatch | null {
    const line = document.lineAt(position.line);
    const text = line.text;
    const language = document.languageId;

    // Check HTML comments: <!-- create ... -->
    const htmlMatch = this.detectHTMLComment(text, position, line);
    if (htmlMatch) {
      return { ...htmlMatch, language };
    }

    // Check single-line comments: // create ... or # create ...
    const singleLineMatch = this.detectSingleLineComment(text, position, line, language);
    if (singleLineMatch) {
      return { ...singleLineMatch, language };
    }

    // Check multi-line comments: /* create ... */
    const multiLineMatch = this.detectMultiLineComment(document, position);
    if (multiLineMatch) {
      return { ...multiLineMatch, language };
    }

    return null;
  }

  /**
   * Detect HTML comment: <!-- create a login form -->
   */
  private detectHTMLComment(text: string, position: vscode.Position, line: vscode.TextLine): Omit<InstructionMatch, 'language'> | null {
    const htmlCommentRegex = /<!--\s*(.+?)\s*-->/g;
    let match;

    while ((match = htmlCommentRegex.exec(text)) !== null) {
      const content = match[1].trim();
      const startIdx = match.index;
      const endIdx = match.index + match[0].length;

      // Check if cursor is within or at the end of this comment
      if (position.character >= startIdx && position.character <= endIdx) {
        if (this.isInstruction(content)) {
          return {
            instruction: content,
            range: new vscode.Range(
              line.lineNumber,
              startIdx,
              line.lineNumber,
              endIdx
            ),
            type: 'html-comment'
          };
        }
      }
    }

    return null;
  }

  /**
   * Detect single-line comment: // create... or # create...
   */
  private detectSingleLineComment(
    text: string,
    position: vscode.Position,
    line: vscode.TextLine,
    language: string
  ): Omit<InstructionMatch, 'language'> | null {
    const commentStarts = this.getCommentStarts(language);
    
    for (const commentStart of commentStarts) {
      const idx = text.indexOf(commentStart);
      if (idx !== -1) {
        const content = text.substring(idx + commentStart.length).trim();
        
        // Check if cursor is after the comment start
        if (position.character >= idx) {
          if (this.isInstruction(content)) {
            return {
              instruction: content,
              range: new vscode.Range(
                line.lineNumber,
                idx,
                line.lineNumber,
                text.length
              ),
              type: 'single-line-comment'
            };
          }
        }
      }
    }

    return null;
  }

  /**
   * Detect multi-line comment: /asterisk create ... asterisk/
   */
  private detectMultiLineComment(document: vscode.TextDocument, position: vscode.Position): Omit<InstructionMatch, 'language'> | null {
    const text = document.getText();
    const offset = document.offsetAt(position);
    
    // Find all /* ... */ comments
    const multiLineRegex = /\/\*\s*(.+?)\s*\*\//gs;
    let match;

    while ((match = multiLineRegex.exec(text)) !== null) {
      const startOffset = match.index;
      const endOffset = match.index + match[0].length;

      if (offset >= startOffset && offset <= endOffset) {
        const content = match[1].trim();
        if (this.isInstruction(content)) {
          return {
            instruction: content,
            range: new vscode.Range(
              document.positionAt(startOffset),
              document.positionAt(endOffset)
            ),
            type: 'multi-line-comment'
          };
        }
      }
    }

    return null;
  }

  /**
   * Check if text starts with an instruction keyword
   */
  private isInstruction(text: string): boolean {
    const lowerText = text.toLowerCase();
    return this.instructionKeywords.some(keyword => lowerText.startsWith(keyword));
  }

  /**
   * Get comment syntax for different languages
   */
  private getCommentStarts(language: string): string[] {
    const commentMap: Record<string, string[]> = {
      javascript: ['//'],
      typescript: ['//'],
      javascriptreact: ['//'],
      typescriptreact: ['//'],
      html: ['<!--'],
      css: ['/*'],
      python: ['#'],
      ruby: ['#'],
      yaml: ['#']
    };

    return commentMap[language] || ['//'];
  }

  /**
   * Extract instruction from selected text
   */
  extractInstructionFromSelection(document: vscode.TextDocument, selection: vscode.Selection): InstructionMatch | null {
    const text = document.getText(selection).trim();
    
    if (this.isInstruction(text)) {
      return {
        instruction: text,
        range: selection,
        type: 'single-line-comment',
        language: document.languageId
      };
    }

    return null;
  }
}
