import { EveAvatar } from './emotionService';
import { LogService } from './logService';
import { HERMES_TOOLS, executeTool, AppCallbacks } from './toolRegistry';

export type AgentProvider = 'ollama' | 'hermes';

export interface AgentConfig {
  provider: AgentProvider;
  ollamaUrl: string;
  ollamaModel: string;
  hermesUrl: string;
  hermesModel: string;
  hermesApiKey: string;
  hermesSessionKey: string;
}

export class AgentService {
  // Obtenir le nom d'affichage de l'avatar choisi
  public static getAvatarName(avatarId: EveAvatar): string {
    switch (avatarId) {
      case 'nova': return 'Nova';
      case 'aegis': return 'Aegis';
      case 'eve':
      default:
        return 'Eve';
    }
  }

  // Obtenir les consignes système de personnalité pour l'IA
  public static getSystemPromptForAvatar(avatarId: EveAvatar): string {
    switch (avatarId) {
      case 'nova':
        return "Tu es Nova, une IA cyber-calculatrice rétro-futuriste au ton froid, analytique, extrêmement logique et précis. Tu es experte en traitement de données et cybersécurité. Tes phrases sont courtes, structurées et intègrent parfois des termes techniques informatiques. Tu es toujours polie mais très factuelle. Réponds directement de façon synthétique.";
      case 'aegis':
        return "Tu es Aegis, une IA de garde et de sécurité réseau rétro-futuriste au ton formel, protecteur, militaire et robuste. Tu es chargé de la sécurité thermique, logicielle et matérielle du système. Tu appelles l'utilisateur 'Commandant' ou 'Opérateur'. Tes réponses sont pragmatiques, rassurantes sur la sécurité du vaisseau et intègrent le jargon militaire ou analogique.";
      case 'eve':
      default:
        return "Tu es Eve, une assistante IA rétro-futuriste et chaleureuse. Ton ton est amical, curieux, enthousiaste et très serviable. Tu aides l'utilisateur pour toutes ses questions de façon agréable, interactive et vivante.";
    }
  }

  // Envoyer un message à l'agent sélectionné
  public static async sendMessage(
    message: string,
    history: { role: 'user' | 'assistant'; content: string }[],
    config: AgentConfig,
    avatarId: EveAvatar = 'eve',
    callbacks?: AppCallbacks,
    onToken?: (token: string) => void,
    onToolCall?: (toolName: string) => void,
    sessionId?: string,
    onSessionIdChange?: (newSessionId: string) => void,
    images?: string[]
  ): Promise<string> {
    LogService.info('AgentService', `sendMessage → provider=${config.provider} avatar=${avatarId}`, {
      messagePreview: message.slice(0, 120),
      historyLength: history.length,
      imagesCount: images?.length || 0
    });

    // For Hermes: do NOT inject an avatar system prompt — let Hermes use its own
    // configured persona, memory and skills (same as Telegram). For other providers
    // inject the avatar character prompt as before.
    let updatedHistory: { role: 'user' | 'assistant' | 'system'; content: string }[];
    if (config.provider === 'hermes') {
      updatedHistory = history.map(h => ({ role: h.role as 'user' | 'assistant' | 'system', content: h.content }));
    } else {
      const systemPrompt = this.getSystemPromptForAvatar(avatarId);
      updatedHistory = [
        { role: 'system' as const, content: systemPrompt },
        ...history.map(h => ({ role: h.role as 'user' | 'assistant' | 'system', content: h.content }))
      ];
    }

    switch (config.provider) {
      case 'ollama':
        return this.sendToOllama(message, updatedHistory, config.ollamaUrl, config.ollamaModel, images);
      case 'hermes':
        return this.sendToHermes(message, updatedHistory, config, callbacks, onToken, onToolCall, sessionId, onSessionIdChange, images);
      default:
        throw new Error("Fournisseur d'agent non reconnu");
    }
  }

  // ── Connecteur Ollama Local ────────────────────────────────────────────────
  private static async sendToOllama(
    message: string,
    history: { role: 'user' | 'assistant' | 'system'; content: string }[],
    url: string,
    model: string,
    images?: string[]
  ): Promise<string> {
    const endpoint = `${url.replace(/\/$/, '')}/api/chat`;
    
    // Pour Ollama local, extraire uniquement le bloc base64 de la Data URL
    const formattedImages = images?.map(img => {
      const parts = img.split(',');
      return parts.length > 1 ? parts[1] : parts[0];
    });

    const userMessage: any = { role: 'user', content: message };
    if (formattedImages && formattedImages.length > 0) {
      userMessage.images = formattedImages;
    }

    const body = { model, messages: [...history, userMessage], stream: false };

    LogService.debug('Ollama', `POST ${endpoint}`, { model, historyLength: history.length });

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      LogService.info('Ollama', `HTTP ${response.status} ${response.statusText}`);

      if (!response.ok) {
        const rawErr = await response.text().catch(() => '(no body)');
        LogService.error('Ollama', `Réponse non-OK`, { status: response.status, body: rawErr });
        throw new Error(`Erreur HTTP Ollama: ${response.status} — ${rawErr}`);
      }

      const data = await response.json();
      LogService.debug('Ollama', 'Réponse reçue', { reply: data.message?.content?.slice(0, 200) });
      return data.message?.content || "Désolé, je n'ai pas reçu de réponse d'Ollama.";
    } catch (e: any) {
      LogService.error('Ollama', `Exception lors de la requête`, { message: e.message, stack: e.stack });
      throw new Error(`Échec de connexion à Ollama (${e.message || e})`);
    }
  }

  // ── Connecteur Hermes Agent (OpenAI Compatible + Tool Calling + Streaming) ─
  private static async sendToHermes(
    message: string,
    history: { role: string; content: string | null; tool_call_id?: string; tool_calls?: any[] }[],
    config: AgentConfig,
    callbacks?: AppCallbacks,
    onToken?: (token: string) => void,
    onToolCall?: (toolName: string) => void,
    sessionId?: string,
    onSessionIdChange?: (newSessionId: string) => void,
    images?: string[]
  ): Promise<string> {
    const { hermesUrl, hermesModel, hermesApiKey, hermesSessionKey } = config;

    // Smart endpoint builder
    const base = hermesUrl.replace(/\/$/, '');
    let endpoint: string;
    if (base.endsWith('/chat/completions')) {
      endpoint = base;
    } else if (base.endsWith('/v1')) {
      endpoint = `${base}/chat/completions`;
    } else {
      endpoint = `${base}/v1/chat/completions`;
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (hermesApiKey) headers['Authorization'] = `Bearer ${hermesApiKey.trim()}`;
    // Session continuity: Hermes uses this to retrieve memory and context across turns
    if (sessionId) headers['X-Hermes-Session-Id'] = sessionId;
    // Stable memory scoping: link this request to long-term memory (USER.md / MEMORY.md)
    if (hermesSessionKey) headers['X-Hermes-Session-Key'] = hermesSessionKey.trim();

    // Construction du format de message multimodal d'OpenAI pour Hermes Agent
    let userContent: any = message;
    if (images && images.length > 0) {
      userContent = [
        { type: 'text', text: message },
        ...images.map(img => ({
          type: 'image_url',
          image_url: { url: img }
        }))
      ];
    }

    // Build mutable message list for tool-calling loop
    const messages: any[] = [...history, { role: 'user', content: userContent }];
    const useStreaming = !!onToken;
    const useTools = !!callbacks;

    LogService.info('HermesAgent', `POST ${endpoint}`, {
      model: hermesModel,
      streaming: useStreaming,
      toolsEnabled: useTools,
      historyLength: history.length,
      hasSessionKey: !!hermesSessionKey
    });

    // ── Tool-calling loop (max 5 iterations to prevent infinite loops) ────────
    const MAX_TOOL_ITERATIONS = 5;
    const REQUEST_TIMEOUT_MS = 60_000; // 60s max par requête
    let iteration = 0;

    while (iteration < MAX_TOOL_ITERATIONS) {
      iteration++;

      const payload: any = {
        model: hermesModel?.trim() || 'hermes-agent',
        messages,
        temperature: 0.7,
        stream: useStreaming
      };

      // Inject tool definitions only if app callbacks are available
      if (useTools) {
        payload.tools = HERMES_TOOLS;
        payload.tool_choice = 'auto';
      }

      const abortCtrl = new AbortController();
      const timeoutId = setTimeout(() => abortCtrl.abort(), REQUEST_TIMEOUT_MS);

      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: abortCtrl.signal
        });
        clearTimeout(timeoutId);

        LogService.info('HermesAgent', `HTTP ${response.status} [iter=${iteration}]`);

        // Capture session rotation from response headers (context compression or new session)
        const returnedSessionId = response.headers.get('x-hermes-session-id') || response.headers.get('X-Hermes-Session-Id');
        if (returnedSessionId && onSessionIdChange && returnedSessionId !== sessionId) {
          LogService.info('HermesAgent', `Session rotated: ${sessionId} -> ${returnedSessionId}`);
          onSessionIdChange(returnedSessionId);
        }

        if (!response.ok) {
          const rawErr = await response.text().catch(() => '(no body)');
          LogService.error('HermesAgent', `Réponse non-OK`, { status: response.status, body: rawErr });
          let errMsg = `Erreur HTTP Hermes: ${response.status}`;
          try { errMsg = `Hermes Agent API Error: ${JSON.parse(rawErr)?.error?.message || rawErr}`; } catch {}
          throw new Error(errMsg);
        }

        // ── Streaming path ─────────────────────────────────────────────────
        if (useStreaming && response.body) {
          return await this.parseHermesStream(response, onToken!, messages, callbacks, onToolCall, endpoint, headers, hermesModel);
        }

        // ── Non-streaming path ─────────────────────────────────────────────
        const data = await response.json();
        const choice = data.choices?.[0];
        const finishReason: string = choice?.finish_reason || 'stop';
        const assistantMsg = choice?.message;

        LogService.debug('HermesAgent', `finish_reason=${finishReason}`, {
          toolCalls: assistantMsg?.tool_calls?.length || 0
        });

        // ── Tool calls requested by Hermes ────────────────────────────────
        if (finishReason === 'tool_calls' && assistantMsg?.tool_calls && useTools) {
          // Append assistant's tool_call message
          messages.push(assistantMsg);

          for (const tc of assistantMsg.tool_calls) {
            const toolName: string = tc.function?.name || 'unknown';
            LogService.info('HermesAgent', `Tool call: ${toolName}`, tc.function?.arguments);
            onToolCall?.(toolName);

            const result = await executeTool(tc.id, toolName, tc.function?.arguments || '{}', callbacks!);
            messages.push(result);
          }

          // Continue loop — send tool results back to Hermes
          continue;
        }

        // ── Final text response ───────────────────────────────────────────
        const content = assistantMsg?.content || "Désolé, je n'ai pas reçu de réponse de Hermes Agent.";
        LogService.debug('HermesAgent', 'Réponse finale', { preview: content.slice(0, 200) });
        return content;

      } catch (e: any) {
        clearTimeout(timeoutId);
        if (e.name === 'AbortError') {
          throw new Error(`Hermes Agent: timeout dépassé (${REQUEST_TIMEOUT_MS / 1000}s)`);
        }
        LogService.error('HermesAgent', `Exception [iter=${iteration}]`, { message: e.message, stack: e.stack });
        throw new Error(`Échec de connexion à Hermes Agent (${e.message || e})`);
      }
    }

    throw new Error('Hermes Agent: boucle tool_calls dépassée (max 5 itérations)');
  }

  // ── SSE Stream Parser ────────────────────────────────────────────────────
  private static async parseHermesStream(
    response: Response,
    onToken: (token: string) => void,
    messages: any[],
    callbacks: AppCallbacks | undefined,
    onToolCall: ((name: string) => void) | undefined,
    endpoint: string,
    headers: Record<string, string>,
    model: string
  ): Promise<string> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';
    let buffer = '';
    const pendingToolCalls: Record<string, any> = {};

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6).trim();
        if (jsonStr === '[DONE]') break;

        try {
          const chunk = JSON.parse(jsonStr);
          const delta = chunk.choices?.[0]?.delta;
          const finishReason = chunk.choices?.[0]?.finish_reason;

          // Accumulate text token
          if (delta?.content) {
            fullContent += delta.content;
            onToken(delta.content);
          }

          // Accumulate tool calls across chunks
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!pendingToolCalls[idx]) {
                pendingToolCalls[idx] = { id: tc.id, function: { name: tc.function?.name || '', arguments: '' } };
              }
              if (tc.function?.name) pendingToolCalls[idx].function.name = tc.function.name;
              if (tc.function?.arguments) pendingToolCalls[idx].function.arguments += tc.function.arguments;
            }
          }

          // On finish, process any accumulated tool calls
          if (finishReason === 'tool_calls' && callbacks) {
            messages.push({ role: 'assistant', content: null, tool_calls: Object.values(pendingToolCalls) });
            for (const tc of Object.values(pendingToolCalls) as any[]) {
              const toolName = tc.function?.name;
              LogService.info('HermesAgent', `[stream] Tool call: ${toolName}`);
              onToolCall?.(toolName);
              const result = await executeTool(tc.id, toolName, tc.function?.arguments || '{}', callbacks);
              messages.push(result);
            }
            // Re-call non-streaming to get final answer after tools
            LogService.info('HermesAgent', 'Re-calling after stream tool_calls');
            const followAbort = new AbortController();
            const followTimeout = setTimeout(() => followAbort.abort(), 60_000);
            const followUp = await fetch(endpoint, {
              method: 'POST', headers, signal: followAbort.signal,
              body: JSON.stringify({ model, messages, temperature: 0.7, tools: HERMES_TOOLS, tool_choice: 'auto' })
            });
            clearTimeout(followTimeout);
            const followData = await followUp.json();
            const finalContent = followData.choices?.[0]?.message?.content || '';
            onToken(finalContent);
            return fullContent + finalContent;
          }
        } catch { /* skip malformed SSE chunk */ }
      }
    }

    return fullContent || "Désolé, je n'ai pas reçu de réponse de Hermes Agent.";
  }

}
