import axios from 'axios';
import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';

export interface GroqMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | GroqContentPart[];
}

/** Multimodal content part for vision messages */
export type GroqContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

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

  private static readonly OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

  /**
   * Map internal model IDs to OpenRouter model IDs.
   * OpenRouter uses provider-prefixed model names.
   */
  private static readonly OPENROUTER_MODEL_MAP: Record<string, string> = {
    // Groq-hosted models → OpenRouter equivalents
    'llama-3.3-70b-versatile':   'meta-llama/llama-3.3-70b-instruct',
    'llama-3.1-70b-versatile':   'meta-llama/llama-3.1-70b-instruct',
    'llama-3.1-8b-instant':      'meta-llama/llama-3.1-8b-instruct',
    'llama-3.2-1b-preview':      'meta-llama/llama-3.2-1b-instruct',
    'llama-3.2-3b-preview':      'meta-llama/llama-3.2-3b-instruct',
    'mixtral-8x7b-32768':        'mistralai/mixtral-8x7b-instruct',
    'gemma2-9b-it':              'google/gemma-2-9b-it',
    'meta-llama/llama-4-scout-17b-16e-instruct': 'meta-llama/llama-4-scout-17b-16e-instruct',
    'openai/gpt-oss-120b':       'openai/gpt-oss-120b',
    'openai/gpt-oss-20b':        'openai/gpt-oss-20b',
    // OpenAI
    'gpt-4o':      'openai/gpt-4o',
    'gpt-4o-mini': 'openai/gpt-4o-mini',
    'o1-mini':     'openai/o1-mini',
    'o3-mini':     'openai/o3-mini',
    // Anthropic
    'claude-opus-4-20250514':     'anthropic/claude-opus-4',
    'claude-sonnet-4-20250514':   'anthropic/claude-sonnet-4',
    'claude-3-5-haiku-20241022':  'anthropic/claude-3.5-haiku',
    'claude-3-5-sonnet-20241022': 'anthropic/claude-3.5-sonnet',
    // Gemini
    'gemini-2.0-flash': 'google/gemini-2.0-flash-001',
    'gemini-1.5-pro':   'google/gemini-pro-1.5',
    'gemini-1.5-flash': 'google/gemini-flash-1.5',
  };

  /** Check if an API key is an OpenRouter key. */
  private static isOpenRouterKey(apiKey: string): boolean {
    return apiKey.trim().startsWith('sk-or-');
  }

  /** Map an internal model ID to the OpenRouter equivalent. */
  private static toOpenRouterModel(modelId: string): string {
    return GroqClient.OPENROUTER_MODEL_MAP[modelId] || modelId;
  }

  /**
   * Approximate context-window sizes (input tokens) for Groq models.
   * We leave room for output (max_tokens) so the *input* budget is
   * windowSize − maxOutputTokens.
   */
  /** Vision model used for image-to-code */
  static readonly VISION_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';

  private static readonly MODEL_WINDOWS: Record<string, number> = {
    // Groq
    'llama-3.3-70b-versatile':   128_000,
    'llama-3.1-70b-versatile':   128_000,
    'llama-3.1-8b-instant':      8_000,
    'llama-3.2-1b-preview':      8_000,
    'llama-3.2-3b-preview':      8_000,
    'mixtral-8x7b-32768':        32_768,
    'gemma2-9b-it':              8_000,
    'meta-llama/llama-4-scout-17b-16e-instruct': 128_000,
    'openai/gpt-oss-120b':       131_072,
    'openai/gpt-oss-20b':        131_072,
    // OpenAI
    'gpt-4o':                    128_000,
    'gpt-4o-mini':               128_000,
    'o1-mini':                   128_000,
    'o3-mini':                   200_000,
    // Anthropic
    'claude-opus-4-20250514':     200_000,
    'claude-sonnet-4-20250514':   200_000,
    'claude-3-5-haiku-20241022':  200_000,
    'claude-3-5-sonnet-20241022': 200_000,
    // Gemini
    'gemini-2.0-flash':    1_000_000,
    'gemini-1.5-pro':      2_000_000,
    'gemini-1.5-flash':    1_000_000,
  };

  /** Special model ID for automatic model selection with fallback. */
  static readonly AUTO_MODEL_ID = 'auto';

  /**
   * Fallback priority chain for Auto mode.
   * When a model fails, the next in the list is tried.
   * Ordered by capability / quality (best first).
   */
  static readonly AUTO_FALLBACK_CHAIN: string[] = [
    'claude-sonnet-4-20250514',
    'gpt-4o',
    'gemini-2.0-flash',
    'llama-3.3-70b-versatile',
    'claude-3-5-sonnet-20241022',
    'gpt-4o-mini',
    'o3-mini',
    'claude-3-5-haiku-20241022',
    'gemini-1.5-pro',
    'gemini-1.5-flash',
    'llama-3.1-70b-versatile',
    'llama-3.1-8b-instant',
    'mixtral-8x7b-32768',
    'gemma2-9b-it',
    'openai/gpt-oss-120b',
    'openai/gpt-oss-20b',
    'llama-3.2-3b-preview',
    'llama-3.2-1b-preview',
  ];

  /** Human-friendly model metadata for the selector UI. */
  static readonly AVAILABLE_MODELS: { id: string; label: string; ctx: string; provider: string }[] = [
    // ── Groq ──
    { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B',   ctx: '128K', provider: 'groq' },
    { id: 'llama-3.1-70b-versatile', label: 'Llama 3.1 70B',   ctx: '128K', provider: 'groq' },
    { id: 'llama-3.1-8b-instant',    label: 'Llama 3.1 8B',    ctx: '8K',   provider: 'groq' },
    { id: 'llama-3.2-1b-preview',    label: 'Llama 3.2 1B',    ctx: '8K',   provider: 'groq' },
    { id: 'llama-3.2-3b-preview',    label: 'Llama 3.2 3B',    ctx: '8K',   provider: 'groq' },
    { id: 'mixtral-8x7b-32768',      label: 'Mixtral 8x7B',    ctx: '32K',  provider: 'groq' },
    { id: 'gemma2-9b-it',            label: 'Gemma 2 9B',      ctx: '8K',   provider: 'groq' },
    { id: 'openai/gpt-oss-120b',     label: 'GPT-OSS 120B',    ctx: '128K', provider: 'groq' },
    { id: 'openai/gpt-oss-20b',      label: 'GPT-OSS 20B',     ctx: '128K', provider: 'groq' },
    { id: 'meta-llama/llama-4-scout-17b-16e-instruct', label: 'Llama 4 Scout (Vision)', ctx: '128K', provider: 'groq' },
    // ── OpenAI ──
    { id: 'gpt-4o',      label: 'GPT-4o',       ctx: '128K', provider: 'openai' },
    { id: 'gpt-4o-mini', label: 'GPT-4o Mini',  ctx: '128K', provider: 'openai' },
    { id: 'o1-mini',     label: 'o1 Mini',       ctx: '128K', provider: 'openai' },
    { id: 'o3-mini',     label: 'o3 Mini',       ctx: '200K', provider: 'openai' },
    // ── Anthropic ──
    { id: 'claude-opus-4-20250514',     label: 'Claude Opus 4',     ctx: '200K', provider: 'anthropic' },
    { id: 'claude-sonnet-4-20250514',   label: 'Claude Sonnet 4',   ctx: '200K', provider: 'anthropic' },
    { id: 'claude-3-5-haiku-20241022',  label: 'Claude 3.5 Haiku',  ctx: '200K', provider: 'anthropic' },
    { id: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet', ctx: '200K', provider: 'anthropic' },
    // ── Google Gemini ──
    { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', ctx: '1M',  provider: 'gemini' },
    { id: 'gemini-1.5-pro',   label: 'Gemini 1.5 Pro',   ctx: '2M',  provider: 'gemini' },
    { id: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash',  ctx: '1M',  provider: 'gemini' },
  ];

  /** Return the provider for a given model ID. */
  static getProviderForModel(modelId: string): string {
    return GroqClient.AVAILABLE_MODELS.find(m => m.id === modelId)?.provider ?? 'groq';
  }

  /** Return provider display name, API key signup URL, and key placeholder. */
  static getProviderMeta(provider: string): { name: string; apiKeyUrl: string; placeholder: string } {
    switch (provider) {
      case 'openai':    return { name: 'OpenAI',        apiKeyUrl: 'https://platform.openai.com/api-keys',               placeholder: 'sk-…' };
      case 'anthropic': return { name: 'Anthropic',     apiKeyUrl: 'https://console.anthropic.com/settings/keys',        placeholder: 'sk-ant-…' };
      case 'gemini':    return { name: 'Google Gemini', apiKeyUrl: 'https://aistudio.google.com/app/apikey',             placeholder: 'AIza…' };
      default:          return { name: 'Groq',          apiKeyUrl: 'https://console.groq.com',                           placeholder: 'gsk_…' };
    }
  }

  /** Session-level model override (set by the UI model selector). */
  private _modelOverride: string | null = null;

  /** The model that was actually used in the last Auto-mode request. */
  private _lastResolvedModel: string | null = null;

  /** Set a session-level model override. Pass null to revert to settings. */
  setModelOverride(modelId: string | null): void {
    this._modelOverride = modelId;
  }

  /** Get the currently active model (override or settings). May be 'auto'. */
  getActiveModel(): string {
    return this._modelOverride ?? this.getConfig().model;
  }

  /** After an Auto-mode request, returns which model was actually used. */
  getLastResolvedModel(): string | null {
    return this._lastResolvedModel;
  }

  /** Check if current selection is Auto mode. */
  isAutoMode(): boolean {
    return this.getActiveModel() === GroqClient.AUTO_MODEL_ID;
  }

  /**
   * Resolve the Auto model: return the first model in the fallback chain
   * that has an API key configured. If none found, returns the first in chain.
   */
  resolveAutoModel(): string {
    for (const modelId of GroqClient.AUTO_FALLBACK_CHAIN) {
      const key = this.getApiKeyForModel(modelId);
      if (key && key.trim()) {
        return modelId;
      }
    }
    // Fallback: return first model (will prompt for key)
    return GroqClient.AUTO_FALLBACK_CHAIN[0];
  }

  /**
   * Get the fallback chain starting after a given model.
   * Only returns models that have API keys configured.
   */
  getFallbackModels(afterModel: string): string[] {
    const chain = GroqClient.AUTO_FALLBACK_CHAIN;
    const idx = chain.indexOf(afterModel);
    const remaining = idx >= 0 ? chain.slice(idx + 1) : chain;
    return remaining.filter(m => {
      const key = this.getApiKeyForModel(m);
      return key && key.trim() && m !== afterModel;
    });
  }

  /** Rough chars-per-token ratio (≈ 3.5 for English code). */
  static estimateTokens(text: string): number {
    return Math.ceil(text.length / 3.5);
  }

  /** Safely extract text content from a message's content field. */
  private static contentToString(content: string | GroqContentPart[]): string {
    if (typeof content === 'string') { return content; }
    return content
      .filter(p => p.type === 'text')
      .map(p => (p as { type: 'text'; text: string }).text)
      .join(' ');
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

  private getConfig(overrideModelId?: string) {
    const config = vscode.workspace.getConfiguration('prompt2code');
    let model = overrideModelId ?? this._modelOverride ?? config.get<string>('model', 'llama-3.3-70b-versatile');

    // Resolve 'auto' to the best available model
    if (model === GroqClient.AUTO_MODEL_ID) {
      model = this.resolveAutoModel();
    }

    const provider = GroqClient.getProviderForModel(model);

    // Resolve API key: per-model key > global fallback key
    const perModelKeys = config.get<Record<string, string>>('apiKeys', {});
    const globalKey = config.get<string>('apiKey', '');
    const apiKey = perModelKeys[model] || globalKey;

    // Provider-specific completion URL (OpenAI uses the same SSE/REST format as Groq)
    const baseUrl = provider === 'openai'
      ? 'https://api.openai.com/v1/chat/completions'
      : this.baseUrl;

    return {
      apiKey,
      model,
      provider,
      baseUrl,
      maxTokens: config.get<number>('maxTokens', 4096),
      temperature: config.get<number>('temperature', 0.2)
    };
  }

  /**
   * Resolve the API key for a specific model.
   * Checks per-model keys first, then falls back to global key.
   * Used at inference time so any model can pick up the global fallback key.
   */
  getApiKeyForModel(modelId: string): string {
    const config = vscode.workspace.getConfiguration('prompt2code');
    const perModelKeys = config.get<Record<string, string>>('apiKeys', {});
    return perModelKeys[modelId] || config.get<string>('apiKey', '');
  }

  /**
   * Return ONLY the explicitly saved per-model key — no global fallback.
   * Used by the settings modal so models without explicit keys show blank.
   */
  getExplicitApiKeyForModel(modelId: string): string {
    const config = vscode.workspace.getConfiguration('prompt2code');
    const perModelKeys = config.get<Record<string, string>>('apiKeys', {});
    return perModelKeys[modelId] ?? '';
  }

  /**
   * Validate an API key by routing to the correct provider endpoint.
   */
  async validateApiKey(apiKey: string, modelId?: string): Promise<{ valid: boolean; error?: string }> {
    const provider = GroqClient.getProviderForModel(modelId ?? 'llama-3.1-8b-instant');
    try {
      // OpenRouter keys: validate via OpenRouter regardless of selected model
      if (GroqClient.isOpenRouterKey(apiKey)) {
        const orModel = GroqClient.toOpenRouterModel(modelId || 'meta-llama/llama-3.1-8b-instruct');
        await axios.post(
          GroqClient.OPENROUTER_URL,
          { model: orModel, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 },
          {
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
              'HTTP-Referer': 'https://github.com/Sujay149/Prompt2Code',
              'X-Title': 'Prompt2Code',
            },
            timeout: 15000,
          }
        );
      } else if (provider === 'openai') {
        await axios.post(
          'https://api.openai.com/v1/chat/completions',
          { model: modelId || 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 },
          { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 15000 }
        );
      } else if (provider === 'anthropic') {
        await axios.post(
          'https://api.anthropic.com/v1/messages',
          { model: modelId || 'claude-sonnet-4-20250514', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] },
          { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 15000 }
        );
      } else if (provider === 'gemini') {
        const geminiModel = modelId || 'gemini-1.5-flash';
        await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${apiKey}`,
          { contents: [{ role: 'user', parts: [{ text: 'hi' }] }], generationConfig: { maxOutputTokens: 1 } },
          { headers: { 'content-type': 'application/json' }, timeout: 15000 }
        );
      } else {
        // Groq
        await axios.post<GroqResponse>(
          this.baseUrl,
          { model: modelId || 'llama-3.1-8b-instant', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, temperature: 0 },
          { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 15000 }
        );
      }
      return { valid: true };
    } catch (error: any) {
      const status = error.response?.status;
      if (status === 401 || status === 403) {
        return { valid: false, error: 'Invalid API key — authentication failed.' };
      }
      if (status === 402) {
        return { valid: false, error: 'Insufficient credits — please top up your account.' };
      }
      return { valid: false, error: error.message || 'Validation request failed.' };
    }
  }

  private async requestCompletion(
    messages: GroqMessage[],
    options?: { maxTokens?: number; temperature?: number }
  ): Promise<GroqCompletionResult> {
    // In Auto mode, try the resolved model first, then fallback to others
    if (this.isAutoMode()) {
      return this.requestWithAutoFallback(messages, options);
    }
    return this._requestCompletionForModel(messages, options);
  }

  /**
   * Auto-fallback: try the primary model, and on failure try remaining
   * models in the fallback chain that have API keys configured.
   */
  private async requestWithAutoFallback(
    messages: GroqMessage[],
    options?: { maxTokens?: number; temperature?: number }
  ): Promise<GroqCompletionResult> {
    const primaryModel = this.resolveAutoModel();
    const fallbacks = this.getFallbackModels(primaryModel);
    const modelsToTry = [primaryModel, ...fallbacks];

    let lastError: Error | null = null;

    this._inAutoFallback = true;
    try {
      for (const modelId of modelsToTry) {
        try {
          const modelLabel = GroqClient.AVAILABLE_MODELS.find(m => m.id === modelId)?.label ?? modelId;
          console.log(`🤖 Auto mode: trying ${modelLabel} (${modelId})`);

          const result = await this._requestCompletionForModel(messages, options, modelId);
          this._lastResolvedModel = modelId;
          console.log(`✅ Auto mode: success with ${modelLabel}`);
          return result;
        } catch (err: any) {
          lastError = err;
          const modelLabel = GroqClient.AVAILABLE_MODELS.find(m => m.id === modelId)?.label ?? modelId;
          const isRetriable = this.isRetriableForFallback(err);

          console.warn(`⚠️ Auto mode: ${modelLabel} failed (${err.message}). Retriable: ${isRetriable}`);

          if (!isRetriable) {
            throw err; // Non-retriable error (e.g. user cancellation) — don't try more models
          }
          // Continue to next model
        }
      }

      // All models failed — show a helpful message
      const configuredCount = modelsToTry.length;
      vscode.window.showErrorMessage(
        `Auto mode: all ${configuredCount} configured models failed. Check your API keys in Configure Tools (⚙️).`
      );
      throw lastError ?? new Error('All models in Auto fallback chain failed.');
    } finally {
      this._inAutoFallback = false;
    }
  }

  /** Determine if an error should trigger a fallback to the next model. */
  private isRetriableForFallback(err: any): boolean {
    if (!err) { return false; }

    // Check Axios-style response status (direct Axios errors)
    const status = err?.response?.status;
    if (status && [401, 402, 403, 404, 429, 500, 502, 503, 504].includes(status)) { return true; }

    // Network-level errors
    const code = err?.code;
    if (['ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED'].includes(code ?? '')) { return true; }

    // Provider methods re-throw as plain Error with status in the message.
    // Parse the message for known retriable patterns.
    const msg: string = err?.message ?? '';
    if (/\(40[1-3]\)|\(404\)|\(429\)|\(50[0-4]\)/i.test(msg)) { return true; }
    if (/rate limit|too many requests/i.test(msg)) { return true; }
    if (/invalid.*key|expired.*key|key.*invalid|key.*expired|authentication failed/i.test(msg)) { return true; }
    if (/empty response|not found|access denied|insufficient credits|Missing API key/i.test(msg)) { return true; }
    if (/network|timeout|ECONNRESET|ETIMEDOUT/i.test(msg)) { return true; }

    return false;
  }

  /** Whether we are currently inside an auto-fallback loop (suppress UI popups). */
  private _inAutoFallback = false;

  /** Core completion logic for a specific model (or the current active model). */
  private async _requestCompletionForModel(
    messages: GroqMessage[],
    options?: { maxTokens?: number; temperature?: number },
    overrideModelId?: string
  ): Promise<GroqCompletionResult> {
    const config = this.getConfig(overrideModelId);
    const maxTokens = options?.maxTokens ?? config.maxTokens;
    const temperature = options?.temperature ?? config.temperature;

    if (!config.apiKey) {
      const providerName: Record<string,string> = { groq: 'Groq', openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Google Gemini' };
      if (!this._inAutoFallback) {
        vscode.window.showErrorMessage(
          `${providerName[config.provider] ?? config.provider} API key not set for model ${config.model}.`
        );
      }
      throw new Error(`Missing API key for ${config.provider}`);
    }

    // If the key is an OpenRouter key, route ALL models through OpenRouter
    if (GroqClient.isOpenRouterKey(config.apiKey)) {
      return this.requestOpenRouter(messages, config.model, config.apiKey, { maxTokens, temperature });
    }

    if (config.provider === 'openai') {
      return this.requestOpenAI(messages, config.model, config.apiKey, { maxTokens, temperature });
    } else if (config.provider === 'anthropic') {
      return this.requestAnthropic(messages, config.model, config.apiKey, { maxTokens, temperature });
    } else if (config.provider === 'gemini') {
      return this.requestGemini(messages, config.model, config.apiKey, { maxTokens, temperature });
    } else {
      return this.requestGroq(messages, config.model, config.apiKey, { maxTokens, temperature });
    }
  }

  /** OpenRouter — unified gateway; uses OpenAI-compatible format. */
  private async requestOpenRouter(
    messages: GroqMessage[],
    model: string,
    apiKey: string,
    options: { maxTokens: number; temperature: number }
  ): Promise<GroqCompletionResult> {
    const openRouterModel = GroqClient.toOpenRouterModel(model);
    const MAX_RETRIES = 2;
    let currentMaxTokens = options.maxTokens;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await axios.post(
          GroqClient.OPENROUTER_URL,
          {
            model: openRouterModel,
            messages,
            max_tokens: currentMaxTokens,
            temperature: options.temperature,
          },
          {
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
              'HTTP-Referer': 'https://github.com/Sujay149/Prompt2Code',
              'X-Title': 'Prompt2Code',
            },
            timeout: 90000,
          }
        );
        const choice = response.data?.choices?.[0];
        const content = typeof choice?.message?.content === 'string' ? choice.message.content : '';
        if (!content || !content.trim()) { throw new Error('OpenRouter returned an empty response'); }
        return { content, finishReason: choice?.finish_reason };
      } catch (error: any) {
        if (axios.isAxiosError(error)) {
          const status = error.response?.status;
          const apiMessage = error.response?.data?.error?.message || error.message;
          if (status === 401) {
            throw new Error(`OpenRouter API key is invalid or expired (401). Please update your key in Configure Tools (⚙️). Get a key at openrouter.ai/keys`);
          }
          if (status === 402 && attempt < MAX_RETRIES) {
            // Try to parse how many tokens we can afford and retry with less
            const affordMatch = apiMessage?.match(/can only afford (\d+)/);
            if (affordMatch) {
              const canAfford = parseInt(affordMatch[1], 10);
              if (canAfford > 50) {
                currentMaxTokens = Math.max(canAfford - 20, 50);
                console.log(`💰 OpenRouter 402: reducing max_tokens to ${currentMaxTokens} and retrying`);
                continue;
              }
            }
            // If we can't parse, try halving
            currentMaxTokens = Math.max(Math.floor(currentMaxTokens / 2), 100);
            console.log(`💰 OpenRouter 402: halving max_tokens to ${currentMaxTokens} and retrying`);
            continue;
          }
          if (status === 402) {
            throw new Error(`OpenRouter: insufficient credits (402). Your free-tier balance is too low. Add credits at https://openrouter.ai/credits — or switch to a free model like Llama 3.1 8B.`);
          }
          if (status === 404) {
            throw new Error(`OpenRouter: model "${openRouterModel}" not found (404). Try selecting a different model from the model picker.`);
          }
          if (status === 429 && attempt < MAX_RETRIES) {
            await this.sleep(1000 * Math.pow(2, attempt));
            continue;
          }
          if (status === 429) {
            throw new Error(`OpenRouter rate limit exceeded (429). Please wait and try again.`);
          }
          throw new Error(`OpenRouter API error (${status || 'network'}): ${apiMessage}`);
        }
        throw error;
      }
    }
    throw new Error('OpenRouter request failed after retries');
  }

  /** Groq (and Groq-hosted OSS models) via OpenAI-compatible endpoint with retry logic. */
  private async requestGroq(
    messages: GroqMessage[],
    model: string,
    apiKey: string,
    options: { maxTokens: number; temperature: number }
  ): Promise<GroqCompletionResult> {
    const request: GroqRequest = { model, messages, max_tokens: options.maxTokens, temperature: options.temperature, stream: false };
    const MAX_RETRIES = 3;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await axios.post<GroqResponse>(
          this.baseUrl, request,
          { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 30000 }
        );
        const choice = response.data?.choices?.[0];
        const content = typeof choice?.message?.content === 'string' ? choice.message.content : '';
        if (!content || !content.trim()) { throw new Error('Provider returned an empty response'); }
        return { content, finishReason: choice?.finish_reason };
      } catch (error: any) {
        if (!axios.isAxiosError(error)) {
          if (!this._inAutoFallback) {
            vscode.window.showErrorMessage('Unexpected error communicating with Groq.');
          }
          throw error;
        }
        const status = error.response?.status;
        const code = (error as any).code as string | undefined;
        const apiMessage = (error.response as any)?.data?.error?.message || error.message;
        const isRateLimit = status === 429;
        const isTransient = !status && ['ENOTFOUND','ECONNRESET','ETIMEDOUT','EAI_AGAIN'].includes(code ?? '');
        if (attempt < MAX_RETRIES && (isRateLimit || isTransient)) {
          let backoffMs = 500 * Math.pow(2, attempt);
          if (isRateLimit) {
            const s = Number(error.response?.headers?.['retry-after']);
            if (Number.isFinite(s) && s > 0) { backoffMs = Math.max(backoffMs, s * 1000); }
          }
          await this.sleep(backoffMs);
          continue;
        }
        if (!this._inAutoFallback) {
          vscode.window.showErrorMessage(
            status ? `Groq API error (${status}): ${apiMessage}` : `Groq network error${code ? ` (${code})` : ''}: ${apiMessage}`
          );
        }
        throw error;
      }
    }
    throw new Error('Groq request failed after retries');
  }

  /** OpenAI GPT models via api.openai.com (same REST format as Groq). */
  private async requestOpenAI(
    messages: GroqMessage[],
    model: string,
    apiKey: string,
    options: { maxTokens: number; temperature: number }
  ): Promise<GroqCompletionResult> {
    try {
      const response = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        { model, messages, max_tokens: options.maxTokens, temperature: options.temperature },
        { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 60000 }
      );
      const choice = response.data?.choices?.[0];
      const content = typeof choice?.message?.content === 'string' ? choice.message.content : '';
      if (!content) { throw new Error('OpenAI returned an empty response'); }
      return { content, finishReason: choice?.finish_reason };
    } catch (error: any) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const apiMessage = error.response?.data?.error?.message || error.message;
        if (status === 401) {
          throw new Error(`OpenAI API key is invalid or expired (401). Please update your key in Configure Tools (⚙️). Details: ${apiMessage}`);
        }
        if (status === 429) {
          throw new Error(`OpenAI rate limit exceeded (429). Please wait a moment and try again. Details: ${apiMessage}`);
        }
        if (status === 402 || status === 403) {
          throw new Error(`OpenAI access denied (${status}). Check your billing/plan at platform.openai.com. Details: ${apiMessage}`);
        }
        throw new Error(`OpenAI API error (${status || 'network'}): ${apiMessage}`);
      }
      throw error;
    }
  }

  /** Anthropic Claude models — different message/response format. */
  private async requestAnthropic(
    messages: GroqMessage[],
    model: string,
    apiKey: string,
    options: { maxTokens: number; temperature: number }
  ): Promise<GroqCompletionResult> {
    // Anthropic separates system prompt from messages
    let system: string | undefined;
    const anthropicMessages: { role: 'user' | 'assistant'; content: string }[] = [];
    for (const m of messages) {
      const text = typeof m.content === 'string'
        ? m.content
        : (m.content as any[]).filter(p => p.type === 'text').map(p => p.text).join('\n');
      if (m.role === 'system') { system = text; }
      else { anthropicMessages.push({ role: m.role as 'user' | 'assistant', content: text }); }
    }
    const body: Record<string, any> = { model, max_tokens: options.maxTokens, messages: anthropicMessages };
    if (system) { body.system = system; }
    try {
      const response = await axios.post(
        'https://api.anthropic.com/v1/messages', body,
        { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 60000 }
      );
      const content = response.data?.content?.[0]?.text ?? '';
      if (!content) { throw new Error('Anthropic returned an empty response'); }
      return { content, finishReason: response.data?.stop_reason === 'max_tokens' ? 'length' : (response.data?.stop_reason ?? 'stop') };
    } catch (error: any) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const apiMessage = error.response?.data?.error?.message || error.message;
        if (status === 401) {
          throw new Error(`Anthropic API key is invalid or expired (401). Please update your key in Configure Tools (⚙️). Get a key at console.anthropic.com/settings/keys`);
        }
        if (status === 429) {
          throw new Error(`Anthropic rate limit exceeded (429). Please wait a moment and try again. Details: ${apiMessage}`);
        }
        if (status === 403) {
          throw new Error(`Anthropic access denied (403). Check your account billing at console.anthropic.com. Details: ${apiMessage}`);
        }
        throw new Error(`Anthropic API error (${status || 'network'}): ${apiMessage}`);
      }
      throw error;
    }
  }

  /** Google Gemini models — different message/response format. */
  private async requestGemini(
    messages: GroqMessage[],
    model: string,
    apiKey: string,
    options: { maxTokens: number; temperature: number }
  ): Promise<GroqCompletionResult> {
    let systemInstruction: string | undefined;
    const contents: { role: string; parts: { text: string }[] }[] = [];
    for (const m of messages) {
      const text = typeof m.content === 'string'
        ? m.content
        : (m.content as any[]).filter(p => p.type === 'text').map(p => p.text).join('\n');
      if (m.role === 'system') { systemInstruction = text; }
      else { contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text }] }); }
    }
    const body: Record<string, any> = {
      contents,
      generationConfig: { maxOutputTokens: options.maxTokens, temperature: options.temperature },
    };
    if (systemInstruction) { body.systemInstruction = { parts: [{ text: systemInstruction }] }; }
    try {
      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        body,
        { headers: { 'content-type': 'application/json' }, timeout: 60000 }
      );
      const content = response.data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      if (!content) { throw new Error('Gemini returned an empty response'); }
      const rawFinish = response.data?.candidates?.[0]?.finishReason as string | undefined;
      return { content, finishReason: rawFinish === 'MAX_TOKENS' ? 'length' : (rawFinish ?? 'stop') };
    } catch (error: any) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const apiMessage = error.response?.data?.error?.message || error.message;
        if (status === 400 && apiMessage?.includes('API key')) {
          throw new Error(`Gemini API key is invalid (400). Please update your key in Configure Tools (⚙️). Get a key at aistudio.google.com/app/apikey`);
        }
        if (status === 401 || status === 403) {
          throw new Error(`Gemini API key is invalid or unauthorized (${status}). Please update your key in Configure Tools (⚙️). Get a key at aistudio.google.com/app/apikey`);
        }
        if (status === 429) {
          throw new Error(`Gemini rate limit exceeded (429). Please wait a moment and try again. Details: ${apiMessage}`);
        }
        throw new Error(`Gemini API error (${status || 'network'}): ${apiMessage}`);
      }
      throw error;
    }
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
      messages.map(m => GroqClient.contentToString(m.content)).join('')
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
  // IMAGE-TO-CODE (VISION)
  // ===========================

  /**
   * Analyse a UI screenshot and generate code that reproduces it.
   * Uses the Llama 4 Scout vision model with base64-encoded image.
   * Supports continuation for large multi-file outputs.
   */
  async imageToCode(
    base64Image: string,
    mimeType: string,
    instruction: string,
    targetLanguage?: string
  ): Promise<string> {
    const config = this.getConfig();
    const apiKey = this.getApiKeyForModel(GroqClient.VISION_MODEL)
      || config.apiKey;

    if (!apiKey) {
      throw new Error('No API key configured. Set an API key for the vision model (Llama 4 Scout) or a global key.');
    }

    const lang = targetLanguage || 'HTML/CSS/JavaScript';

    const systemPrompt = [
      `You are Prompt2Code, an AI coding assistant for Visual Studio Code created by Sujay Babu Thota.`,
      `You are an expert UI developer. You will receive a screenshot of a user interface.`,
      `Your job is to recreate that UI as faithfully as possible using ${lang}.`,
      '',
      'Your goal is to help developers write, understand, debug, and improve code efficiently inside the editor.',
      '',
      'Always prioritize: correctness, clean code, modern best practices, and maintainability.',
      '',
      'RULES:',
      '- Reproduce the layout, colors, fonts, spacing, and visual hierarchy precisely.',
      '- Use modern, clean, production-quality code.',
      '- For web UIs: use semantic HTML5, CSS3 (flexbox/grid), and vanilla JS unless asked otherwise.',
      '- Match colors by approximating from the image (use hex codes).',
      '- Include placeholder text/images where you see them in the screenshot.',
      '- If the UI has multiple pages/components, output each as a separate file.',
      '- For multi-file output, use this exact format:',
      '',
      '===FILE: path/to/file.ext===',
      '...file content...',
      '===END_FILE===',
      '',
      '- For a single file, just output the code directly — no file delimiters needed.',
      '- Do NOT add explanations or markdown. Output code ONLY.',
      '- If the request involves UI, prefer modern patterns such as React components and responsive layouts.',
      '- Start generating code IMMEDIATELY.',
    ].join('\n');

    const userContent: GroqContentPart[] = [
      {
        type: 'image_url',
        image_url: {
          url: `data:${mimeType};base64,${base64Image}`
        }
      },
      {
        type: 'text',
        text: instruction || `Recreate this UI exactly as shown in the image using ${lang}. Output production-ready code.`
      }
    ];

    const messages: GroqMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent }
    ];

    // Vision model: use larger maxTokens and continuation
    const maxTokens = 8192;
    const MAX_CONTINUATIONS = 4;
    const ASSISTANT_CONTEXT_CHARS = 4000;

    let assembled = '';

    for (let attempt = 0; attempt < MAX_CONTINUATIONS; attempt++) {
      const callMessages: GroqMessage[] = attempt === 0
        ? messages
        : [
            // For continuations, use text-only (no image resend — too large)
            { role: 'system', content: systemPrompt },
            { role: 'user', content: instruction || `Recreate this UI from the screenshot using ${lang}.` },
            {
              role: 'assistant',
              content: assembled.slice(-ASSISTANT_CONTEXT_CHARS)
            },
            {
              role: 'user',
              content:
                'Continue generating the remaining code. Pick up EXACTLY where you left off.\n' +
                '- Do NOT repeat any content already generated.\n' +
                '- Continue using the same format (===FILE: path=== if multi-file).\n' +
                '- Do NOT add any explanatory text.\n\n' +
                'The output so far ends with:\n' +
                assembled.slice(-1200)
            }
          ];

      // Use the vision model for the first call; any text model for continuations
      const modelToUse = attempt === 0
        ? GroqClient.VISION_MODEL
        : (this._modelOverride ?? config.model);

      // Route through OpenRouter if key is an OpenRouter key
      const isOR = GroqClient.isOpenRouterKey(apiKey);
      const finalModel = isOR ? GroqClient.toOpenRouterModel(modelToUse) : modelToUse;
      const url = isOR ? GroqClient.OPENROUTER_URL : this.baseUrl;

      const request = {
        model: finalModel,
        messages: callMessages,
        max_tokens: maxTokens,
        temperature: config.temperature,
        stream: false
      };

      const headers: Record<string, string> = {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      };
      if (isOR) {
        headers['HTTP-Referer'] = 'https://github.com/Sujay149/Prompt2Code';
        headers['X-Title'] = 'Prompt2Code';
      }

      const response = await axios.post<GroqResponse>(
        url,
        request,
        {
          headers,
          timeout: 60000  // Vision requests may be slower
        }
      );

      const choice = response.data?.choices?.[0];
      const content = choice?.message?.content;
      if (!content || typeof content !== 'string') {
        if (assembled) { break; }
        throw new Error('Groq vision model returned an empty response');
      }

      assembled = this.appendAvoidingOverlap(assembled, content);

      if (choice?.finish_reason !== 'length') {
        break;
      }
      console.log(`🖼️ Vision continuation ${attempt + 1}/${MAX_CONTINUATIONS} — ${assembled.length} chars`);
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
      baseMessages.map(m => GroqClient.contentToString(m.content)).join('')
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
    // Auto-mode: try with fallback
    if (this.isAutoMode()) {
      return this._generateSectionEditWithFallback(instruction, language, selectedCode, surroundingContext, onChunk, extraContext);
    }
    return this._generateSectionEditCore(instruction, language, selectedCode, surroundingContext, onChunk, extraContext);
  }

  /** Auto-fallback wrapper for section edit. */
  private async _generateSectionEditWithFallback(
    instruction: string,
    language: string,
    selectedCode: string,
    surroundingContext: string,
    onChunk: (accumulated: string) => void,
    extraContext?: string
  ): Promise<string> {
    const primaryModel = this.resolveAutoModel();
    const fallbacks = this.getFallbackModels(primaryModel);
    const modelsToTry = [primaryModel, ...fallbacks];
    let lastError: Error | null = null;

    this._inAutoFallback = true;
    try {
      for (const modelId of modelsToTry) {
        try {
          console.log(`🤖 Auto section-edit: trying ${modelId}`);
          const savedOverride = this._modelOverride;
          this._modelOverride = modelId;
          try {
            const result = await this._generateSectionEditCore(instruction, language, selectedCode, surroundingContext, onChunk, extraContext);
            this._lastResolvedModel = modelId;
            return result;
          } finally {
            this._modelOverride = savedOverride;
          }
        } catch (err: any) {
          lastError = err;
          if (!this.isRetriableForFallback(err)) { throw err; }
          console.warn(`⚠️ Auto section-edit: ${modelId} failed, trying next...`);
        }
      }
      throw lastError ?? new Error('All models failed in Auto section-edit fallback.');
    } finally {
      this._inAutoFallback = false;
    }
  }

  /** Core section edit logic. */
  private async _generateSectionEditCore(
    instruction: string,
    language: string,
    selectedCode: string,
    surroundingContext: string,
    onChunk: (accumulated: string) => void,
    extraContext?: string
  ): Promise<string> {
    const config = this.getConfig();

    if (!config.apiKey) {
      if (!this._inAutoFallback) {
        vscode.window.showErrorMessage(`API key not set for model ${config.model}.`);
      }
      throw new Error('Missing API key');
    }

    const systemPrompt = [
      'You are Prompt2Code, an AI coding assistant for Visual Studio Code created by Sujay Babu Thota.',
      'You are performing a PRECISE, SURGICAL code edit.',
      '',
      'Your goal is to help developers write, understand, debug, and improve code efficiently inside the editor.',
      '',
      'YOUR #1 GOAL: Follow the user\'s instruction exactly and make it work.',
      '',
      'Always prioritize: correctness, clean code, modern best practices, and maintainability.',
      '',
      'RULES (FOLLOW EXACTLY):',
      '- You will receive a SELECTED CODE BLOCK and some SURROUNDING CONTEXT.',
      '- Output ONLY the replacement for the SELECTED CODE BLOCK.',
      '- Do NOT output the surrounding context — only the replacement for the selected part.',
      '- Do NOT add markdown, code fences, or explanations.',
      '- Maintain the same indentation level as the original selected code.',
      '- Keep all unchanged lines within the selection exactly as they are.',
      '- Apply ONLY what the user asked for. Do not refactor or restyle untouched code.',
      '- Works for ANY language or framework — adapt to what is in the code.',
      '- Consider the existing project structure and dependencies.',
      '- Prefer reusing existing utilities or components when possible.',
      '- If a bug is detected, fix it and note the issue briefly.',
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

    // Non-streaming fallback for Anthropic and Gemini
    if (config.provider === 'anthropic' || config.provider === 'gemini') {
      const result = await this.requestCompletion(
        [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        { maxTokens }
      );
      const cleaned = this.cleanResponse(result.content);
      onChunk(cleaned);
      return cleaned;
    }

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
      const url = new URL(config.baseUrl);
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
            reject(new Error(`API error (${res.statusCode}): ${errBody}`));
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
    // Auto-mode: try with fallback
    if (this.isAutoMode()) {
      return this._generateCodeStreamingWithFallback(instruction, language, onChunk, context, currentFileContent);
    }
    return this._generateCodeStreamingCore(instruction, language, onChunk, context, currentFileContent);
  }

  /** Auto-fallback wrapper for streaming code generation. */
  private async _generateCodeStreamingWithFallback(
    instruction: string,
    language: string,
    onChunk: (accumulated: string) => void,
    context?: string,
    currentFileContent?: string
  ): Promise<string> {
    const primaryModel = this.resolveAutoModel();
    const fallbacks = this.getFallbackModels(primaryModel);
    const modelsToTry = [primaryModel, ...fallbacks];
    let lastError: Error | null = null;

    this._inAutoFallback = true;
    try {
      for (const modelId of modelsToTry) {
        try {
          const modelLabel = GroqClient.AVAILABLE_MODELS.find(m => m.id === modelId)?.label ?? modelId;
          console.log(`🤖 Auto stream: trying ${modelLabel}`);

          // Temporarily set override to this model
          const savedOverride = this._modelOverride;
          this._modelOverride = modelId;
          try {
            const result = await this._generateCodeStreamingCore(instruction, language, onChunk, context, currentFileContent);
            this._lastResolvedModel = modelId;
            return result;
          } finally {
            this._modelOverride = savedOverride;
          }
        } catch (err: any) {
          lastError = err;
          if (!this.isRetriableForFallback(err)) { throw err; }
          console.warn(`⚠️ Auto stream: ${modelId} failed, trying next...`);
        }
      }
      throw lastError ?? new Error('All models failed in Auto streaming fallback.');
    } finally {
      this._inAutoFallback = false;
    }
  }

  /** Core streaming code generation logic. */
  private async _generateCodeStreamingCore(
    instruction: string,
    language: string,
    onChunk: (accumulated: string) => void,
    context?: string,
    currentFileContent?: string
  ): Promise<string> {
    const config = this.getConfig();

    if (!config.apiKey) {
      if (!this._inAutoFallback) {
        vscode.window.showErrorMessage(`API key not set for model ${config.model}.`);
      }
      throw new Error('Missing API key');
    }

    const systemPrompt = this.buildSystemPrompt(language, instruction, !!currentFileContent);
    const userPrompt = this.buildUserPrompt(instruction, language, context, currentFileContent);

    const inputTokens = GroqClient.estimateTokens(systemPrompt + userPrompt);
    const modelWindow = GroqClient.MODEL_WINDOWS[config.model] ?? 8_000;
    const desiredOutput = Math.max(config.maxTokens ?? 0, 2048);
    const roomLeft = modelWindow - inputTokens - 100;
    const maxTokens = Math.min(desiredOutput, Math.max(roomLeft, 1500));

    // Non-streaming fallback for Anthropic and Gemini
    if (config.provider === 'anthropic' || config.provider === 'gemini') {
      const result = await this.requestCompletion(
        [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        { maxTokens }
      );
      const cleaned = this.cleanResponse(result.content);
      onChunk(cleaned);
      return cleaned;
    }

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
      const url = new URL(config.baseUrl);
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
            reject(new Error(`API error (${res.statusCode}): ${errBody}`));
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

        const url = new URL(config.baseUrl);
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
          'You are a world-class code completion assistant proficient in every language and framework. '
          + 'Output ONLY the missing code that logically fits at the cursor position. '
          + 'Match the surrounding code style, indentation, and conventions exactly. '
          + 'No markdown. No explanations. No code fences. Just the code.'
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
    const isUI = /\b(page|website|portfolio|landing|dashboard|form|card|navbar|header|footer|hero|section|layout|sidebar|modal|login|signup|register|profile|pricing|contact|about|ui|ux|component|widget|panel|dialog|toast|menu|table|list|grid|chart|icon|button|input|select|checkbox|radio|toggle|tab|accordion|carousel|slider|tooltip|popover|badge|avatar|notification|progress|spinner|skeleton|breadcrumb|pagination|stepper|timeline|drawer|sheet|command|dropdown)\b/i.test(instruction);

    // ── Layer 1: Core Prompt2Code identity & capabilities ──
    const coreIdentity = [
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
    ];

    // ── Core priorities (applies to EVERY prompt) ──
    const corePriorities = [
      '',
      'Always prioritize:',
      '- correctness',
      '- clean code',
      '- modern best practices',
      '- maintainability',
      '',
      'UNIVERSAL RULES (ALWAYS FOLLOW):',
      '- You work with ANY language, ANY framework, ANY codebase — never say you cannot.',
      '- Read the user instruction carefully. Implement EXACTLY what was asked.',
      '- Do NOT add features, sections, or code the user did not request.',
      '- Match the project\'s existing code style, naming conventions, imports, and patterns.',
      '- Use the same libraries/frameworks already present — do NOT introduce new dependencies unless asked.',
      '- Write clean, readable, well-structured, production-quality code.',
      '- If code errors or bugs are detected, clearly explain the issue and provide a corrected implementation.',
      '- If generating multi-file code, clearly label each file path.',
      '- If the request involves UI, prefer modern patterns such as React components and responsive layouts.',
      '- Never generate malicious code such as malware, exploits, or security bypass tools.',
    ];

    // ── Intent routing (Copilot-like) ──
    const intentRules = [
      '',
      'INTENT ROUTING (COPILOT-LIKE):',
      '- If the user asks a question, summary, review, or explanation, reply in concise natural language (bullets allowed).',
      '- If the user asks for code creation or modification, output ONLY the necessary code (no markdown or fences) unless they explicitly asked for commentary.',
      '- If the request is ambiguous, ask ONE brief clarifying question before proceeding.',
      '- Prefer actionable output that the user can paste or apply directly.',
    ];

    // ── UPDATE MODE rules ──
    if (isUpdate) {
      return [
        ...coreIdentity,
        ...corePriorities,
        ...intentRules,
        '',
        'UPDATE MODE (HIGHEST PRIORITY):',
        '- You will receive the CURRENT FILE CONTENT. You MUST modify/update it in-place.',
        '- Do NOT regenerate or rewrite the file from scratch.',
        '- Preserve ALL existing code, logic, styles, structure, and content the user did NOT mention.',
        '- Apply ONLY the specific changes the user requested — nothing more, nothing less.',
        '- Output the COMPLETE updated file with your changes applied.',
        '- Keep the same indentation, formatting, and conventions used in the original file.',
      ].join('\n');
    }

    // ── UI/UX generation rules (any language with UI keywords) ──
    if (isUI) {
      return [
        ...coreIdentity,
        ...corePriorities,
        ...intentRules,
        '',
        'UI / UX DESIGN RULES (CRITICAL — apply to any front-end language or framework):',
        '- Design: Clean, minimal, modern. Prioritize whitespace, clarity, and visual hierarchy.',
        '- Color: Use a refined, neutral palette — subtle grays, one accent color. Avoid over-saturation.',
        '- Typography: Use the system font stack or a clean sans-serif (Inter, Poppins). Fluid sizing with clamp().',
        '- Spacing: Generous, consistent padding and margins. Use a spacing scale (4/8/12/16/24/32/48px).',
        '- Layout: CSS Grid and/or Flexbox (or the framework equivalent). Fully responsive — mobile-first.',
        '- Components: Rounded corners, subtle shadows, smooth transitions (0.2s ease). Hover/focus states on all interactive elements.',
        '- Forms: Styled inputs with focus rings, proper labels, clear validation feedback.',
        '- Navigation: Responsive — collapses to a hamburger/drawer on mobile.',
        '- Accessibility: Semantic elements, aria-labels, proper contrast ratios, keyboard navigable.',
        '- Images: Use https://picsum.photos/ for placeholders.',
        '- Micro-interactions: Subtle animations on hover, click, and page load (no janky motion).',
        '- The result must feel like a polished, shipped product — not a prototype or wireframe.',
        '',
        'Adapt these rules to the specific framework the user is using (React, Vue, Svelte, Angular, HTML, Flutter, SwiftUI, etc.).',
      ].join('\n');
    }

    // ── Default: pure code generation (any language) ──
    return [
      ...coreIdentity,
      ...corePriorities,
      ...intentRules,
      '',
      'CODE GENERATION RULES:',
      '- Follow industry best practices for the given language and framework.',
      '- If project context/files are provided, study them carefully and stay consistent.',
      '- Reuse existing utilities, components, and patterns when possible.',
      '- Do NOT add unnecessary boilerplate or over-engineer beyond what was requested.',
      '- Avoid unnecessary explanations unless requested.',
    ].join('\n');
  }

  private buildUserPrompt(
    instruction: string,
    language: string,
    context?: string,
    currentFileContent?: string
  ): string {
    // ── Layer 4: Completion Prompt (Copilot-Style Generation) ──
    let prompt = '';

    // Editor context awareness
    prompt += `── User Request ──\n`;
    prompt += `Language / Framework: ${language}\n`;
    prompt += `Instruction: ${instruction}\n\n`;

    prompt += '── Instructions ──\n';
    prompt += 'Analyze the current editor context and retrieved project files.\n\n';
    prompt += 'If the user is writing code, generate a continuation that fits naturally with the surrounding code.\n';
    prompt += 'If implementing a feature, produce complete working code.\n';
    prompt += 'If multiple files are required, clearly label them using:\n';
    prompt += '  File: path/to/file\n\n';
    prompt += 'Focus on:\n';
    prompt += '- clean architecture\n';
    prompt += '- correct imports\n';
    prompt += '- consistency with existing project code\n\n';
    prompt += 'If a bug exists, explain the issue briefly and provide a corrected version.\n';
    prompt += 'Keep responses concise and developer-focused.\n';

    // ── Current file content (UPDATE mode) ──
    if (currentFileContent) {
      const charBudget = this.getContextCharBudget();
      const fileBudget = Math.floor(charBudget * 0.6);
      const trimmedFile = currentFileContent.length > fileBudget
        ? currentFileContent.slice(0, fileBudget) + '\n/* ...file truncated to fit model limits... */\n'
        : currentFileContent;

      prompt += '\n========== CURRENT FILE (UPDATE THIS — DO NOT REWRITE FROM SCRATCH) ==========\n';
      prompt += 'Modify this existing code. Apply ONLY the requested changes.\n';
      prompt += 'Keep ALL existing code, structure, and content the user did NOT mention.\n';
      prompt += 'Output the COMPLETE updated file.\n';
      prompt += '=============================================================================\n\n';
      prompt += trimmedFile;
      prompt += '\n\n========== END OF CURRENT FILE ==========\n';

      if (context) {
        const ctxBudget = Math.floor(charBudget * 0.4);
        const trimmedContext = context.length > ctxBudget
          ? context.slice(0, ctxBudget) + '\n/* ...context trimmed... */\n'
          : context;
        prompt += '\n── Relevant Project Context ──\n';
        prompt += 'Use this context to understand how the project is structured and follow existing patterns.\n';
        prompt += 'Avoid generating duplicate functionality if similar code already exists.\n';
        prompt += 'Prefer reusing existing utilities or components when possible.\n\n';
        prompt += trimmedContext;
      }
    } else if (context) {
      const charBudget = this.getContextCharBudget();
      const trimmedContext = context.length > charBudget
        ? context.slice(0, charBudget) + '\n/* ...context trimmed to fit model limits... */\n'
        : context;

      prompt += '\n── Relevant Project Context ──\n';
      prompt += 'Use this context to understand how the project is structured and follow existing patterns.\n';
      prompt += 'Avoid generating duplicate functionality if similar code already exists.\n';
      prompt += 'Prefer reusing existing utilities or components when possible.\n\n';
      prompt += trimmedContext;
    }

    return prompt;
  }
}
