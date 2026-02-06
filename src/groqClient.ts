import axios from 'axios';
import * as vscode from 'vscode';

export interface GroqMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GroqRequest {
  model: string;
  messages: GroqMessage[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
}

export interface GroqResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    index: number;
    message: GroqMessage;
    finish_reason: string;
  }[];
}

interface GroqCompletionResult {
  content: string;
  finishReason?: string;
}

export class GroqClient {
  private readonly baseUrl =
    'https://api.groq.com/openai/v1/chat/completions';

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private getConfig() {
    const config = vscode.workspace.getConfiguration('groq');
    return {
      apiKey: config.get<string>('apiKey', ''),
      // Keep this aligned with package.json default.
      model: config.get<string>('model', 'llama-3.3-70b-versatile'),
      maxTokens: config.get<number>('maxTokens', 2048),
      temperature: config.get<number>('temperature', 0.2)
    };
  }

  private async requestCompletion(
    messages: GroqMessage[],
    options?: { maxTokens?: number; temperature?: number }
  ): Promise<GroqCompletionResult> {
    const config = this.getConfig();

    if (!config.apiKey) {
      vscode.window.showErrorMessage(
        'Groq API key not set. Configure groq.apiKey in settings.'
      );
      throw new Error('Missing Groq API key');
    }

    const request: GroqRequest = {
      model: config.model,
      messages,
      max_tokens: options?.maxTokens ?? config.maxTokens,
      temperature: options?.temperature ?? config.temperature,
      stream: false
    };

    const MAX_RETRIES = 3;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await axios.post<GroqResponse>(
          this.baseUrl,
          request,
          {
            headers: {
              Authorization: `Bearer ${config.apiKey}`,
              'Content-Type': 'application/json'
            },
            timeout: 30000
          }
        );

        const choice = response.data?.choices?.[0];
        const content = choice?.message?.content;

        if (!content || !content.trim()) {
          throw new Error('Groq returned an empty response');
        }

        return {
          content,
          finishReason: choice?.finish_reason
        };

      } catch (error: any) {
        if (!axios.isAxiosError(error)) {
          vscode.window.showErrorMessage(
            'Unexpected error communicating with Groq.'
          );
          throw error;
        }

        const status = error.response?.status;
        const code = (error as any).code as string | undefined;
        const apiMessage =
          (error.response as any)?.data?.error?.message || error.message;

        const isRateLimit = status === 429;
        const isTransientNetwork =
          !status &&
          (code === 'ENOTFOUND' ||
            code === 'ECONNRESET' ||
            code === 'ETIMEDOUT' ||
            code === 'EAI_AGAIN');

        const canRetry = attempt < MAX_RETRIES && (isRateLimit || isTransientNetwork);

        if (canRetry) {
          let backoffMs = 500 * Math.pow(2, attempt);

          if (isRateLimit) {
            const retryAfterHeader = error.response?.headers?.['retry-after'];
            const retryAfterSeconds = Number(retryAfterHeader);
            if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
              backoffMs = Math.max(backoffMs, retryAfterSeconds * 1000);
            }
          }

          await this.sleep(backoffMs);
          continue;
        }

        // Final failure: show the most useful message.
        if (!status) {
          vscode.window.showErrorMessage(
            `Groq network error${code ? ` (${code})` : ''}: ${apiMessage}. Check internet/DNS/proxy settings.`
          );
        } else {
          vscode.window.showErrorMessage(
            `Groq API error (${status}): ${apiMessage}`
          );
        }

        throw error;
      }
    }

    // Unreachable, but TS needs a return.
    throw new Error('Groq request failed after retries');
  }

  // ===========================
  // CHAT COMPLETION
  // ===========================
  async complete(
    messages: GroqMessage[],
    cleanMarkdown = false
  ): Promise<string> {
    const result = await this.requestCompletion(messages);
    return cleanMarkdown ? this.cleanResponse(result.content) : result.content;
  }

  // ===========================
  // CODE GENERATION
  // ===========================
  async generateCode(
    instruction: string,
    language: string,
    context?: string
  ): Promise<string> {
    const baseMessages: GroqMessage[] = [
      {
        role: 'system',
        content: `You are an expert ${language} developer. Generate clean, production-ready code. Output ONLY valid code. No markdown. No explanations.`
      },
      {
        role: 'user',
        content: this.buildUserPrompt(instruction, language, context)
      }
    ];

    // Make code generation more robust for full-file outputs.
    const config = this.getConfig();
    const maxTokens = Math.max(config.maxTokens ?? 0, 2048);
    const MAX_CONTINUATIONS = 3;
    const ASSISTANT_CONTEXT_CHARS = 6000;

    let assembled = '';

    for (let attempt = 0; attempt < MAX_CONTINUATIONS; attempt++) {
      const messages: GroqMessage[] = attempt === 0
        ? baseMessages
        : [
            ...baseMessages,
            {
              role: 'assistant',
              content: assembled.slice(-ASSISTANT_CONTEXT_CHARS)
            },
            {
              role: 'user',
              content: this.buildContinuationPrompt(assembled)
            }
          ];

      const result = await this.requestCompletion(messages, { maxTokens });
      const piece = this.cleanResponse(result.content);
      assembled = this.appendAvoidingOverlap(assembled, piece);

      if (result.finishReason !== 'length') {
        break;
      }
    }

    return assembled.trim();
  }

  // ===========================
  // INLINE COMPLETION
  // ===========================
  async inlineComplete(
    prefix: string,
    suffix: string,
    language: string
  ): Promise<string> {
    const messages: GroqMessage[] = [
      {
        role: 'system',
        content:
          'You are a code completion assistant. Output ONLY the missing code. No markdown. No explanations.'
      },
      {
        role: 'user',
        content: `Language: ${language}

Code before cursor:
${prefix}

Code after cursor:
${suffix}

Complete the code at the cursor position.`
      }
    ];

    return this.complete(messages, true);
  }

  // ===========================
  // HELPERS
  // ===========================
  private cleanResponse(text: string): string {
    const trimmed = text.trim();

    // If the model replied with a fenced code block, unwrap it (keep the code).
    // Prefer the *first* fenced block.
    const fenced = trimmed.match(/```(?:[a-zA-Z0-9_+-]+)?\s*\n([\s\S]*?)\n```/);
    if (fenced?.[1]) {
      return fenced[1].trim();
    }

    // If it used backticks without a trailing newline before closing fence.
    const fencedInline = trimmed.match(/```(?:[a-zA-Z0-9_+-]+)?\s*([\s\S]*?)```/);
    if (fencedInline?.[1]) {
      return fencedInline[1].trim();
    }

    return trimmed;
  }

  private buildContinuationPrompt(current: string): string {
    const tail = current.slice(-1200);
    return (
      'Continue the code output.\n' +
      'Rules:\n' +
      '- Output ONLY code.\n' +
      '- Do NOT use markdown or code fences.\n' +
      '- Do NOT repeat anything already output.\n' +
      '- Continue exactly after the last character.\n\n' +
      'The output so far ends with:\n' +
      tail
    );
  }

  private appendAvoidingOverlap(current: string, addition: string): string {
    if (!current) return addition;
    if (!addition) return current;

    const maxOverlap = Math.min(500, current.length, addition.length);
    for (let overlap = maxOverlap; overlap > 0; overlap--) {
      if (current.endsWith(addition.slice(0, overlap))) {
        return current + addition.slice(overlap);
      }
    }
    return current + addition;
  }

  private buildUserPrompt(
    instruction: string,
    language: string,
    context?: string
  ): string {
    let prompt = `Language: ${language}
Instruction: ${instruction}

Constraints:
`;

    switch (language.toLowerCase()) {
      case 'html':
        prompt +=
          '- Use semantic HTML\n- Include accessibility attributes\n';
        break;
      case 'javascript':
      case 'typescript':
        prompt +=
          '- Use modern ES6+ syntax\n- Follow best practices\n';
        break;
      case 'javascriptreact':
      case 'typescriptreact':
        prompt +=
          '- Use React functional components\n- Follow React best practices\n';
        break;
      case 'css':
        prompt +=
          '- Responsive layout\n- Clean modern CSS\n';
        break;
    }

    if (context) {
      prompt += `\nContext:\n${context}`;
    }

    return prompt;
  }
}
