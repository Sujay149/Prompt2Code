import * as vscode from 'vscode';
import * as path from 'path';
import { GroqClient } from './groqClient';
import { InstructionDetector, InstructionMatch } from './instructionDetector';
import { PromptBuilder } from './promptBuilder';
import { ChatViewProvider } from './chatViewProvider';
import { GoogleAuthProvider } from './authProvider';
import { createWorkspaceFile, buildProjectTree, gatherProjectContext } from './workspaceHelper';

let groqClient: GroqClient;
let instructionDetector: InstructionDetector;
let promptBuilder: PromptBuilder;
let inlineCompletionsEnabled = true;
let statusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
  console.log('Prompt2Code is now active');

  // Initialize services
  groqClient = new GroqClient();
  instructionDetector = new InstructionDetector();
  promptBuilder = new PromptBuilder();

  // Status bar item for generation progress
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.text = '$(loading~spin) Prompt2Code: Working…';
  context.subscriptions.push(statusBarItem);

  // Register chat view provider
  const chatViewProvider = new ChatViewProvider(context.extensionUri);

  // Google Auth
  const authProvider = new GoogleAuthProvider(context);
  chatViewProvider.setAuthProvider(authProvider);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewType,
      chatViewProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // Register sign-in / sign-out commands
  context.subscriptions.push(
    vscode.commands.registerCommand('prompt2code.signIn', async () => {
      const user = await authProvider.signIn();
      if (user) {
        vscode.window.showInformationMessage(`Signed in as ${user.name}`);
      }
    }),
    vscode.commands.registerCommand('prompt2code.signOut', async () => {
      await authProvider.signOut();
      vscode.window.showInformationMessage('Signed out of Prompt2Code');
    })
  );

  // Register commands
  registerCommands(context);

  // Register inline completion provider
  registerInlineCompletionProvider(context);

  // Register auto-trigger on comment completion
  registerAutoTrigger(context);

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

      // Show progress with streaming
      statusBarItem.show();
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: '$(loading~spin) Prompt2Code: Generating code…',
          cancellable: false
        },
        async (progress) => {
          try {
            // Get surrounding context + auto-scanned project files
            const localCtx = promptBuilder.buildContext(document, position);

            const projectCtx = await gatherProjectContext({
              languageId: document.languageId,
              currentFilePath: document.uri.fsPath,
              maxChars: Math.min(groqClient.getContextCharBudget(), 30_000),
              maxFiles: 8,
            });

            const ctx = projectCtx.text
              ? `${localCtx}\n\n${projectCtx.text}`
              : localCtx;

            // Replace the instruction range with a placeholder first
            await editor.edit(editBuilder => {
              editBuilder.replace(instructionMatch!.range, '<!-- ⏳ Generating code… -->\n');
            });

            // Serialised editor updates — only one edit in-flight at a time
            let pendingText: string | null = null;
            let lastLength = 0;
            let editBusy = false;

            const applyPending = async () => {
              if (editBusy || pendingText === null) { return; }
              editBusy = true;
              const text = pendingText;
              pendingText = null;
              try {
                const r = new vscode.Range(
                  document.positionAt(0),
                  document.positionAt(document.getText().length)
                );
                await editor.edit(eb => {
                  eb.replace(r, text);
                }, { undoStopBefore: false, undoStopAfter: false });
              } catch { /* editor busy, retry next round */ }
              editBusy = false;
              if (pendingText !== null) { applyPending(); }
            };

            // Stream code directly into the editor
            const generatedCode = await groqClient.generateCodeStreaming(
              instructionMatch!.instruction,
              instructionMatch!.language,
              (accumulated) => {
                if (accumulated.length - lastLength < 200) { return; }
                lastLength = accumulated.length;
                progress.report({ message: `${accumulated.length} chars received…` });
                pendingText = accumulated;
                applyPending();
              },
              ctx
            );

            // Wait for any in-flight edit before final write
            while (editBusy) { await new Promise(r => setTimeout(r, 80)); }

            // Final write — retry up to 3 times
            for (let attempt = 0; attempt < 3; attempt++) {
              const r = new vscode.Range(
                document.positionAt(0),
                document.positionAt(document.getText().length)
              );
              const ok = await editor.edit(eb => {
                eb.replace(r, generatedCode);
              });
              if (ok) { break; }
              await new Promise(r => setTimeout(r, 120));
            }

            // Format the document
            await vscode.commands.executeCommand('editor.action.formatDocument');

            vscode.window.showInformationMessage('Prompt2Code: Code generated ✅');

          } catch (error) {
            console.error('Error generating code:', error);
            vscode.window.showErrorMessage('Failed to generate code. Please check your API key and try again.');
          } finally {
            statusBarItem.hide();
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

  // Command: Create a new file with AI-generated content
  const createFileCommand = vscode.commands.registerCommand('prompt2code.createFile', async () => {
    const fileName = await vscode.window.showInputBox({
      prompt: 'File path (relative to workspace root)',
      placeHolder: 'e.g. src/components/Button.tsx',
    });
    if (!fileName) { return; }

    const instruction = await vscode.window.showInputBox({
      prompt: 'Describe what this file should contain',
      placeHolder: 'e.g. a reusable button component with primary/secondary variants',
    });
    if (!instruction) { return; }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Creating ${fileName}...`, cancellable: false },
      async () => {
        try {
          const ext = path.extname(fileName).slice(1) || 'txt';
          const langMap: Record<string, string> = {
            ts: 'typescript', tsx: 'typescriptreact', js: 'javascript', jsx: 'javascriptreact',
            html: 'html', css: 'css', scss: 'scss', py: 'python', java: 'java',
            json: 'json', md: 'markdown', sql: 'sql', go: 'go', rs: 'rust',
          };
          const language = langMap[ext] || ext;

          // Gather project context so AI can match existing code patterns
          const projectCtx = await gatherProjectContext({
            languageId: language,
            maxChars: Math.min(groqClient.getContextCharBudget(), 30_000),
            maxFiles: 8,
          });
          const context = projectCtx.text || `Project files:\n${await buildProjectTree()}`;

          const code = await groqClient.generateCode(instruction, language, context);
          await createWorkspaceFile(fileName, code);
          vscode.window.showInformationMessage(`Created ${fileName}`);
        } catch (err: any) {
          vscode.window.showErrorMessage(`Failed to create file: ${err.message}`);
        }
      }
    );
  });

  context.subscriptions.push(generateCodeCommand, enableInlineCommand, disableInlineCommand, openChatCommand, createFileCommand);
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
    supportedLanguages.map(lang => ({ language: lang, scheme: 'file' })),
    provider
  );

  context.subscriptions.push(disposable);
}

function registerAutoTrigger(context: vscode.ExtensionContext) {
// Add automatic trigger on comment completion
context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(async (event) => {
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
}));
}

export function deactivate() {
  console.log('Prompt2Code deactivated');
}
