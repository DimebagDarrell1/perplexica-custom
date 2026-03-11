import { UIConfigField } from '@/lib/config/types';
import { getConfiguredModelProviderById } from '@/lib/config/serverRegistry';
import { Model, ModelList, ProviderMetadata } from '../../types';
import BaseEmbedding from '../../base/embedding';
import BaseModelProvider from '../../base/provider';
import BaseLLM from '../../base/llm';
import OpenRouterLLM from './openrouterLLM';
import OpenAIEmbedding from '../openai/openaiEmbedding';

interface OpenRouterConfig {
    apiKey: string;
}

const providerConfigFields: UIConfigField[] = [
    {
        type: 'password',
        name: 'API Key',
        key: 'apiKey',
        description: 'Your OpenRouter API key',
        required: true,
        placeholder: 'OpenRouter API Key',
        env: 'OPENROUTER_API_KEY',
        scope: 'server',
    },
];

class OpenRouterProvider extends BaseModelProvider<OpenRouterConfig> {
    constructor(id: string, name: string, config: OpenRouterConfig) {
        super(id, name, config);
    }

    async getDefaultModels(): Promise<ModelList> {
        const res = await fetch(`https://openrouter.ai/api/v1/models`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
            },
        });

        const data = await res.json();

        const defaultChatModels: Model[] = [];

        data.data.forEach((m: any) => {
            defaultChatModels.push({
                key: m.id,
                name: m.name || m.id,
            });
        });

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
            throw new Error('Error Loading OpenRouter Chat Model. Invalid Model Selected');
        }

        return new OpenRouterLLM({
            apiKey: this.config.apiKey,
            model: key,
            baseURL: 'https://openrouter.ai/api/v1',
        });
    }

    async loadEmbeddingModel(key: string): Promise<BaseEmbedding<any>> {
        const modelList = await this.getModelList();
        const exists = modelList.embedding.find((m) => m.key === key);

        if (!exists) {
            throw new Error('Error Loading OpenRouter Embedding Model. Invalid Model Selected');
        }

        return new OpenAIEmbedding({
            apiKey: this.config.apiKey,
            model: key,
            baseURL: 'https://openrouter.ai/api/v1',
        });
    }

    static parseAndValidate(raw: any): OpenRouterConfig {
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
            key: 'openrouter',
            name: 'OpenRouter',
        };
    }
}

export default OpenRouterProvider;
