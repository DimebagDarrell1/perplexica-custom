export type FirecrawlScrapeResult = {
  content: string;
  title: string;
  url: string;
  provider: 'firecrawl';
  cached: boolean;
};

type FirecrawlResponse = {
  success?: boolean;
  data?: {
    markdown?: string;
    metadata?: {
      title?: string;
      sourceURL?: string;
      url?: string;
    };
  };
};

type CacheEntry = {
  expiresAt: number;
  result: Omit<FirecrawlScrapeResult, 'cached'>;
};

const cache = new Map<string, CacheEntry>();
const MAX_CACHE_ENTRIES = 100;

const readPositiveInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

export const getFirecrawlConfig = () => {
  const apiUrl = (process.env.FIRECRAWL_API_URL || '').replace(/\/+$/, '');
  const enabled =
    process.env.FIRECRAWL_ENABLED?.toLowerCase() === 'true' && !!apiUrl;

  return {
    enabled,
    apiUrl,
    apiKey: process.env.FIRECRAWL_API_KEY || '',
    timeoutMs: readPositiveInteger(process.env.FIRECRAWL_TIMEOUT_MS, 20_000),
    maxAgeMs: readPositiveInteger(process.env.FIRECRAWL_MAX_AGE_MS, 3_600_000),
    localCacheTtlMs: readPositiveInteger(
      process.env.FIRECRAWL_CACHE_TTL_MS,
      900_000,
    ),
  };
};

const getScrapeEndpoint = (apiUrl: string) => `${apiUrl}/v2/scrape`;

const getCached = (url: string): FirecrawlScrapeResult | undefined => {
  const entry = cache.get(url);
  if (!entry) return undefined;

  if (entry.expiresAt <= Date.now()) {
    cache.delete(url);
    return undefined;
  }

  return { ...entry.result, cached: true };
};

const setCached = (
  url: string,
  result: Omit<FirecrawlScrapeResult, 'cached'>,
  ttlMs: number,
) => {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey) cache.delete(oldestKey);
  }

  cache.set(url, {
    expiresAt: Date.now() + ttlMs,
    result,
  });
};

export const scrapeWithFirecrawl = async (
  url: string,
  signal?: AbortSignal,
): Promise<FirecrawlScrapeResult> => {
  const config = getFirecrawlConfig();
  if (!config.enabled) {
    throw new Error('Firecrawl is not enabled');
  }

  const cached = getCached(url);
  if (cached) return cached;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);
  const abortRequest = () => controller.abort();
  signal?.addEventListener('abort', abortRequest, { once: true });

  try {
    const response = await fetch(getScrapeEndpoint(config.apiUrl), {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        url,
        formats: ['markdown'],
        onlyMainContent: true,
        maxAge: config.maxAgeMs,
        timeout: config.timeoutMs,
        parsers: ['pdf'],
        blockAds: true,
        removeBase64Images: true,
      }),
    });

    if (!response.ok) {
      throw new Error(`Firecrawl returned HTTP ${response.status}`);
    }

    const payload = (await response.json()) as FirecrawlResponse;
    const content = payload.data?.markdown?.trim() || '';
    if (!payload.success || !content) {
      throw new Error('Firecrawl returned no markdown content');
    }

    const result = {
      content,
      title: payload.data?.metadata?.title || `Content from ${url}`,
      url:
        payload.data?.metadata?.sourceURL || payload.data?.metadata?.url || url,
      provider: 'firecrawl' as const,
    };

    setCached(url, result, config.localCacheTtlMs);
    return { ...result, cached: false };
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', abortRequest);
  }
};

export const checkFirecrawlHealth = async (): Promise<{
  enabled: boolean;
  configured: boolean;
  reachable: boolean;
  status?: number;
  error?: string;
}> => {
  const config = getFirecrawlConfig();
  if (!config.apiUrl) {
    return { enabled: false, configured: false, reachable: false };
  }

  if (!config.enabled) {
    return { enabled: false, configured: true, reachable: false };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3_000);

  try {
    const response = await fetch(config.apiUrl, {
      signal: controller.signal,
      headers: config.apiKey
        ? { Authorization: `Bearer ${config.apiKey}` }
        : undefined,
    });

    return {
      enabled: true,
      configured: true,
      reachable: response.status < 500,
      status: response.status,
    };
  } catch (error) {
    return {
      enabled: true,
      configured: true,
      reachable: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  } finally {
    clearTimeout(timeoutId);
  }
};
