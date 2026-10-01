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
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_CONTENT_CHARS = 50_000;

async function readScrapeResponse(
  response: Response,
): Promise<FirecrawlResponse> {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error('Firecrawl response exceeded the extraction size limit');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Firecrawl returned an empty response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES)
        throw new Error(
          'Firecrawl response exceeded the extraction size limit',
        );
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

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
    timeoutMs: Math.min(
      readPositiveInteger(process.env.FIRECRAWL_TIMEOUT_MS, 20_000),
      60_000,
    ),
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
  signal?.throwIfAborted();
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
      redirect: 'error',
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
      await response.body?.cancel();
      throw new Error(`Firecrawl returned HTTP ${response.status}`);
    }

    const payload = await readScrapeResponse(response);
    signal?.throwIfAborted();
    const content =
      typeof payload?.data?.markdown === 'string'
        ? payload.data.markdown.trim().slice(0, MAX_CONTENT_CHARS)
        : '';
    if (!payload?.success || !content) {
      throw new Error('Firecrawl returned no markdown content');
    }

    const result = {
      content,
      title:
        typeof payload.data?.metadata?.title === 'string'
          ? payload.data.metadata.title.slice(0, 2000)
          : `Content from ${url}`,
      url:
        [payload.data?.metadata?.sourceURL, payload.data?.metadata?.url].find(
          (value) =>
            typeof value === 'string' &&
            value.length > 0 &&
            value.length <= 8192,
        ) || url,
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
    const response = await fetch(`${config.apiUrl}/v0/health/liveness`, {
      signal: controller.signal,
      redirect: 'error',
      headers: config.apiKey
        ? { Authorization: `Bearer ${config.apiKey}` }
        : undefined,
    });

    const payload = response.ok ? await response.json() : undefined;

    return {
      enabled: true,
      configured: true,
      reachable: response.ok && payload?.status === 'ok',
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
