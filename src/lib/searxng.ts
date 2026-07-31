import { getSearxngURL } from './config/serverRegistry';

interface SearxngSearchOptions {
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
}

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
      if (key === 'engines' || key === 'maxResults') return; // already handled locally
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
      signal: controller.signal,
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

    const results: SearxngSearchResult[] = (data.results ?? []).slice(
      0,
      opts?.maxResults ?? 10,
    );
    const suggestions: string[] = data.suggestions ?? [];

    return { results, suggestions };
  } catch (err: any) {
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
    const response = await fetch(url, { signal: controller.signal });

    return {
      configured: true,
      reachable: response.ok,
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
