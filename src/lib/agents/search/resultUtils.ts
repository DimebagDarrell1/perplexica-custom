import type { Chunk } from '@/lib/types';
import type { SearchAgentConfig } from './types';

const MAX_SNIPPET_CHARS = 2_000;
const MAX_EVIDENCE_CHARS_PER_SOURCE = 12_000;

export const MODE_SEARCH_LIMITS: Record<
  SearchAgentConfig['mode'],
  {
    maxResultsPerQuery: number;
    maxCandidateResults: number;
    fallbackContextChunks: number;
  }
> = {
  speed: {
    maxResultsPerQuery: 6,
    maxCandidateResults: 18,
    fallbackContextChunks: 10,
  },
  balanced: {
    maxResultsPerQuery: 8,
    maxCandidateResults: 36,
    fallbackContextChunks: 18,
  },
  quality: {
    maxResultsPerQuery: 12,
    maxCandidateResults: 72,
    fallbackContextChunks: 30,
  },
};

const normalizeText = (value: unknown) =>
  String(value ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

export const normalizeUrl = (value: unknown) => {
  try {
    const url = new URL(String(value ?? ''));
    url.hash = '';

    for (const param of [
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
      'fbclid',
      'gclid',
    ]) {
      url.searchParams.delete(param);
    }

    if (url.pathname !== '/') {
      url.pathname = url.pathname.replace(/\/+$/, '');
    }

    return url.toString().toLowerCase();
  } catch {
    return normalizeText(value);
  }
};

const getResultKey = (chunk: Chunk) => {
  const url = normalizeUrl(chunk.metadata.url);
  if (url) return `url:${url}`;

  const title = normalizeText(chunk.metadata.title);
  return title ? `title:${title}` : `content:${normalizeText(chunk.content)}`;
};

const getSourceKey = (chunk: Chunk) => {
  const url = normalizeUrl(chunk.metadata.url);
  if (url) return `url:${url}`;

  const title = normalizeText(chunk.metadata.title);
  return title ? `title:${title}` : `source:${normalizeText(chunk.content)}`;
};

const getTitleKey = (chunk: Chunk) => normalizeText(chunk.metadata.title);

const isUsefulTitleKey = (titleKey: string) =>
  titleKey.length >= 12 &&
  !['home', 'homepage', 'untitled', 'index', 'search'].includes(titleKey);

export const trimChunkContent = (chunk: Chunk): Chunk => ({
  ...chunk,
  content:
    chunk.content.length > MAX_SNIPPET_CHARS
      ? `${chunk.content.slice(0, MAX_SNIPPET_CHARS)}...`
      : chunk.content,
});

const getSearchQueries = (chunk: Chunk): string[] => {
  const values = [
    ...(Array.isArray(chunk.metadata.searchQueries)
      ? chunk.metadata.searchQueries
      : []),
    chunk.metadata.searchQuery,
  ];

  return Array.from(
    new Set(values.map((value) => String(value || '').trim()).filter(Boolean)),
  );
};

/**
 * Collapse duplicate search listings before semantic ranking.
 * This intentionally operates on snippets, not deep-read evidence.
 */
export const dedupeSearchResults = (chunks: Chunk[]): Chunk[] => {
  const byKey = new Map<string, Chunk>();
  const titleToKey = new Map<string, string>();

  chunks.forEach((chunk) => {
    const trimmed = trimChunkContent(chunk);
    const key = getResultKey(trimmed);
    const titleKey = getTitleKey(trimmed);
    const existingKey = isUsefulTitleKey(titleKey)
      ? titleToKey.get(titleKey)
      : undefined;
    const effectiveKey = existingKey || key;
    const existing = byKey.get(effectiveKey);

    if (!existing) {
      byKey.set(effectiveKey, {
        ...trimmed,
        metadata: {
          ...trimmed.metadata,
          searchQueries: getSearchQueries(trimmed),
        },
      });
      if (isUsefulTitleKey(titleKey)) {
        titleToKey.set(titleKey, effectiveKey);
      }
      return;
    }

    if (trimmed.content.length > existing.content.length) {
      existing.content = trimmed.content;
    }

    if (!existing.metadata.url && trimmed.metadata.url) {
      existing.metadata.url = trimmed.metadata.url;
    }

    existing.metadata.searchQueries = Array.from(
      new Set([...getSearchQueries(existing), ...getSearchQueries(trimmed)]),
    );
  });

  return Array.from(byKey.values());
};

/**
 * Remove only exact duplicate evidence. Distinct excerpts from one URL or
 * uploaded file must survive until relevance selection is complete.
 */
export const dedupeEvidenceChunks = (chunks: Chunk[]): Chunk[] => {
  const seen = new Set<string>();

  return chunks.filter((chunk) => {
    const key = `${getSourceKey(chunk)}:${normalizeText(chunk.content)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const getDomain = (chunk: Chunk): string => {
  try {
    return new URL(String(chunk.metadata.url || '')).hostname.toLowerCase();
  } catch {
    return getSourceKey(chunk);
  }
};

/**
 * Round-robin candidates across originating queries while limiting any one
 * domain's ability to consume the pre-ranking embedding budget.
 */
export const buildDiverseCandidatePool = (
  chunks: Chunk[],
  limit: number,
  maxPerDomain = 3,
): Chunk[] => {
  const deduped = dedupeSearchResults(chunks).sort((a, b) => {
    const queryComparison = String(a.metadata.searchQuery || '').localeCompare(
      String(b.metadata.searchQuery || ''),
    );
    if (queryComparison !== 0) return queryComparison;
    return (
      Number(a.metadata.searchRank || 0) - Number(b.metadata.searchRank || 0)
    );
  });
  const buckets = new Map<string, Chunk[]>();

  deduped.forEach((chunk, index) => {
    const queries = getSearchQueries(chunk);
    const bucketKey = queries[0] || `unattributed:${index}`;
    const bucket = buckets.get(bucketKey) || [];
    bucket.push(chunk);
    buckets.set(bucketKey, bucket);
  });

  const queues = Array.from(buckets.values());
  const domainCounts = new Map<string, number>();
  const selected: Chunk[] = [];
  let madeProgress = true;

  while (selected.length < limit && madeProgress) {
    madeProgress = false;

    for (const queue of queues) {
      while (queue.length > 0) {
        const candidate = queue.shift()!;
        const domain = getDomain(candidate);
        const count = domainCounts.get(domain) || 0;
        if (count >= maxPerDomain) continue;

        selected.push(candidate);
        domainCounts.set(domain, count + 1);
        madeProgress = true;
        break;
      }

      if (selected.length >= limit) break;
    }
  }

  return selected;
};

/**
 * Create one citation document per source while retaining several selected
 * excerpts. Citation numbering therefore stays aligned with the source UI.
 */
export const groupEvidenceBySource = (
  chunks: Chunk[],
  maxCharsPerSource = MAX_EVIDENCE_CHARS_PER_SOURCE,
): Chunk[] => {
  const grouped = new Map<
    string,
    { chunk: Chunk; contents: string[]; chars: number }
  >();

  dedupeEvidenceChunks(chunks).forEach((chunk) => {
    const key = getSourceKey(chunk);
    const existing = grouped.get(key);
    const content = chunk.content.trim();

    if (!existing) {
      grouped.set(key, {
        chunk: {
          ...chunk,
          content: content.slice(0, maxCharsPerSource),
          metadata: { ...chunk.metadata, evidenceChunkCount: 1 },
        },
        contents: [content],
        chars: Math.min(content.length, maxCharsPerSource),
      });
      return;
    }

    const separator = '\n\n---\n\n';
    const remaining = maxCharsPerSource - existing.chars - separator.length;
    if (remaining <= 0) return;

    const nextContent = content.slice(0, remaining);
    existing.contents.push(nextContent);
    existing.chars += separator.length + nextContent.length;
    existing.chunk.content = existing.contents.join(separator);
    existing.chunk.metadata.evidenceChunkCount = existing.contents.length;
  });

  return Array.from(grouped.values()).map(({ chunk }) => chunk);
};

/** Backwards-compatible alias for discovery callers outside the research path. */
export const dedupeChunks = dedupeSearchResults;

export const limitChunksForMode = (
  chunks: Chunk[],
  mode: SearchAgentConfig['mode'],
  limit = MODE_SEARCH_LIMITS[mode].maxCandidateResults,
) => {
  const uploadChunks = dedupeEvidenceChunks(
    chunks.filter((chunk) =>
      String(chunk.metadata.url || '').startsWith('file_id://'),
    ),
  );
  const uploadLimit = Math.min(
    uploadChunks.length,
    Math.max(5, Math.floor(limit / 3)),
  );
  const webChunks = chunks.filter(
    (chunk) => !String(chunk.metadata.url || '').startsWith('file_id://'),
  );

  return [
    ...uploadChunks.slice(0, uploadLimit),
    ...buildDiverseCandidatePool(webChunks, limit - uploadLimit),
  ];
};
