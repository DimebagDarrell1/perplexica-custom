import { UIConfigField } from '@/lib/config/types';
import { getConfiguredModelProviderById } from '@/lib/config/serverRegistry';
import { getAccessToken, getStatus, RESOURCE } from '@/lib/chatgpt/auth';
import { Model, ModelList, ProviderMetadata } from '../../types';
import BaseEmbedding from '../../base/embedding';
import BaseModelProvider from '../../base/provider';
import BaseLLM from '../../base/llm';
import ChatGPTPlanLLM from './chatgptLLM';

type ChatGPTPlanConfig = Record<string, never>;

const MODEL_CACHE_MS = 10 * 60 * 1000;
let modelCache: { models: Model[]; fetchedAt: number } | undefined;

export const clearChatGPTModelCache = () => {
  modelCache = undefined;
};

/** The signed-in account's own catalog, as OpenAI asks plan apps to use. */
const fetchPlanModels = async (): Promise<Model[]> => {
  if (modelCache && Date.now() - modelCache.fetchedAt < MODEL_CACHE_MS)
    return modelCache.models;
  const response = await fetch(`${RESOURCE}/models`, {
    headers: { Authorization: `Bearer ${await getAccessToken()}` },
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok)
    throw new Error(`ChatGPT model list returned HTTP ${response.status}`);
  const body = await response.json();
  const models: Model[] = Array.isArray(body?.models)
    ? body.models
        .filter((m: any) => m?.slug && (m.visibility ?? 'list') === 'list')
        .map((m: any) => ({
          key: String(m.slug),
          name: String(m.display_name || m.slug),
        }))
    : Array.isArray(body?.data)
      ? body.data
          .filter((m: any) => typeof m?.id === 'string')
          .map((m: any) => ({ key: m.id, name: m.id }))
      : [];
  modelCache = { models, fetchedAt: Date.now() };
  return models;
};

class ChatGPTPlanProvider extends BaseModelProvider<ChatGPTPlanConfig> {
  constructor(id: string, name: string, config: ChatGPTPlanConfig) {
    super(id, name, config);
  }

  async getDefaultModels(): Promise<ModelList> {
    const status = getStatus();
    if (!status.signedIn || !status.planEnabled)
      return { chat: [], embedding: [] };
    return { chat: await fetchPlanModels(), embedding: [] };
  }

  async getModelList(): Promise<ModelList> {
    const defaults = await this.getDefaultModels();
    const configured = getConfiguredModelProviderById(this.id);
    const chat = [...defaults.chat];
    for (const model of configured?.chatModels ?? []) {
      if (!chat.some((m) => m.key === model.key)) chat.push(model);
    }
    return { chat, embedding: [] };
  }

  async loadChatModel(key: string): Promise<BaseLLM<any>> {
    return new ChatGPTPlanLLM({ model: key });
  }

  async loadEmbeddingModel(): Promise<BaseEmbedding<any>> {
    throw new Error(
      'ChatGPT plans do not include embedding models. Choose another embedding provider.',
    );
  }

  static parseAndValidate(): ChatGPTPlanConfig {
    return {};
  }

  static getProviderConfigFields(): UIConfigField[] {
    return [];
  }

  static getProviderMetadata(): ProviderMetadata {
    return {
      key: 'chatgpt',
      name: 'ChatGPT plan',
    };
  }
}

export default ChatGPTPlanProvider;
