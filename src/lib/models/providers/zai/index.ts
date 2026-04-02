import { UIConfigField } from '@/lib/config/types';
import { getConfiguredModelProviderById } from '@/lib/config/serverRegistry';
import { Model, ModelList, ProviderMetadata } from '../../types';
import BaseEmbedding from '../../base/embedding';
import BaseModelProvider from '../../base/provider';
import BaseLLM from '../../base/llm';
import ZAILLM from './zaiLLM';
import OpenAIEmbedding from '../openai/openaiEmbedding';

const ZAI_BASE_URL = 'https://api.z.ai/api/paas/v4';

interface ZAIConfig {
  apiKey: string;
}

const providerConfigFields: UIConfigField[] = [
  {
    type: 'password',
    name: 'API Key',
    key: 'apiKey',
    description: 'Your Z.ai API key',
    required: true,
    placeholder: 'Z.ai API Key',
    env: 'ZAI_API_KEY',
    scope: 'server',
  },
];

class ZAIProvider extends BaseModelProvider<ZAIConfig> {
  constructor(id: string, name: string, config: ZAIConfig) {
    super(id, name, config);
  }

  async getDefaultModels(): Promise<ModelList> {
    const res = await fetch(`${ZAI_BASE_URL}/models`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
      },
    });

    const data = await res.json();

    const defaultChatModels: Model[] = [];

    if (data.data && Array.isArray(data.data)) {
      data.data.forEach((m: any) => {
        defaultChatModels.push({
          key: m.id,
          name: m.name || m.id,
        });
      });
    }

    return {
      embedding: [],
      chat: defaultChatModels,
    };
  }

  async getModelList(): Promise<ModelList> {
    const defaultModels = await this.getDefaultModels();
    const configProvider = getConfiguredModelProviderById(this.id)!;

    return {
      embedding: [
        ...defaultModels.embedding,
        ...(configProvider?.embeddingModels ?? []),
      ],
      chat: [...defaultModels.chat, ...(configProvider?.chatModels ?? [])],
    };
  }

  async loadChatModel(key: string): Promise<BaseLLM<any>> {
    const modelList = await this.getModelList();

    const exists = modelList.chat.find((m) => m.key === key);

    if (!exists) {
      throw new Error('Error Loading Z.ai Chat Model. Invalid Model Selected');
    }

    return new ZAILLM({
      apiKey: this.config.apiKey,
      model: key,
      baseURL: ZAI_BASE_URL,
    });
  }

  async loadEmbeddingModel(key: string): Promise<BaseEmbedding<any>> {
    const modelList = await this.getModelList();
    const exists = modelList.embedding.find((m) => m.key === key);

    if (!exists) {
      throw new Error(
        'Error Loading Z.ai Embedding Model. Invalid Model Selected',
      );
    }

    return new OpenAIEmbedding({
      apiKey: this.config.apiKey,
      model: key,
      baseURL: ZAI_BASE_URL,
    });
  }

  static parseAndValidate(raw: any): ZAIConfig {
    if (!raw || typeof raw !== 'object')
      throw new Error('Invalid config provided. Expected object');
    if (!raw.apiKey)
      throw new Error('Invalid config provided. API key must be provided');

    return {
      apiKey: String(raw.apiKey),
    };
  }

  static getProviderConfigFields(): UIConfigField[] {
    return providerConfigFields;
  }

  static getProviderMetadata(): ProviderMetadata {
    return {
      key: 'zai',
      name: 'Z.ai',
    };
  }
}

export default ZAIProvider;
