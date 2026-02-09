import axios from 'axios';
import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';

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

  /**
   * Approximate context-window sizes (input tokens) for Groq models.
   * We leave room for output (max_tokens) so the *input* budget is
   * windowSize − maxOutputTokens.
   */
  private static readonly MODEL_WINDOWS: Record<string, number> = {
    'llama-3.3-70b-versatile':   128_000,
    'llama-3.1-70b-versatile':   128_000,
    'llama-3.1-8b-instant':      8_000,      // free-tier TPM ≈ 6 000
    'llama-3.2-1b-preview':      8_000,
    'llama-3.2-3b-preview':      8_000,
    'mixtral-8x7b-32768':        32_768,
    'gemma2-9b-it':              8_000,
  };

  /** Human-friendly model metadata for the selector UI. */
  static readonly AVAILABLE_MODELS: { id: string; label: string; ctx: string }[] = [
    { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B',   ctx: '128K' },
    { id: 'llama-3.1-70b-versatile', label: 'Llama 3.1 70B',   ctx: '128K' },
    { id: 'llama-3.1-8b-instant',    label: 'Llama 3.1 8B',    ctx: '8K'   },
    { id: 'llama-3.2-1b-preview',    label: 'Llama 3.2 1B',    ctx: '8K'   },
    { id: 'llama-3.2-3b-preview',    label: 'Llama 3.2 3B',    ctx: '8K'   },
    { id: 'mixtral-8x7b-32768',      label: 'Mixtral 8x7B',    ctx: '32K'  },
    { id: 'gemma2-9b-it',            label: 'Gemma 2 9B',      ctx: '8K'   },
  ];

  /** Session-level model override (set by the UI model selector). */
  private _modelOverride: string | null = null;

  /** Set a session-level model override. Pass null to revert to settings. */
  setModelOverride(modelId: string | null): void {
    this._modelOverride = modelId;
  }

  /** Get the currently active model (override or settings). */
  getActiveModel(): string {
    return this._modelOverride ?? this.getConfig().model;
  }

  /** Rough chars-per-token ratio (≈ 3.5 for English code). */
  static estimateTokens(text: string): number {
    return Math.ceil(text.length / 3.5);
  }

  /**
   * Return the max *input* token budget for the current model,
   * i.e. window − maxOutputTokens, with a safety margin.
   * We reserve at least 50% of the window for output to prevent truncation.
   */
  getInputTokenBudget(): number {
    const cfg = this.getConfig();
    const window = GroqClient.MODEL_WINDOWS[cfg.model] ?? 8_000;
    const outputReserve = Math.min(cfg.maxTokens, Math.floor(window * 0.5));
    const safety = 200; // headroom for overhead
    return Math.max(window - outputReserve - safety, 1_000);
  }

  /**
   * Convenience: max *characters* of context the caller should provide.
   * This accounts for the system prompt + instruction overhead (~800 tokens).
   */
  getContextCharBudget(): number {
    const tokenBudget = this.getInputTokenBudget();
    const overheadTokens = 800; // system prompt + instruction + formatting
    return Math.max((tokenBudget - overheadTokens) * 3.5, 500);
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private getConfig() {
    const config = vscode.workspace.getConfiguration('prompt2code');
    const model = this._modelOverride ?? config.get<string>('model', 'llama-3.3-70b-versatile');

    // Resolve API key: per-model key > global fallback key
    const perModelKeys = config.get<Record<string, string>>('apiKeys', {});
    const globalKey = config.get<string>('apiKey', '');
    const apiKey = perModelKeys[model] || globalKey;

    return {
      apiKey,
      model,
      maxTokens: config.get<number>('maxTokens', 4096),
      temperature: config.get<number>('temperature', 0.2)
    };
  }

  /**
   * Resolve the API key for a specific model.
   * Checks per-model keys first, then falls back to global key.
   */
  getApiKeyForModel(modelId: string): string {
    const config = vscode.workspace.getConfiguration('prompt2code');
    const perModelKeys = config.get<Record<string, string>>('apiKeys', {});
    return perModelKeys[modelId] || config.get<string>('apiKey', '');
  }

  /**
   * Validate an API key by making a tiny request to Groq.
   * Returns true if the key is valid, false otherwise.
   */
  async validateApiKey(apiKey: string, modelId?: string): Promise<{ valid: boolean; error?: string }> {
    try {
      const response = await axios.post<GroqResponse>(
        this.baseUrl,
        {
          model: modelId || 'llama-3.1-8b-instant',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 1,
          temperature: 0,
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        }
      );
      return { valid: !!response.data?.choices?.length };
    } catch (error: any) {
      const status = error.response?.status;
      if (status === 401) {
        return { valid: false, error: 'Invalid API key — authentication failed.' };
      }
      if (status === 403) {
        return { valid: false, error: 'API key does not have permission.' };
      }
      return { valid: false, error: error.message || 'Validation request failed.' };
    }
  }

  private async requestCompletion(
    messages: GroqMessage[],
    options?: { maxTokens?: number; temperature?: number }
  ): Promise<GroqCompletionResult> {
    const config = this.getConfig();

    if (!config.apiKey) {
      vscode.window.showErrorMessage(
        'Groq API key not set. Configure prompt2code.apiKey in settings.'
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

  /**
   * Multi-file / long-form completion with automatic continuation.
   * Uses the same continuation strategy as generateCode() so that
   * large multi-file outputs are not truncated at maxTokens.
   */
  async completeWithContinuation(
    messages: GroqMessage[],
    options?: { maxContinuations?: number }
  ): Promise<string> {
    const config = this.getConfig();
    const inputTokens = GroqClient.estimateTokens(
      messages.map(m => m.content).join('')
    );
    const modelWindow = GroqClient.MODEL_WINDOWS[config.model] ?? 8_000;
    // Use a generous maxTokens — at least 8192, up to what the model allows
    const maxTokens = Math.min(
      Math.max(config.maxTokens ?? 0, 8192),
      Math.max(modelWindow - inputTokens - 200, 2048)
    );
    const MAX_CONTINUATIONS = options?.maxContinuations ?? 5;
    const ASSISTANT_CONTEXT_CHARS = 6000;

    let assembled = '';

    for (let attempt = 0; attempt < MAX_CONTINUATIONS; attempt++) {
      const callMessages: GroqMessage[] = attempt === 0
        ? messages
        : [
            ...messages,
            {
              role: 'assistant' as const,
              content: assembled.slice(-ASSISTANT_CONTEXT_CHARS)
            },
            {
              role: 'user' as const,
              content:
                'Continue generating the remaining files. Pick up EXACTLY where you left off.\n' +
                'Rules:\n' +
                '- Do NOT repeat any content already generated.\n' +
                '- Continue using the same ===FILE: path=== and ===END_FILE=== format.\n' +
                '- If you were in the middle of a file, continue that file first.\n' +
                '- Do NOT add any explanatory text.\n\n' +
                'The output so far ends with:\n' +
                assembled.slice(-1500)
            }
          ];

      const result = await this.requestCompletion(callMessages, { maxTokens });
      const piece = result.content;
      assembled = this.appendAvoidingOverlap(assembled, piece);

      // Stop if the model finished naturally (not cut off by token limit)
      if (result.finishReason !== 'length') {
        break;
      }
      console.log(`📄 Multi-file continuation ${attempt + 1}/${MAX_CONTINUATIONS} — output so far: ${assembled.length} chars`);
    }

    return assembled;
  }

  // ===========================
  // CODE GENERATION
  // ===========================
  async generateCode(
    instruction: string,
    language: string,
    context?: string
  ): Promise<string> {
    const systemPrompt = this.buildSystemPrompt(language, instruction);
    const baseMessages: GroqMessage[] = [
      {
        role: 'system',
        content: systemPrompt
      },
      {
        role: 'user',
        content: this.buildUserPrompt(instruction, language, context)
      }
    ];

    // Make code generation more robust for full-file outputs.
    const config = this.getConfig();
    const inputTokens = GroqClient.estimateTokens(
      baseMessages.map(m => m.content).join('')
    );
    const modelWindow = GroqClient.MODEL_WINDOWS[config.model] ?? 8_000;
    const maxTokens = Math.min(
      Math.max(config.maxTokens ?? 0, 2048),
      Math.max(modelWindow - inputTokens - 100, 512)
    );
    const MAX_CONTINUATIONS = 4;
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
  // SECTION / SELECTION EDITING
  // ===========================

  /**
   * Edit only a selected block of code. The AI receives:
   *  - the selected code to modify
   *  - some surrounding context lines (read-only)
   *  - the user instruction
   * and outputs ONLY the replacement for the selected block.
   */
  async generateSectionEdit(
    instruction: string,
    language: string,
    selectedCode: string,
    surroundingContext: string,
    onChunk: (accumulated: string) => void,
    extraContext?: string
  ): Promise<string> {
    const config = this.getConfig();

    if (!config.apiKey) {
      vscode.window.showErrorMessage(
        'Groq API key not set. Configure prompt2code.apiKey in settings.'
      );
      throw new Error('Missing Groq API key');
    }

    const systemPrompt = [
      `You are an expert ${language} developer performing a SURGICAL code edit.`,
      '',
      'RULES (FOLLOW EXACTLY):',
      '- You will receive a SELECTED CODE BLOCK and some SURROUNDING CONTEXT.',
      '- Output ONLY the replacement for the SELECTED CODE BLOCK.',
      '- Do NOT output the surrounding context — only the replacement for the selected part.',
      '- Do NOT add markdown, code fences, or explanations.',
      '- Maintain the same indentation level as the original selected code.',
      '- Keep all unchanged lines within the selection exactly as they are.',
      '- Apply ONLY what the user asked for. Do not refactor or restyle untouched code.',
    ].join('\n');

    let userPrompt = `Language: ${language}\nInstruction: ${instruction}\n\n`;
    userPrompt += '── SURROUNDING CONTEXT (read-only, do NOT output this) ──\n';
    userPrompt += surroundingContext;
    userPrompt += '\n\n── SELECTED CODE (output ONLY the replacement for this block) ──\n';
    userPrompt += selectedCode;
    userPrompt += '\n── END OF SELECTED CODE ──\n';

    if (extraContext) {
      const budget = Math.floor(this.getContextCharBudget() * 0.3);
      const trimmed = extraContext.length > budget
        ? extraContext.slice(0, budget) + '\n/* ...trimmed... */\n'
        : extraContext;
      userPrompt += '\nAdditional project context (reference only):\n' + trimmed;
    }

    userPrompt += '\n\nOutput ONLY the replacement code for the selected block. No markdown. No explanations.';

    const inputTokens = GroqClient.estimateTokens(systemPrompt + userPrompt);
    const modelWindow = GroqClient.MODEL_WINDOWS[config.model] ?? 8_000;
    const desiredOutput = Math.max(config.maxTokens ?? 0, 2048);
    const roomLeft = modelWindow - inputTokens - 100;
    const maxTokens = Math.min(desiredOutput, Math.max(roomLeft, 1500));

    const body = JSON.stringify({
      model: config.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      max_tokens: maxTokens,
      temperature: config.temperature,
      stream: true
    });

    let accumulated = '';

    await new Promise<void>((resolve, reject) => {
      const url = new URL(this.baseUrl);
      const options: https.RequestOptions = {
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream'
        }
      };

      const req = https.request(options, (res: http.IncomingMessage) => {
        if (res.statusCode && res.statusCode >= 400) {
          let errBody = '';
          res.on('data', (d: Buffer) => { errBody += d.toString(); });
          res.on('end', () => {
            reject(new Error(`Groq API error (${res.statusCode}): ${errBody}`));
          });
          return;
        }

        let buffer = '';
        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data: ')) { continue; }
            const data = trimmed.slice(6);
            if (data === '[DONE]') { continue; }
            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) {
                accumulated += delta;
                onChunk(accumulated);
              }
            } catch { /* skip */ }
          }
        });

        res.on('end', () => resolve());
        res.on('error', (e: Error) => reject(e));
      });

      req.on('error', (e: Error) => reject(e));
      req.write(body);
      req.end();
    });

    const cleaned = this.cleanResponse(accumulated);
    onChunk(cleaned);
    return cleaned;
  }

  // ===========================
  // STREAMING CODE GENERATION
  // ===========================

  /**
   * Generate code with streaming — calls `onChunk` with each text fragment
   * so the caller can update the editor in real time.
   *
   * @param currentFileContent — If provided, the AI is told to UPDATE this
   *   code rather than regenerate from scratch. Pass `undefined` for new-file
   *   generation or chat-only mode.
   */
  async generateCodeStreaming(
    instruction: string,
    language: string,
    onChunk: (accumulated: string) => void,
    context?: string,
    currentFileContent?: string
  ): Promise<string> {
    const config = this.getConfig();

    if (!config.apiKey) {
      vscode.window.showErrorMessage(
        'Groq API key not set. Configure prompt2code.apiKey in settings.'
      );
      throw new Error('Missing Groq API key');
    }

    const systemPrompt = this.buildSystemPrompt(language, instruction, !!currentFileContent);
    const userPrompt = this.buildUserPrompt(instruction, language, context, currentFileContent);

    // Ensure max_tokens doesn't exceed what the model can handle after input.
    // We guarantee a minimum output budget — if input is too big, the context
    // trimming in buildUserPrompt should have kept it in bounds, but we still
    // clamp here as a safety net.
    const inputTokens = GroqClient.estimateTokens(systemPrompt + userPrompt);
    const modelWindow = GroqClient.MODEL_WINDOWS[config.model] ?? 8_000;
    const desiredOutput = Math.max(config.maxTokens ?? 0, 2048);
    const roomLeft = modelWindow - inputTokens - 100;
    // Never go below 1500 tokens for output — that avoids truncated code
    const maxTokens = Math.min(desiredOutput, Math.max(roomLeft, 1500));

    const body = JSON.stringify({
      model: config.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      max_tokens: maxTokens,
      temperature: config.temperature,
      stream: true
    });

    let accumulated = '';

    await new Promise<void>((resolve, reject) => {
      const url = new URL(this.baseUrl);
      const options: https.RequestOptions = {
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream'
        }
      };

      const req = https.request(options, (res: http.IncomingMessage) => {
        if (res.statusCode && res.statusCode >= 400) {
          let errBody = '';
          res.on('data', (d: Buffer) => { errBody += d.toString(); });
          res.on('end', () => {
            reject(new Error(`Groq API error (${res.statusCode}): ${errBody}`));
          });
          return;
        }

        let buffer = '';

        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();

          // Process complete SSE lines
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // keep incomplete line in buffer

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data: ')) { continue; }

            const data = trimmed.slice(6); // strip "data: "
            if (data === '[DONE]') { continue; }

            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) {
                accumulated += delta;
                onChunk(accumulated);
              }
            } catch {
              // skip malformed JSON
            }
          }
        });

        res.on('end', () => resolve());
        res.on('error', (e: Error) => reject(e));
      });

      req.on('error', (e: Error) => reject(e));
      req.write(body);
      req.end();
    });

    // Clean the accumulated response (strip markdown fences if any)
    let cleaned = this.cleanResponse(accumulated);

    // ── Auto-continuation: if the output looks truncated, ask for more ──
    const MAX_CONTINUATIONS = 2;
    for (let cont = 0; cont < MAX_CONTINUATIONS; cont++) {
      if (!this.looksIncomplete(cleaned, language)) { break; }

      console.log(`🔄 Output looks truncated — sending continuation request ${cont + 1}`);

      const contPrompt = this.buildContinuationPrompt(cleaned);
      const contSystemPrompt = 'Continue the code output exactly where it left off. '
        + 'Output ONLY the remaining code. No markdown. No code fences. No explanations. '
        + 'Do NOT repeat any code that was already output.';

      const contInputTokens = GroqClient.estimateTokens(contSystemPrompt + contPrompt);
      const contMaxTokens = Math.min(
        desiredOutput,
        Math.max(modelWindow - contInputTokens - 100, 1500)
      );

      let contAccumulated = '';
      await new Promise<void>((resolve, reject) => {
        const contBody = JSON.stringify({
          model: config.model,
          messages: [
            { role: 'system', content: contSystemPrompt },
            { role: 'user', content: contPrompt }
          ],
          max_tokens: contMaxTokens,
          temperature: config.temperature,
          stream: true
        });

        const url = new URL(this.baseUrl);
        const contOptions: https.RequestOptions = {
          hostname: url.hostname,
          path: url.pathname,
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream'
          }
        };

        const contReq = https.request(contOptions, (res: http.IncomingMessage) => {
          if (res.statusCode && res.statusCode >= 400) {
            let errBody = '';
            res.on('data', (d: Buffer) => { errBody += d.toString(); });
            res.on('end', () => {
              console.warn(`Continuation request failed (${res.statusCode}): ${errBody}`);
              resolve(); // don't reject — return what we have
            });
            return;
          }

          let buffer = '';
          res.on('data', (chunk: Buffer) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || !trimmed.startsWith('data: ')) { continue; }
              const data = trimmed.slice(6);
              if (data === '[DONE]') { continue; }
              try {
                const parsed = JSON.parse(data);
                const delta = parsed.choices?.[0]?.delta?.content;
                if (delta) {
                  contAccumulated += delta;
                  // Update the editor with combined output
                  onChunk(cleaned + '\n' + this.cleanResponse(contAccumulated));
                }
              } catch { /* skip */ }
            }
          });
          res.on('end', () => resolve());
          res.on('error', () => resolve());
        });

        contReq.on('error', () => resolve());
        contReq.write(contBody);
        contReq.end();
      });

      if (contAccumulated.trim()) {
        const cleanedCont = this.cleanResponse(contAccumulated);
        cleaned = this.appendAvoidingOverlap(cleaned, '\n' + cleanedCont);
      }
    }

    onChunk(cleaned);
    return cleaned;
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

  /**
   * Heuristic: does the generated code look truncated / incomplete?
   * Checks for unclosed tags, braces, parentheses, etc.
   */
  private looksIncomplete(code: string, language: string): boolean {
    const trimmed = code.trim();
    if (!trimmed || trimmed.length < 50) { return false; }

    const lang = language.toLowerCase();

    // HTML: must end with </html> (allow trailing whitespace)
    if (lang === 'html' || lang === 'htm') {
      return !/<\/html\s*>\s*$/i.test(trimmed);
    }

    // JSX/TSX/React: check balanced braces and parens
    if (/react|jsx|tsx/i.test(lang)) {
      const opens = (trimmed.match(/[{(]/g) || []).length;
      const closes = (trimmed.match(/[})]/g) || []).length;
      return opens > closes;
    }

    // CSS/SCSS: check balanced braces
    if (lang === 'css' || lang === 'scss') {
      const opens = (trimmed.match(/{/g) || []).length;
      const closes = (trimmed.match(/}/g) || []).length;
      return opens > closes;
    }

    // JS/TS and general: check balanced braces + parens
    const opens = (trimmed.match(/[{([]/g) || []).length;
    const closes = (trimmed.match(/[})]/g) || []).length;
    return opens > closes;
  }

  // ===========================
  // PROMPT ENGINEERING
  // ===========================

  private buildSystemPrompt(language: string, instruction: string, isUpdate: boolean = false): string {
    const isUI = /\b(page|website|portfolio|landing|dashboard|form|card|navbar|header|footer|hero|section|layout|sidebar|modal|login|signup|register|profile|pricing|contact|about)\b/i.test(instruction);
    const isHTML = language.toLowerCase() === 'html';
    const isCSS = language.toLowerCase() === 'css' || language.toLowerCase() === 'scss';
    const isReact = /react|jsx|tsx/i.test(language);

    if (isHTML && isUI) {
      let prompt: string;

      if (isUpdate) {
        prompt = [
          'You are a senior front-end developer. You are in UPDATE MODE.',
          '',
          'CRITICAL UPDATE RULES (HIGHEST PRIORITY):',
          '- You will receive the CURRENT FILE CONTENT. You MUST modify/update it.',
          '- Do NOT regenerate the file from scratch.',
          '- Preserve ALL existing sections, styles, scripts, and content the user did NOT mention.',
          '- Apply ONLY the specific changes the user requested.',
          '- Output the COMPLETE updated file with your changes applied.',
          '',
          'OUTPUT RULES:',
          '- Output a COMPLETE HTML file (<!DOCTYPE html> to </html>).',
          '- ALL CSS inside <style>, ALL JS inside <script>.',
          '- No markdown. No code fences. Output ONLY raw HTML.',
        ].join('\n');
      } else {
        prompt = [
          'You are a senior front-end developer and UI/UX designer.',
          'You produce stunning, professional, production-ready HTML pages.',
          '',
          'OUTPUT RULES:',
          '- Output a COMPLETE, SINGLE HTML file with <!DOCTYPE html>, <html>, <head>, and <body>.',
          '- ALL CSS MUST be inside a <style> tag in <head>. Do NOT use external stylesheets.',
          '- ALL JavaScript MUST be inside a <script> tag before </body>. Do NOT use external scripts.',
          '- Do NOT output markdown. Do NOT wrap in code fences. Output ONLY raw HTML.',
        ].join('\n');
      }

      prompt += '\n' + [
        'DESIGN RULES (CRITICAL):',
        '- Use a modern, professional color palette (e.g., deep navy #0f172a, slate #1e293b, accent indigo #6366f1 or violet #8b5cf6, white text).',
        '- Implement FULL responsive design with CSS media queries for mobile (<768px), tablet, and desktop.',
        '- Use CSS Grid and/or Flexbox for all layouts — NEVER use float-based layouts.',
        '- Use modern CSS: border-radius, box-shadow, smooth transitions (0.3s ease), backdrop-filter for glassmorphism if appropriate.',
        '- Typography: Use a clean sans-serif font stack (system-ui, -apple-system, sans-serif) or import Google Fonts (Inter, Poppins, or similar).',
        '- Buttons must have hover effects (color shift, scale, or shadow).',
        '- Cards must have subtle shadows, rounded corners, and hover lift effects.',
        '- Use proper spacing: generous padding (2rem+), consistent margins, line-height 1.6+.',
        '- Navigation must be responsive with a hamburger menu on mobile.',
        '- Hero sections should be full-width with large headings, gradient or image backgrounds.',
        '- Forms must have styled inputs with focus states, proper labels, and visual feedback.',
        '- Use placeholder images from https://picsum.photos/ for any image placeholders.',
        '- Add smooth scroll behavior: html { scroll-behavior: smooth }.',
        '- Include a subtle gradient or pattern for backgrounds where appropriate.',
        '- Section padding should be at least 4rem top/bottom for breathing room.',
        '- Use CSS custom properties (variables) for colors and reusable values.',
        '',
        'The result must look like a professionally designed website, NOT a basic unstyled page.',
      ].join('\n');

      return prompt;
    }

    if (isCSS && isUI) {
      if (isUpdate) {
        return [
          'You are a senior CSS/UI designer. You are in UPDATE MODE.',
          '',
          'CRITICAL: Modify/update the CURRENT FILE CONTENT — do NOT regenerate from scratch.',
          'Preserve all existing styles the user did NOT ask to change.',
          'Apply ONLY the requested changes. Output the COMPLETE updated file.',
          '',
          'Use CSS Grid/Flexbox, custom properties, media queries, transitions, and shadows.',
          'Output ONLY valid CSS. No markdown. No explanations.',
        ].join('\n');
      }
      return [
        'You are a senior CSS/UI designer.',
        'Write modern, responsive, professional CSS.',
        'Use CSS Grid/Flexbox, custom properties, media queries, transitions, and shadows.',
        'Create visually polished, production-quality styles.',
        'Output ONLY valid CSS. No markdown. No explanations.',
      ].join('\n');
    }

    if (isReact && isUI) {
      if (isUpdate) {
        return [
          'You are a senior React developer. You are in UPDATE MODE.',
          '',
          'CRITICAL: Modify/update the CURRENT FILE CONTENT — do NOT regenerate from scratch.',
          'Preserve all existing components, hooks, state, and styles the user did NOT ask to change.',
          'Apply ONLY the requested changes. Output the COMPLETE updated file.',
          '',
          'Use functional components with hooks. Professional responsive UI.',
          'Output ONLY valid JSX/TSX code. No markdown. No explanations.',
        ].join('\n');
      }
      return [
        'You are a senior React developer and UI/UX designer.',
        'Generate a professional, responsive React component with inline styles or a <style> tag.',
        'Use functional components with hooks.',
        'Apply modern design: proper color palette, spacing, shadows, hover effects, responsive breakpoints.',
        'Use CSS-in-JS or inline style objects for all styling — do NOT reference external CSS files.',
        'For images use https://picsum.photos/ placeholder URLs.',
        'Output ONLY valid JSX/TSX code. No markdown. No explanations.',
      ].join('\n');
    }

    // Default for non-UI or other languages
    if (isUpdate) {
      return [
        `You are an expert ${language} developer. You are in UPDATE MODE.`,
        '',
        'CRITICAL UPDATE RULES (HIGHEST PRIORITY):',
        '- You will receive the CURRENT FILE CONTENT. You MUST modify/update it.',
        '- Do NOT regenerate the file from scratch.',
        '- Preserve ALL existing code, functions, logic, and structure the user did NOT mention.',
        '- Apply ONLY the specific changes the user requested.',
        '- Output the COMPLETE updated file with your changes applied.',
        '',
        'Match existing code style, naming conventions, and patterns.',
        'Use the same libraries and imports already present.',
        'Output ONLY valid code. No markdown. No explanations.',
      ].join('\n');
    }
    return [
      `You are an expert ${language} developer.`,
      'Generate clean, well-structured, responsive, production-ready code following industry best practices.',
      'You will receive existing project files as context — study them carefully and:',
      '- Match the existing code style, naming conventions, and patterns.',
      '- Use the same libraries, frameworks, and imports already present in the project.',
      '- Follow the project\'s directory structure conventions.',
      '- Reuse existing utility functions or components when possible.',
      'Output ONLY valid code. No markdown. No explanations.',
    ].join('\n');
  }

  private buildUserPrompt(
    instruction: string,
    language: string,
    context?: string,
    currentFileContent?: string
  ): string {
    const lang = language.toLowerCase();
    const isUI = /\b(page|website|portfolio|landing|dashboard|form|card|navbar|header|footer|hero|section|layout|sidebar|modal|login|signup|register|profile|pricing|contact|about)\b/i.test(instruction);

    let prompt = `Language: ${language}\nInstruction: ${instruction}\n\nConstraints:\n`;

    switch (lang) {
      case 'html':
        if (isUI) {
          prompt += [
            '- Output a COMPLETE standalone HTML file (<!DOCTYPE html> to </html>).',
            '- Embed ALL CSS in <style> and ALL JS in <script>.',
            '- Must be fully responsive (mobile-first, media queries for 768px and 1024px breakpoints).',
            '- Use a cohesive, modern color palette with CSS custom properties.',
            '- Professional typography with proper font sizes (clamp() for fluid type).',
            '- All interactive elements must have hover/focus states.',
            '- Use semantic HTML5 elements (header, nav, main, section, footer).',
            '- Include aria-labels for accessibility.',
            '- Cards/sections need box-shadow, border-radius, and transition effects.',
            '- Use Flexbox/Grid for layout — no tables for layout, no floats.',
            '- Minimum 5 sections for a full page (hero, features/skills, projects/work, about, contact/footer).',
            '- Navigation bar must collapse to hamburger on mobile.',
            '- Smooth scroll between sections.',
            '- Use https://picsum.photos/600/400 for placeholder images.',
          ].join('\n');
        } else {
          prompt += '- Use semantic HTML5\n- Include accessibility attributes\n- Clean structure\n';
        }
        break;
      case 'css':
      case 'scss':
        prompt += [
          '- Responsive design with mobile-first approach.',
          '- CSS Grid and Flexbox for layouts.',
          '- CSS custom properties for theming.',
          '- Smooth transitions and hover effects.',
          '- Consistent spacing scale.',
        ].join('\n');
        break;
      case 'javascript':
      case 'typescript':
        prompt += '- Use modern ES6+ syntax\n- Follow best practices\n- Clean, readable code\n';
        break;
      case 'javascriptreact':
      case 'typescriptreact':
        if (isUI) {
          prompt += [
            '- React functional component with hooks.',
            '- Professional responsive UI with inline styles or embedded <style>.',
            '- Modern color palette, shadows, rounded corners, hover effects.',
            '- Mobile-first responsive design.',
            '- Use https://picsum.photos/ for placeholder images.',
          ].join('\n');
        } else {
          prompt += '- Use React functional components with hooks\n- Follow React best practices\n';
        }
        break;
      default:
        prompt += '- Follow language best practices\n- Clean, well-structured code\n';
        break;
    }

    // ── Current file content (UPDATE mode): placed first, prominently ──
    if (currentFileContent) {
      const charBudget = this.getContextCharBudget();
      // Reserve 60% of context budget for the current file, 40% for other context
      const fileBudget = Math.floor(charBudget * 0.6);
      const trimmedFile = currentFileContent.length > fileBudget
        ? currentFileContent.slice(0, fileBudget) + '\n/* ...file truncated to fit model limits... */\n'
        : currentFileContent;

      prompt += '\n\n========== CURRENT FILE CONTENT (MODIFY THIS — DO NOT REWRITE FROM SCRATCH) ==========\n'
        + 'The code below is the EXISTING file in the editor. Your job is to UPDATE it.\n'
        + 'RULES:\n'
        + '1. Read the user\'s instruction and apply ONLY those changes.\n'
        + '2. Keep ALL existing code, structure, and content that was NOT mentioned by the user.\n'
        + '3. Output the COMPLETE file with your modifications applied (not a diff or snippet).\n'
        + '4. Do NOT start a brand new file. Do NOT delete sections the user did not ask to remove.\n'
        + '======================================================================================\n\n';
      prompt += trimmedFile;
      prompt += '\n\n========== END OF CURRENT FILE ==========\n';

      // Add remaining context with reduced budget
      if (context) {
        const ctxBudget = Math.floor(charBudget * 0.4);
        const trimmedContext = context.length > ctxBudget
          ? context.slice(0, ctxBudget) + '\n/* ...context trimmed... */\n'
          : context;
        prompt += '\nAdditional project context (for reference only — do NOT copy structure from these, just match patterns):\n';
        prompt += trimmedContext;
      }
    } else if (context) {
      // New-file / generate mode: context as before
      const charBudget = this.getContextCharBudget();
      const trimmedContext = context.length > charBudget
        ? context.slice(0, charBudget) + '\n/* ...context trimmed to fit model limits... */\n'
        : context;

      prompt += '\n\nIMPORTANT: The following project files are provided as context. '
        + 'Study the existing code patterns, naming conventions, imports, and frameworks. '
        + 'Your output MUST be consistent with the codebase.\n\n';
      prompt += `Context:\n${trimmedContext}`;
    }

    return prompt;
  }
}
