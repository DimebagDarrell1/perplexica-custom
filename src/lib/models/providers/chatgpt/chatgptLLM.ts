import OpenAI, { APIError } from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { parse } from 'partial-json';
import z from 'zod';
import { repairJson } from '@toolsycc/json-repair';
import BaseLLM from '../../base/llm';
import {
  GenerateObjectInput,
  GenerateTextInput,
  GenerateTextOutput,
  StreamTextOutput,
  ToolCall,
} from '../../types';
import { Message } from '@/lib/types';
import {
  ChatGPTAuthError,
  getAccessToken,
  RESOURCE,
  USAGE_URL,
} from '@/lib/chatgpt/auth';

type ChatGPTPlanConfig = { model: string };

/** Plan requests take function tools only when grouped in a namespace. */
export const TOOL_NAMESPACE = 'research';

/**
 * Converts chat messages to Responses input. Plan requests reject system
 * items, so system text moves to `instructions`.
 */
export const toResponsesInput = (messages: Message[]) => {
  const instructions: string[] = [];
  const input: any[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      instructions.push(message.content);
    } else if (message.role === 'user') {
      input.push({ role: 'user', content: message.content });
    } else if (message.role === 'assistant') {
      if (message.content) {
        input.push({ role: 'assistant', content: message.content });
      }
      for (const call of message.tool_calls ?? []) {
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          namespace: TOOL_NAMESPACE,
          arguments: JSON.stringify(call.arguments ?? {}),
        });
      }
    } else if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.id,
        output: message.content,
      });
    }
  }
  return { instructions: instructions.join('\n\n') || undefined, input };
};

const toToolSchema = (schema: z.ZodTypeAny) => {
  const { $schema, ...parameters } = z.toJSONSchema(schema) as Record<
    string,
    unknown
  >;
  return parameters;
};

const parseArguments = (raw: string) => {
  try {
    return parse(raw.trim() || '{}') ?? {};
  } catch {
    return {};
  }
};

/** Turns plan-route failures into messages a person can act on. */
export const describePlanError = (error: unknown): Error => {
  if (error instanceof ChatGPTAuthError) return error;
  const code: string =
    (error as any)?.code ??
    (error as any)?.error?.code ??
    (error as any)?.response?.error?.code ??
    '';
  const status: number | undefined = (error as any)?.status;
  const detail =
    (error as any)?.error?.detail ?? (error as any)?.message ?? 'Unknown error';
  const messages: Record<string, string> = {
    subscription_sharing_usage_limit_exceeded: `Your ChatGPT plan usage limit for Perplexica was reached. Review it at ${USAGE_URL}.`,
    subscription_sharing_user_not_eligible:
      'This ChatGPT account or workspace cannot use its plan in Perplexica.',
    subscription_sharing_usage_unavailable:
      'ChatGPT could not check plan usage right now. Try again shortly.',
    subscription_sharing_user_unavailable:
      'ChatGPT account details are temporarily unavailable. Try again shortly.',
    subscription_sharing_invalid_user:
      'ChatGPT did not accept this sign-in. Sign in again in Settings → Models.',
    subscription_sharing_route_not_supported:
      'ChatGPT plan usage does not support this request route.',
  };
  if (messages[code]) return new Error(messages[code]);
  if (code === 'subscription_sharing_unsupported_capability') {
    const param = (error as any)?.param ?? (error as any)?.error?.param;
    return new Error(
      `ChatGPT plan usage does not support part of this request${param ? ` (${param})` : ''}.`,
    );
  }
  if (status === 401)
    return new Error(
      'ChatGPT did not accept this sign-in. Sign in again in Settings → Models.',
    );
  if (status === 403)
    return new Error(`ChatGPT plan usage was refused: ${detail}`);
  if (status === 503)
    return new Error('ChatGPT plan usage is temporarily unavailable.');
  if (error instanceof Error) return error;
  return new Error(String(detail));
};

type StreamEvent = { type: string; [key: string]: any };

class ChatGPTPlanLLM extends BaseLLM<ChatGPTPlanConfig> {
  constructor(protected config: ChatGPTPlanConfig) {
    super(config);
  }

  private async *events(
    messages: Message[],
    extra: Record<string, unknown>,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    const { instructions, input } = toResponsesInput(messages);
    let completed = false;
    try {
      const client = new OpenAI({
        apiKey: await getAccessToken(),
        baseURL: RESOURCE,
        maxRetries: 0,
      });
      // Plan usage requires store: false and stream: true, and rejects
      // temperature, top_p and max_output_tokens.
      const stream = await client.responses.create(
        {
          model: this.config.model,
          instructions,
          input,
          store: false,
          stream: true,
          ...extra,
        } as any,
        { signal },
      );
      for await (const event of stream as unknown as AsyncIterable<StreamEvent>) {
        if (event.type === 'response.failed') {
          const failure = event.response?.error ?? {};
          throw Object.assign(
            new Error(failure.message || 'The ChatGPT response failed.'),
            { code: failure.code, param: failure.param },
          );
        }
        if (event.type === 'error') {
          throw Object.assign(
            new Error(event.message || 'The ChatGPT response failed.'),
            { code: event.code, param: event.param },
          );
        }
        if (event.type === 'response.incomplete') {
          const reason = event.response?.incomplete_details?.reason;
          throw new Error(
            `The ChatGPT response stopped early${reason ? ` (${reason})` : ''}.`,
          );
        }
        if (event.type === 'response.completed') completed = true;
        yield event;
      }
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof APIError && !(error as any).code) {
        (error as any).code = (error.error as any)?.code;
      }
      throw describePlanError(error);
    }
    if (!completed) {
      signal?.throwIfAborted();
      throw new Error('The ChatGPT response ended before it completed.');
    }
  }

  async *streamText(
    input: GenerateTextInput,
  ): AsyncGenerator<StreamTextOutput> {
    const tools = input.tools?.length
      ? [
          {
            type: 'namespace',
            name: TOOL_NAMESPACE,
            description: 'Tools for researching the user question.',
            tools: input.tools.map((tool) => ({
              type: 'function',
              name: tool.name,
              description: tool.description,
              parameters: toToolSchema(tool.schema),
            })),
          },
        ]
      : undefined;
    const calls = new Map<string, { id: string; name: string; raw: string }>();
    const snapshot = (call: { id: string; name: string; raw: string }) =>
      ({
        id: call.id,
        name: call.name,
        arguments: parseArguments(call.raw),
      }) satisfies ToolCall;

    for await (const event of this.events(
      input.messages,
      tools ? { tools } : {},
      input.signal,
    )) {
      if (event.type === 'response.output_text.delta' && event.delta) {
        yield { contentChunk: event.delta, toolCallChunk: [] };
      } else if (
        event.type === 'response.output_item.added' &&
        event.item?.type === 'function_call'
      ) {
        const call = {
          id: event.item.call_id,
          name: event.item.name,
          raw: event.item.arguments || '',
        };
        calls.set(event.item.id, call);
        yield { contentChunk: '', toolCallChunk: [snapshot(call)] };
      } else if (event.type === 'response.function_call_arguments.delta') {
        const call = calls.get(event.item_id);
        if (call) {
          call.raw += event.delta || '';
          yield { contentChunk: '', toolCallChunk: [snapshot(call)] };
        }
      } else if (
        event.type === 'response.output_item.done' &&
        event.item?.type === 'function_call'
      ) {
        const call = calls.get(event.item.id) ?? {
          id: event.item.call_id,
          name: event.item.name,
          raw: '',
        };
        call.raw = event.item.arguments || call.raw;
        calls.set(event.item.id, call);
        yield { contentChunk: '', toolCallChunk: [snapshot(call)] };
      } else if (event.type === 'response.completed') {
        yield { contentChunk: '', toolCallChunk: [], done: true };
      }
    }
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextOutput> {
    let content = '';
    const toolCalls = new Map<string, ToolCall>();
    for await (const chunk of this.streamText(input)) {
      content += chunk.contentChunk;
      for (const call of chunk.toolCallChunk) toolCalls.set(call.id, call);
    }
    return { content, toolCalls: Array.from(toolCalls.values()) };
  }

  async generateObject<T>(input: GenerateObjectInput): Promise<T> {
    let text = '';
    for await (const event of this.events(
      input.messages,
      { text: { format: zodTextFormat(input.schema, 'object') } },
      input.signal,
    )) {
      if (event.type === 'response.output_text.delta' && event.delta)
        text += event.delta;
    }
    try {
      return input.schema.parse(
        JSON.parse(repairJson(text, { extractJson: true }) as string),
      ) as T;
    } catch (error) {
      throw new Error(
        `Could not read the structured ChatGPT response: ${error}`,
      );
    }
  }

  async *streamObject<T>(input: GenerateObjectInput): AsyncGenerator<T> {
    let text = '';
    for await (const event of this.events(
      input.messages,
      { text: { format: zodTextFormat(input.schema, 'object') } },
      input.signal,
    )) {
      if (event.type === 'response.output_text.delta' && event.delta) {
        text += event.delta;
        yield parseArguments(text) as T;
      }
    }
  }
}

export default ChatGPTPlanLLM;
