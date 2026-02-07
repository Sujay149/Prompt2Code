import * as vscode from 'vscode';
import { GroqClient } from './groqClient';
import { InstructionDetector, InstructionMatch } from './instructionDetector';
import { PromptBuilder } from './promptBuilder';
import { ChatViewProvider } from './chatViewProvider';

let groqClient: GroqClient;
let instructionDetector: InstructionDetector;
let promptBuilder: PromptBuilder;
let inlineCompletionsEnabled = true;

export function activate(context: vscode.ExtensionContext) {
  console.log('Prompt2Code is now active');

  // Initialize services
  groqClient = new GroqClient();
  instructionDetector = new InstructionDetector();
  promptBuilder = new PromptBuilder();

  // Register chat view provider
  const chatViewProvider = new ChatViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewType,
      chatViewProvider
    )
  );

  // Register commands
  registerCommands(context);

  // Register inline completion provider
  registerInlineCompletionProvider(context);

  // Load initial settings
  const config = vscode.workspace.getConfiguration('prompt2code');
  inlineCompletionsEnabled = config.get<boolean>('enableInlineCompletions', true);
}

function registerCommands(context: vscode.ExtensionContext) {
  // Command: Generate code from instruction
  const generateCodeCommand = vscode.commands.registerCommand('prompt2code.generateCode', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }

    const document = editor.document;
    const selection = editor.selection;
    const position = selection.active;

    try {
      // First, check if there's selected text
      let instructionMatch: InstructionMatch | null = null;

      if (!selection.isEmpty) {
        instructionMatch = instructionDetector.extractInstructionFromSelection(document, selection);
      } else {
        // Detect instruction at cursor
        instructionMatch = instructionDetector.detectInstruction(document, position);
      }

      if (!instructionMatch) {
        vscode.window.showInformationMessage(
          'No instruction found. Write a comment like: <!-- create a login form --> or // create a navbar'
        );
        return;
      }

      // Show progress
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Generating code...',
          cancellable: false
        },
        async () => {
          try {
            // Get surrounding context
            const context = promptBuilder.buildContext(document, position);

            // Generate code
            const generatedCode = await groqClient.generateCode(
              instructionMatch!.instruction,
              instructionMatch!.language,
              context
            );

            // Replace the instruction with generated code
            await editor.edit(editBuilder => {
              editBuilder.replace(instructionMatch!.range, generatedCode);
            });

            // Format the document
            await vscode.commands.executeCommand('editor.action.formatDocument');

          } catch (error) {
            console.error('Error generating code:', error);
            vscode.window.showErrorMessage('Failed to generate code. Please check your API key and try again.');
          }
        }
      );
    } catch (error) {
      console.error('Error in generateCode command:', error);
    }
  });

  // Command: Enable inline completions
  const enableInlineCommand = vscode.commands.registerCommand('prompt2code.enableInline', () => {
    inlineCompletionsEnabled = true;
    vscode.workspace.getConfiguration('prompt2code').update('enableInlineCompletions', true, true);
    vscode.window.showInformationMessage('Prompt2Code inline suggestions enabled');
  });

  // Command: Disable inline completions
  const disableInlineCommand = vscode.commands.registerCommand('prompt2code.disableInline', () => {
    inlineCompletionsEnabled = false;
    vscode.workspace.getConfiguration('prompt2code').update('enableInlineCompletions', false, true);
    vscode.window.showInformationMessage('Prompt2Code inline suggestions disabled');
  });

  // Command: Open chat view
  const openChatCommand = vscode.commands.registerCommand('prompt2code.openChat', () => {
    vscode.commands.executeCommand('prompt2code.chatView.focus');
  });

  context.subscriptions.push(generateCodeCommand, enableInlineCommand, disableInlineCommand, openChatCommand);
}

function registerInlineCompletionProvider(context: vscode.ExtensionContext) {
  const supportedLanguages = [
    'javascript',
    'typescript',
    'javascriptreact',
    'typescriptreact',
    'html',
    'css',
    'python',
    'java'
  ];

  const provider: vscode.InlineCompletionItemProvider = {
    async provideInlineCompletionItems(
      document: vscode.TextDocument,
      position: vscode.Position,
      context: vscode.InlineCompletionContext,
      token: vscode.CancellationToken
    ): Promise<vscode.InlineCompletionItem[] | vscode.InlineCompletionList | null> {
      
      // Check if inline completions are enabled
      if (!inlineCompletionsEnabled) {
        return null;
      }

      // Check if we should provide completion
      const config = vscode.workspace.getConfiguration('prompt2code');
      if (!config.get<boolean>('enableInlineCompletions', true)) {
        return null;
      }

      // Don't provide completion if we're in an instruction comment
      const instruction = instructionDetector.detectInstruction(document, position);
      if (instruction) {
        return null;
      }

      // Check if it's a good time for inline completion
      if (!promptBuilder.shouldUseInlineCompletion(document, position)) {
        return null;
      }

      try {
        // Get context
        const prefix = promptBuilder.getPrefix(document, position);
        const suffix = promptBuilder.getSuffix(document, position);

        // Don't complete if there's very little context
        if (prefix.trim().length < 10) {
          return null;
        }

        // Request completion
        const completion = await groqClient.inlineComplete(
          prefix,
          suffix,
          document.languageId
        );

        if (!completion || completion.trim().length === 0) {
          return null;
        }

        // Create inline completion item
        const item = new vscode.InlineCompletionItem(
          completion,
          new vscode.Range(position, position)
        );

        return [item];

      } catch (error) {
        console.error('Error in inline completion:', error);
        return null;
      }
    }
  };

  // Register provider for all supported languages
  const disposable = vscode.languages.registerInlineCompletionItemProvider(
    supportedLanguages.map(lang => ({ language: lang })),
    provider
  );

  context.subscriptions.push(disposable);
}

// Add automatic trigger on comment completion
vscode.workspace.onDidChangeTextDocument(async (event) => {
  if (!vscode.window.activeTextEditor) {
    return;
  }

  const editor = vscode.window.activeTextEditor;
  const document = event.document;

  // Check if this is the active document
  if (document !== editor.document) {
    return;
  }

  // Only proceed if a single change was made
  if (event.contentChanges.length !== 1) {
    return;
  }

  const change = event.contentChanges[0];
  const position = change.range.end;
  const line = document.lineAt(position.line);
  const text = line.text;

  // Check if the line contains a completed instruction comment
  const htmlCommentComplete = /<!--\s*(create|generate|build)\s+.+\s*-->/.test(text);
  const singleLineComplete = /\/\/\s*(create|generate|build)\s+.+/.test(text);
  const multiLineComplete = /\/\*\s*(create|generate|build)\s+.+\s*\*\//.test(text);

  if (htmlCommentComplete || singleLineComplete || multiLineComplete) {
    // Check if the user wants auto-generation (you could add a setting for this)
    const autoGenerate = vscode.workspace.getConfiguration('prompt2code').get<boolean>('autoGenerateOnComment', false);
    
    if (autoGenerate) {
      // Small delay to ensure the comment is fully typed
      setTimeout(async () => {
        await vscode.commands.executeCommand('prompt2code.generateCode');
      }, 500);
    }
  }
});

export function deactivate() {
  console.log('Prompt2Code deactivated');
}
