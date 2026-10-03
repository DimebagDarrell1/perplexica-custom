import { getSearxngURL } from './config/serverRegistry';

interface SearxngSearchOptions {
  signal?: AbortSignal;
  categories?: string[];
  engines?: string[];
  language?: string;
  maxResults?: number;
  pageno?: number;
}

interface SearxngSearchResult {
  title: string;
  url: string;
  img_src?: string;
  thumbnail_src?: string;
  thumbnail?: string;
  content?: string;
  author?: string;
  iframe_src?: string;
  engine?: string;
  engines?: string[];
}

const normalizeSearchResult = (
  value: unknown,
): SearxngSearchResult | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const raw = value as Record<string, unknown>;
  if (typeof raw.title !== 'string' || typeof raw.url !== 'string') return;
  const result: SearxngSearchResult = { title: raw.title, url: raw.url };
  const textFields = [
    'content',
    'engine',
    'img_src',
    'thumbnail_src',
    'thumbnail',
    'author',
    'iframe_src',
  ] as const;
  for (const field of textFields) {
    if (typeof raw[field] === 'string') result[field] = raw[field];
  }
  if (Array.isArray(raw.engines)) {
    const engines = Array.from(
      new Set(
        raw.engines.filter(
          (engine): engine is string =>
            typeof engine === 'string' && engine.length > 0,
        ),
      ),
    );
    if (engines.length) result.engines = engines;
  }
  return result;
};

const QUERY_FILLER = new Set(
  'a an and are as at be been by can could did do does for from how i in is it its me of on or some that the their these they this to was were what when where which who why will with would you your about find search tell please unique interesting facts fact'.split(
    ' ',
  ),
);
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' });

const searchTerms = (text: string): Set<string> => {
  const normalized = text
    .replace(/<[^>]*>/g, ' ')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
  const tokens = normalized.match(/[\p{L}\p{N}][\p{L}\p{N}_+#.-]*/gu) ?? [];
  return new Set(
    tokens
      .flatMap((token) =>
        /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u.test(
          token,
        )
          ? Array.from(wordSegmenter.segment(token))
              .filter((part) => part.isWordLike)
              .map((part) => part.segment)
          : [
              token.replace(/[.-]+$/, ''),
              ...token.split('-').filter((part) => part !== token),
            ],
      )
      .filter((token) => token.length > 0 && !QUERY_FILLER.has(token)),
  );
};

// Check the larger merged response before applying the per-query budget. Keep
// SearXNG's ordering among matches and retain unmatched semantic results as a
// fallback; lexical overlap alone is not enough to reject a source.
export const selectSearchResults = (
  query: string,
  results: SearxngSearchResult[],
  maxResults: number,
): SearxngSearchResult[] => {
  const candidates = results.slice(0, Math.max(100, maxResults));
  const terms = searchTerms(query);
  if (terms.size === 0) return candidates.slice(0, maxResults);

  const matched: SearxngSearchResult[] = [];
  const unmatched: SearxngSearchResult[] = [];
  for (const result of candidates) {
    const evidence = searchTerms(`${result.title} ${result.content ?? ''}`);
    const overlaps = Array.from(terms).some((term) => evidence.has(term));
    (overlaps ? matched : unmatched).push(result);
  }
  return [...matched, ...unmatched].slice(0, maxResults);
};

const isMediaSearch = (opts?: SearxngSearchOptions): boolean =>
  Boolean(
    opts?.categories?.some((category) => /^(images|videos)$/i.test(category)) ||
    opts?.engines?.some((engine) =>
      /\b(images|videos|youtube|vimeo|dailymotion)\b/i.test(engine),
    ),
  );

const DEFAULT_ENGINES = [
  'brave',
  'bing',
  'startpage',
  'yandex',
  'crowdview',
  'mojeek',
  'wikipedia',
  'aol',
];

export const searchSearxng = async (
  query: string,
  opts?: SearxngSearchOptions,
) => {
  const searxngURL = getSearxngURL();

  const url = new URL('search?format=json', `${searxngURL}/`);
  url.searchParams.append('q', query);

  // Use caller-provided engines, or fall back to the hardcoded default list
  const engines = opts?.engines?.length ? opts.engines : DEFAULT_ENGINES;
  url.searchParams.append('engines', engines.join(','));

  if (opts) {
    Object.keys(opts).forEach((key) => {
      if (key === 'engines' || key === 'maxResults' || key === 'signal') return; // already handled locally
      const value = opts[key as keyof SearxngSearchOptions];
      if (Array.isArray(value)) {
        url.searchParams.append(key, value.join(','));
        return;
      }
      url.searchParams.append(key, value as string);
    });
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, {
      signal: opts?.signal
        ? AbortSignal.any([controller.signal, opts.signal])
        : controller.signal,
    });

    if (!res.ok) {
      throw new Error(
        `SearXNG returned status ${res.status} for query: ${query}`,
      );
    }

    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error(`SearXNG returned non-JSON response for query: ${query}`);
    }

    if (!data || typeof data !== 'object' || !Array.isArray(data.results)) {
      throw new Error(
        `SearXNG returned an invalid search response for query: ${query}`,
      );
    }
    const candidates: SearxngSearchResult[] = data.results
      .map(normalizeSearchResult)
      .filter(
        (
          result: SearxngSearchResult | undefined,
        ): result is SearxngSearchResult => result !== undefined,
      );
    const maxResults = opts?.maxResults ?? 10;
    const results = isMediaSearch(opts)
      ? candidates.slice(0, maxResults)
      : selectSearchResults(query, candidates, maxResults);
    const suggestions: string[] = Array.isArray(data.suggestions)
      ? data.suggestions.filter(
          (suggestion: unknown) => typeof suggestion === 'string',
        )
      : [];
    const unresponsiveEngines: string[] = Array.isArray(
      data.unresponsive_engines,
    )
      ? data.unresponsive_engines
          .filter(
            (entry: unknown) =>
              Array.isArray(entry) && typeof entry[0] === 'string',
          )
          .map((entry: string[]) => entry[0])
      : [];

    return { results, suggestions, unresponsiveEngines };
  } catch (err: any) {
    opts?.signal?.throwIfAborted();
    if (err.name === 'AbortError') {
      throw new Error('SearXNG search timed out');
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
};

export const checkSearxngHealth = async (): Promise<{
  configured: boolean;
  reachable: boolean;
  status?: number;
  error?: string;
}> => {
  const searxngURL = getSearxngURL();
  if (!searxngURL) return { configured: false, reachable: false };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3_000);

  try {
    const url = new URL(
      'search?format=json&q=perplexica-health',
      `${searxngURL}/`,
    );
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'error',
    });
    const payload = response.ok ? await response.json() : undefined;

    return {
      configured: true,
      reachable: response.ok && Array.isArray(payload?.results),
      status: response.status,
    };
  } catch (error) {
    return {
      configured: true,
      reachable: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  } finally {
    clearTimeout(timeoutId);
  }
};
