import type { infer as Infer } from 'zod';
import BaseLLM from './base/llm';
import BaseEmbedding from './base/embedding';
import { GenerateTextInput, GenerateObjectInput } from './types';
import { Chunk } from '@/lib/types';
import { abortable, abortableStream } from '@/lib/utils/cancellation';

export class CancellableLLM extends BaseLLM<null> {
  constructor(
    private model: BaseLLM<any>,
    private signal: AbortSignal,
  ) {
    super(null);
  }
  generateText(input: GenerateTextInput) {
    return abortable(
      () => this.model.generateText({ ...input, signal: this.signal }),
      this.signal,
    );
  }
  streamText(input: GenerateTextInput) {
    return abortableStream(
      this.model.streamText({ ...input, signal: this.signal }),
      this.signal,
    );
  }
  generateObject<T>(input: GenerateObjectInput): Promise<Infer<T>> {
    return abortable(
      () => this.model.generateObject<T>({ ...input, signal: this.signal }),
      this.signal,
    );
  }
  streamObject<T>(
    input: GenerateObjectInput,
  ): AsyncGenerator<Partial<Infer<T>>> {
    return abortableStream(
      this.model.streamObject<T>({ ...input, signal: this.signal }),
      this.signal,
    );
  }
}

export class CancellableEmbedding extends BaseEmbedding<null> {
  constructor(
    private model: BaseEmbedding<any>,
    private signal: AbortSignal,
  ) {
    super(null);
  }
  embedText(texts: string[], parentSignal?: AbortSignal) {
    const signal = parentSignal
      ? AbortSignal.any([this.signal, parentSignal])
      : this.signal;
    return abortable(() => this.model.embedText(texts, signal), signal);
  }
  embedChunks(chunks: Chunk[], parentSignal?: AbortSignal) {
    const signal = parentSignal
      ? AbortSignal.any([this.signal, parentSignal])
      : this.signal;
    return abortable(() => this.model.embedChunks(chunks, signal), signal);
  }
}
