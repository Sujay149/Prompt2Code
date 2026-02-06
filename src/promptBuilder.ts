import * as vscode from 'vscode';

export class PromptBuilder {
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
