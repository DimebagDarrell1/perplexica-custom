import BaseEmbedding from '@/lib/models/base/embedding';
import computeSimilarity from '@/lib/utils/computeSimilarity';
import { splitText } from '@/lib/utils/splitText';
import { Chunk } from '@/lib/types';
import Scraper from '@/lib/scraper';
import TurnDown from 'turndown';

const turndownService = new TurnDown();

// ---------------------------------------------------------------------------
// SSRF protection
// ---------------------------------------------------------------------------

/**
 * Hostnames / IP patterns that must never be fetched from the server.
 * Covers loopback, private networks, link-local, and cloud metadata endpoints.
 */
const BLOCKED_HOST_PATTERNS =
  /^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.|::1|::ffff:|fe80:|fc00:|fd[0-9a-f]{2}:|0x[0-9a-f])/i;

/**
 * Check if a dotted-decimal IPv4 string falls within private/reserved ranges.
 */
const isPrivateIPv4 = (ip: string): boolean => {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255))
    return false;
  const [a, b] = parts;
  return (
    a === 0 || // 0.0.0.0/8
    a === 10 || // 10.0.0.0/8
    a === 127 || // 127.0.0.0/8
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
    (a === 192 && b === 168) || // 192.168.0.0/16
    (a === 169 && b === 254) // 169.254.0.0/16
  );
};

const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) {
    throw new DOMException('Context filter pipeline aborted', 'AbortError');
  }
};

/**
 * Returns `true` when the URL is safe to fetch from the server.
 * Rejects non-HTTP(S) schemes and private / internal IP ranges.
 *
 * Covers:
 *  - String-based hostname patterns (loopback, private nets, link-local, etc.)
 *  - Decimal IP representations (e.g. `2130706433` → 127.0.0.1)
 *  - IPv6-mapped IPv4 addresses (e.g. `::ffff:127.0.0.1`)
 *  - Hex-encoded IPs (e.g. `0x7f000001` → 127.0.0.1)
 */
const isSafeUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    const hostname = parsed.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets

    // String-based blocklist (covers localhost, named private ranges, etc.)
    if (BLOCKED_HOST_PATTERNS.test(hostname)) {
      return false;
    }

    // Decimal IP representation (e.g. "2130706433" → 127.0.0.1)
    if (/^\d+$/.test(hostname)) {
      const num = parseInt(hostname, 10);
      if (!isNaN(num) && num >= 0 && num <= 0xffffffff) {
        const ip = [
          (num >>> 24) & 0xff,
          (num >>> 16) & 0xff,
          (num >>> 8) & 0xff,
          num & 0xff,
        ].join('.');
        if (isPrivateIPv4(ip)) return false;
      }
    }

    // IPv6-mapped IPv4 (e.g. "::ffff:127.0.0.1")
    const ipv4Mapped = hostname.match(
      /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i,
    );
    if (ipv4Mapped && isPrivateIPv4(ipv4Mapped[1])) {
      return false;
    }

    // Hex-encoded IP (e.g. "0x7f000001" → 127.0.0.1)
    const hexMatch = hostname.match(/^0x([0-9a-f]+)$/i);
    if (hexMatch) {
      const num = parseInt(hexMatch[1], 16);
      if (!isNaN(num) && num >= 0 && num <= 0xffffffff) {
        const ip = [
          (num >>> 24) & 0xff,
          (num >>> 16) & 0xff,
          (num >>> 8) & 0xff,
          num & 0xff,
        ].join('.');
        if (isPrivateIPv4(ip)) return false;
      }
    }

    // Octal IP representation (e.g. "0177.0.0.1" → 127.0.0.1)
    const octalMatch = hostname.match(/^0[0-7]+(?:\.0[0-7]+){3}$/);
    if (octalMatch) {
      const parts = hostname.split('.');
      if (parts.length === 4 && parts.every((p) => /^0[0-7]+$/.test(p))) {
        const ip = parts.map((p) => parseInt(p, 8)).join('.');
        if (isPrivateIPv4(ip)) return false;
      }
    }

    return true;
  } catch {
    return false;
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
};

const DEFAULT_CONFIG: ContextFilterConfig = {
  topKUrls: 10,
  topKChunks: 30,
  chunkMaxTokens: 512,
  chunkOverlapTokens: 64,
  maxPageLength: 50000,
};

const MAX_SNIPPET_EMBEDDING_CHARS = 8000;
const MIN_USEFUL_MARKDOWN_CHARS = 500;

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
  signal?: AbortSignal,
): Promise<{ url: string; title: string; content: string }[]> => {
  const CONCURRENCY_LIMIT = 5;

  const truncateContent = (content: string) =>
    content.length > maxPageLength
      ? content.slice(0, maxPageLength) + '\n\n[Content truncated due to length]'
      : content;

  const urls = [
    ...new Set(
      rankedResults
        .map((r) => r.chunk.metadata.url)
        .filter((url): url is string => !!url && isSafeUrl(url)),
    ),
  ];

  const results: { url: string; title: string; content: string }[] = [];

  // Process URLs in batches to avoid overwhelming the network
  for (let i = 0; i < urls.length; i += CONCURRENCY_LIMIT) {
    throwIfAborted(signal);

    const batch = urls.slice(i, i + CONCURRENCY_LIMIT);

    const batchResults = await Promise.allSettled(
      batch.map(async (url) => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout
        const abortCurrentRequest = () => controller.abort();
        signal?.addEventListener('abort', abortCurrentRequest, { once: true });

        try {
          throwIfAborted(signal);

          // Follow redirects manually so every intermediate URL is
          // validated against the SSRF blocklist.
          const MAX_REDIRECTS = 5;
          let currentUrl = url;
          let res: Response | null = null;

          for (
            let redirectCount = 0;
            redirectCount <= MAX_REDIRECTS;
            redirectCount++
          ) {
            throwIfAborted(signal);

            res = await fetch(currentUrl, {
              signal: controller.signal,
              redirect: 'manual',
              headers: {
                'User-Agent':
                  'Mozilla/5.0 (compatible; Perplexica/1.0; +https://github.com/ItzCraworP/Perplexica)',
              },
            });

            // 3xx → validate the Location header before following
            if (res.status >= 300 && res.status < 400) {
              const location = res.headers.get('location');
              if (!location) return null;

              // Resolve relative redirects against the current URL
              const redirectUrl = new URL(location, currentUrl).href;
              if (!isSafeUrl(redirectUrl)) return null;

              currentUrl = redirectUrl;
              continue;
            }

            // Non-redirect response — break out of the loop
            break;
          }

          if (!res || !res.ok) {
            return null;
          }

          // Skip non-HTML/text responses (PDFs, images, etc.)
          const contentType = res.headers.get('content-type') || '';
          if (
            !contentType.includes('text/html') &&
            !contentType.includes('text/plain') &&
            !contentType.includes('application/xhtml')
          ) {
            return null;
          }

          // Reject excessively large responses before reading the body
          const contentLength = parseInt(
            res.headers.get('content-length') || '0',
            10,
          );
          if (contentLength > 10_000_000) {
            // 10 MB hard limit
            return null;
          }

          // Read body with a streaming size guard
          const MAX_BYTES = 10_000_000; // 10 MB
          const reader = res.body?.getReader();
          const htmlChunks: string[] = [];
          let html = '';
          if (reader) {
            const decoder = new TextDecoder();
            let totalBytes = 0;
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done || !value) break;
                totalBytes += value.length;
                if (totalBytes > MAX_BYTES) {
                  reader.cancel();
                  break;
                }
                htmlChunks.push(decoder.decode(value, { stream: true }));
              }
              // Flush any remaining bytes in the decoder
              htmlChunks.push(decoder.decode());
            } catch {
              // If streaming fails, use whatever we collected
            }
            html = htmlChunks.join('');
          } else {
            // Fallback for environments without streaming body
            html = await res.text();
          }
          const title =
            html.match(/<title>(.*?)<\/title>/i)?.[1] || `Content from ${url}`;
          const markdown = turndownService.turndown(html);

          if (markdown.trim().length < MIN_USEFUL_MARKDOWN_CHARS) {
            try {
              const scraped = await Scraper.scrape(currentUrl);
              const scrapedContent = truncateContent(scraped.content);

              if (scrapedContent.trim().length >= markdown.trim().length) {
                return {
                  url: currentUrl,
                  title: scraped.title || title,
                  content: scrapedContent,
                };
              }
            } catch {
              // Fall back to the lighter fetch-based markdown path.
            }
          }

          // Truncate excessively long pages
          const truncated = truncateContent(markdown);

          return { url: currentUrl, title, content: truncated };
        } catch {
          return null;
        } finally {
          clearTimeout(timeoutId);
          signal?.removeEventListener('abort', abortCurrentRequest);
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
  scrapedPages: { url: string; title: string; content: string }[],
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
    },
  }));

  return selectedChunks;
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

  if (searchFindings.length === 0) return [];
  throwIfAborted(signal);

  console.log(
    `[ContextFilter] Starting pipeline with ${searchFindings.length} search findings`,
  );

  // Stage 1: Rank results by relevance (also returns the query embedding)
  const { rankedResults, queryEmbedding } = await rankResultsByRelevance(
    query,
    searchFindings,
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

  return selectedChunks;
};
