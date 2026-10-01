import { Chunk } from '@/lib/types';

abstract class BaseEmbedding<CONFIG> {
  constructor(protected config: CONFIG) {}
  abstract embedText(
    texts: string[],
    signal?: AbortSignal,
  ): Promise<number[][]>;
  abstract embedChunks(
    chunks: Chunk[],
    signal?: AbortSignal,
  ): Promise<number[][]>;
}

export default BaseEmbedding;
