import { fetchWithSignal } from '@/lib/utils/cancellation';
import { Ollama } from 'ollama';
import BaseEmbedding from '../../base/embedding';
import { Chunk } from '@/lib/types';

type OllamaConfig = {
  model: string;
  baseURL?: string;
};

class OllamaEmbedding extends BaseEmbedding<OllamaConfig> {
  ollamaClient: Ollama;

  constructor(protected config: OllamaConfig) {
    super(config);

    this.ollamaClient = new Ollama({
      host: this.config.baseURL || 'http://localhost:11434',
    });
  }

  private client(signal?: AbortSignal): Ollama {
    return signal
      ? new Ollama({
          host: this.config.baseURL || 'http://localhost:11434',
          fetch: fetchWithSignal(signal),
        })
      : this.ollamaClient;
  }

  async embedText(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    const response = await this.client(signal).embed({
      input: texts,
      model: this.config.model,
    });

    return response.embeddings;
  }

  async embedChunks(
    chunks: Chunk[],
    signal?: AbortSignal,
  ): Promise<number[][]> {
    const response = await this.client(signal).embed({
      input: chunks.map((c) => c.content),
      model: this.config.model,
    });

    return response.embeddings;
  }
}

export default OllamaEmbedding;
