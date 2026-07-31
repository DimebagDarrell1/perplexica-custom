import BaseEmbedding from '@/lib/models/base/embedding';
import computeSimilarity from '@/lib/utils/computeSimilarity';
import { splitText } from '@/lib/utils/splitText';
import type { Chunk } from '@/lib/types';
import Scraper from '@/lib/scraper';
import {
  buildDiverseCandidatePool,
  dedupeEvidenceChunks,
  dedupeSearchResults,
  groupEvidenceBySource,
} from './resultUtils';

const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) {
    throw new DOMException('Context filter pipeline aborted', 'AbortError');
  }
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the two-stage context filtering pipeline.
 */
export type ContextFilterConfig = {
  /** Maximum number of URLs to scrape after relevance ranking (default: 10) */
  topKUrls: number;
  /** Maximum number of relevant chunks to select from all scraped content (default: 30) */
  topKChunks: number;
  /** Maximum tokens per chunk when splitting scraped pages (default: 512) */
  chunkMaxTokens: number;
  /** Overlap tokens between chunks (default: 64) */
  chunkOverlapTokens: number;
  /** Maximum character length for a single scraped page before chunking (default: 50000) */
  maxPageLength: number;
  /** Maximum search snippets to embed before scraping. */
  maxCandidateResults: number;
  /** Prefer Firecrawl before native extraction for deep reading. */
  preferFirecrawl: boolean;
};

const DEFAULT_CONFIG: ContextFilterConfig = {
  topKUrls: 10,
  topKChunks: 30,
  chunkMaxTokens: 512,
  chunkOverlapTokens: 64,
  maxPageLength: 50000,
  maxCandidateResults: 36,
  preferFirecrawl: false,
};

const MAX_SNIPPET_EMBEDDING_CHARS = 8000;

const formatSnippetForEmbedding = (chunk: Chunk): string => {
  const text = `${chunk.metadata.title || ''} ${chunk.content}`;
  return text.length > MAX_SNIPPET_EMBEDDING_CHARS
    ? text.slice(0, MAX_SNIPPET_EMBEDDING_CHARS)
    : text;
};

// ---------------------------------------------------------------------------
// Stage 1 — Rank search result snippets by embedding similarity
// ---------------------------------------------------------------------------

/**
 * Stage 1: Rank search result snippets by embedding similarity to the query.
 * Returns the top-K results sorted by relevance score (descending).
 *
 * The computed query embedding is returned alongside the results so that
 * callers (Stage 3) can reuse it instead of computing it again.
 */
export const rankResultsByRelevance = async (
  query: string,
  results: Chunk[],
  embeddingModel: BaseEmbedding<any>,
  topK: number,
): Promise<{
  rankedResults: { chunk: Chunk; score: number }[];
  queryEmbedding: number[];
}> => {
  if (results.length === 0) return { rankedResults: [], queryEmbedding: [] };

  // Embed the query
  const [queryEmbedding] = await embeddingModel.embedText([query]);

  // Embed all result snippets
  const snippetTexts = results.map(formatSnippetForEmbedding);
  const snippetEmbeddings = await embeddingModel.embedText(snippetTexts);

  // Score each result by cosine similarity
  const scored = results.map((chunk, i) => ({
    chunk,
    score: computeSimilarity(queryEmbedding, snippetEmbeddings[i]),
  }));

  // Sort by score descending, take top-K
  scored.sort((a, b) => b.score - a.score);

  return {
    rankedResults: scored.slice(0, topK),
    queryEmbedding,
  };
};

// ---------------------------------------------------------------------------
// Stage 2 — Scrape the top-K relevant URLs
// ---------------------------------------------------------------------------

/**
 * Stage 2: Scrape the top-K relevant URLs and convert HTML to markdown.
 * Fetches pages in parallel with a concurrency limit.
 * URLs pointing to private/internal networks are silently skipped (SSRF protection).
 */
export const scrapeRelevantUrls = async (
  rankedResults: { chunk: Chunk; score: number }[],
  maxPageLength: number,
  preferFirecrawl: boolean,
  signal?: AbortSignal,
): Promise<
  {
    url: string;
    title: string;
    content: string;
    provider: string;
    cached: boolean;
  }[]
> => {
  const CONCURRENCY_LIMIT = 5;

  const truncateContent = (content: string) =>
    content.length > maxPageLength
      ? content.slice(0, maxPageLength) +
        '\n\n[Content truncated due to length]'
      : content;

  const urls = [
    ...new Set(
      rankedResults
        .map((r) => r.chunk.metadata.url)
        .filter((url): url is string => !!url),
    ),
  ];

  const results: {
    url: string;
    title: string;
    content: string;
    provider: string;
    cached: boolean;
  }[] = [];

  // Process URLs in batches to avoid overwhelming the network
  for (let i = 0; i < urls.length; i += CONCURRENCY_LIMIT) {
    throwIfAborted(signal);

    const batch = urls.slice(i, i + CONCURRENCY_LIMIT);

    const batchResults = await Promise.allSettled(
      batch.map(async (url) => {
        try {
          throwIfAborted(signal);
          const scraped = await Scraper.scrape(url, {
            preferFirecrawl,
            signal,
          });

          return {
            url: scraped.url,
            title: scraped.title,
            content: truncateContent(scraped.content),
            provider: scraped.provider,
            cached: scraped.cached === true,
          };
        } catch {
          return null;
        }
      }),
    );

    for (const result of batchResults) {
      if (result.status === 'fulfilled' && result.value) {
        results.push(result.value);
      }
    }
  }

  return results;
};

// ---------------------------------------------------------------------------
// Stage 3 — Select the most relevant chunks via RRF
// ---------------------------------------------------------------------------

/**
 * Stage 3: Split scraped page content into chunks, embed them,
 * and select the most relevant chunks using embedding similarity.
 * Uses Reciprocal Rank Fusion (RRF) for combining scores across
 * the query and standalone follow-up, matching the pattern in UploadStore.
 *
 * Accepts an optional pre-computed `queryEmbedding` to avoid redundant
 * embedding API calls when the caller already has it from Stage 1.
 */
export const selectRelevantChunks = async (
  query: string,
  standaloneFollowUp: string | undefined,
  scrapedPages: {
    url: string;
    title: string;
    content: string;
    provider: string;
    cached: boolean;
  }[],
  embeddingModel: BaseEmbedding<any>,
  config: ContextFilterConfig,
  queryEmbedding?: number[],
  signal?: AbortSignal,
): Promise<Chunk[]> => {
  if (scrapedPages.length === 0) return [];
  throwIfAborted(signal);

  // Split each page into chunks
  const allChunks: {
    content: string;
    url: string;
    title: string;
    provider: string;
    cached: boolean;
  }[] = [];

  scrapedPages.forEach((page) => {
    const chunks = splitText(
      page.content,
      config.chunkMaxTokens,
      config.chunkOverlapTokens,
    );

    chunks.forEach((chunkText) => {
      allChunks.push({
        content: chunkText,
        url: page.url,
        title: page.title,
        provider: page.provider,
        cached: page.cached,
      });
    });
  });

  if (allChunks.length === 0) return [];
  throwIfAborted(signal);

  // Embed all chunks
  const chunkTexts = allChunks.map((c) => c.content);
  const chunkEmbeddings = await embeddingModel.embedText(chunkTexts);
  throwIfAborted(signal);

  // Build queries: always include the main query, optionally the standalone follow-up
  const queries = [query];
  if (standaloneFollowUp && standaloneFollowUp !== query) {
    queries.push(standaloneFollowUp);
  }

  // Re-use the pre-computed query embedding for the main query if available;
  // only embed queries we don't already have embeddings for.
  let queryEmbeddings: number[][];
  if (queryEmbedding && queryEmbedding.length > 0) {
    queryEmbeddings = [queryEmbedding];
    // Only embed the standalone follow-up if it differs from the main query
    if (standaloneFollowUp && standaloneFollowUp !== query) {
      const [sfuEmbedding] = await embeddingModel.embedText([
        standaloneFollowUp,
      ]);
      throwIfAborted(signal);
      queryEmbeddings.push(sfuEmbedding);
    }
  } else {
    queryEmbeddings = await embeddingModel.embedText(queries);
    throwIfAborted(signal);
  }

  // Score chunks against each query using RRF (same pattern as UploadStore)
  const k = 60; // RRF smoothing parameter
  const scoreMap = new Map<number, number>(); // chunkIndex -> RRF score

  for (const qe of queryEmbeddings) {
    const similarities = allChunks.map((_, idx) => ({
      idx,
      score: computeSimilarity(qe, chunkEmbeddings[idx]),
    }));

    similarities.sort((a, b) => b.score - a.score);

    similarities.forEach((item, rank) => {
      const currentScore = scoreMap.get(item.idx) || 0;
      scoreMap.set(item.idx, currentScore + 1 / (rank + 1 + k));
    });
  }

  // Sort by combined RRF score, take top-K chunks
  const rankedChunkIndices = Array.from(scoreMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, config.topKChunks)
    .map(([idx]) => idx);

  // Group selected chunks by source URL for organized output
  const selectedChunks: Chunk[] = rankedChunkIndices.map((idx) => ({
    content: allChunks[idx].content,
    metadata: {
      title: allChunks[idx].title,
      url: allChunks[idx].url,
      extractionProvider: allChunks[idx].provider,
      extractionCached: allChunks[idx].cached,
    },
  }));

  return selectedChunks;
};

const selectRelevantExistingChunks = async (
  query: string,
  standaloneFollowUp: string | undefined,
  chunks: Chunk[],
  embeddingModel: BaseEmbedding<any>,
  topK: number,
  signal?: AbortSignal,
): Promise<Chunk[]> => {
  if (chunks.length === 0) return [];
  throwIfAborted(signal);

  const queries = [query];
  if (standaloneFollowUp && standaloneFollowUp !== query) {
    queries.push(standaloneFollowUp);
  }

  const [queryEmbeddings, chunkEmbeddings] = await Promise.all([
    embeddingModel.embedText(queries),
    embeddingModel.embedText(chunks.map((chunk) => chunk.content)),
  ]);
  throwIfAborted(signal);

  const k = 60;
  const scoreMap = new Map<number, number>();

  queryEmbeddings.forEach((queryEmbedding) => {
    const similarities = chunks.map((_, idx) => ({
      idx,
      score: computeSimilarity(queryEmbedding, chunkEmbeddings[idx]),
    }));

    similarities.sort((a, b) => b.score - a.score);

    similarities.forEach((item, rank) => {
      const currentScore = scoreMap.get(item.idx) || 0;
      scoreMap.set(item.idx, currentScore + 1 / (rank + 1 + k));
    });
  });

  return Array.from(scoreMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([idx]) => chunks[idx]);
};

// ---------------------------------------------------------------------------
// Public pipeline entry point
// ---------------------------------------------------------------------------

/**
 * Full two-stage pipeline: Rank → Scrape → Select relevant chunks.
 * Takes the researcher's search findings and produces a focused, deep context
 * for the writer LLM.
 *
 * @param query - The user's original follow-up question
 * @param standaloneFollowUp - The classifier's standalone reformulation of the query
 * @param searchFindings - Raw search result snippets from the researcher
 * @param embeddingModel - The embedding model to use for similarity scoring
 * @param config - Optional configuration overrides
 * @returns Filtered and deeply-read chunks ready for the writer prompt
 */
export const buildFilteredContext = async (
  query: string,
  standaloneFollowUp: string | undefined,
  searchFindings: Chunk[],
  embeddingModel: BaseEmbedding<any>,
  config: Partial<ContextFilterConfig> = {},
  signal?: AbortSignal,
): Promise<Chunk[]> => {
  const fullConfig = { ...DEFAULT_CONFIG, ...config };
  const startedAt = Date.now();

  if (searchFindings.length === 0) return [];
  throwIfAborted(signal);

  const uploadedFileFindings = dedupeEvidenceChunks(
    searchFindings.filter((finding) =>
      String(finding.metadata.url || '').startsWith('file_id://'),
    ),
  );
  const webFindings = dedupeSearchResults(
    searchFindings.filter(
      (finding) => !String(finding.metadata.url || '').startsWith('file_id://'),
    ),
  );

  let selectedUploadChunks: Chunk[] = [];
  if (uploadedFileFindings.length > 0) {
    const uploadChunkBudget = Math.min(
      uploadedFileFindings.length,
      Math.max(5, Math.floor(fullConfig.topKChunks / 3)),
    );

    selectedUploadChunks = await selectRelevantExistingChunks(
      query,
      standaloneFollowUp,
      uploadedFileFindings,
      embeddingModel,
      uploadChunkBudget,
      signal,
    );

    console.log(
      `[ContextFilter] Preserved ${selectedUploadChunks.length} uploaded file chunks for writer`,
    );
  }

  if (webFindings.length === 0) {
    return groupEvidenceBySource(selectedUploadChunks);
  }

  // Stage 1: Rank results by relevance (also returns the query embedding)
  const candidateWebFindings = buildDiverseCandidatePool(
    webFindings,
    fullConfig.maxCandidateResults,
  );

  const { rankedResults, queryEmbedding } = await rankResultsByRelevance(
    query,
    candidateWebFindings,
    embeddingModel,
    fullConfig.topKUrls,
  );
  throwIfAborted(signal);

  console.log(
    `[ContextFilter] Ranked results, top ${rankedResults.length} URLs selected for deep reading`,
  );

  // Stage 2: Scrape the top-ranked URLs
  const scrapedPages = await scrapeRelevantUrls(
    rankedResults,
    fullConfig.maxPageLength,
    fullConfig.preferFirecrawl,
    signal,
  );
  throwIfAborted(signal);

  console.log(
    `[ContextFilter] Scraped ${scrapedPages.length} pages successfully`,
  );

  // Stage 3: Select the most relevant chunks from scraped content
  // Pass the pre-computed query embedding to avoid a redundant embedding call.
  const selectedChunks = await selectRelevantChunks(
    query,
    standaloneFollowUp,
    scrapedPages,
    embeddingModel,
    fullConfig,
    queryEmbedding,
    signal,
  );

  console.log(
    `[ContextFilter] Selected ${selectedChunks.length} relevant chunks for writer`,
  );

  const combinedChunks = [...selectedUploadChunks, ...selectedChunks];

  if (combinedChunks.length === 0 && webFindings.length > 0) {
    console.warn(
      '[ContextFilter] Deep reading returned no chunks, falling back to top snippets',
    );
    return dedupeSearchResults(webFindings).slice(0, fullConfig.topKChunks);
  }

  const selectedEvidence = dedupeEvidenceChunks(combinedChunks).slice(
    0,
    fullConfig.topKChunks,
  );
  const groupedEvidence = groupEvidenceBySource(selectedEvidence);
  const providerCounts = scrapedPages.reduce<Record<string, number>>(
    (counts, page) => {
      counts[page.provider] = (counts[page.provider] || 0) + 1;
      return counts;
    },
    {},
  );

  console.log(
    JSON.stringify({
      event: 'research_context_pipeline',
      inputFindings: searchFindings.length,
      webFindings: webFindings.length,
      uploadFindings: uploadedFileFindings.length,
      candidates: candidateWebFindings.length,
      rankedUrls: rankedResults.length,
      scrapedPages: scrapedPages.length,
      extractionProviders: providerCounts,
      selectedChunks: selectedEvidence.length,
      citationSources: groupedEvidence.length,
      durationMs: Date.now() - startedAt,
    }),
  );

  return groupedEvidence;
};
