import type { Chunk } from '@/lib/types';

const QUERY_STOP_WORDS = new Set(
  'a an and are as at be by can could do does for from give how i in is it me of on or some tell that the their them these they this to was were what when where which who why will with would you your about cool facts interesting meaning please'.split(
    ' ',
  ),
);

const words = (text: string): string[] =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) || [];

const queryWords = (query: string) =>
  [...new Set(words(query))].filter(
    (word) => word.length > 1 && !QUERY_STOP_WORDS.has(word),
  );

/** Lexical recovery when semantic ranking is unavailable, not a fact check. */
export const selectFallbackSnippets = (
  query: string,
  chunks: Chunk[],
  preserveRanking = false,
): Chunk[] => {
  // Completed semantic or Jev ranking can match synonyms without shared words.
  if (preserveRanking) return chunks;
  const terms = queryWords(query);
  if (!terms.length) return chunks;
  const scored = chunks.map((chunk) => {
    const text = new Set(
      words(`${chunk.metadata.title || ''} ${chunk.content}`),
    );
    return {
      chunk,
      score: terms.filter((term) => text.has(term)).length,
    };
  });
  // Keep unmatched snippets when none match, including synonym-only queries.
  const matching = scored.filter((entry) => entry.score > 0);
  if (!matching.length) return chunks;
  matching.sort((a, b) => b.score - a.score);
  return matching.map((entry) => entry.chunk);
};

/** Bound passage embeddings while keeping matches near the end of long pages. */
export const selectPassagesForEmbedding = (
  query: string,
  passages: string[],
  limit: number,
): string[] => {
  if (passages.length <= limit) return passages;
  const terms = queryWords(query);
  return passages
    .map((content, index) => {
      const text = new Set(words(content));
      return {
        content,
        index,
        score: terms.filter((term) => text.has(term)).length,
      };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.content);
};
