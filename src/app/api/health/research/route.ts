import { requireAdminToken } from '@/lib/config/security';
import { checkFirecrawlHealth, getFirecrawlConfig } from '@/lib/firecrawl';
import { checkSearxngHealth } from '@/lib/searxng';

export const dynamic = 'force-dynamic';

export const GET = async (request: Request) => {
  const unauthorized = requireAdminToken(request);
  if (unauthorized) return unauthorized;

  const [searxng, firecrawl] = await Promise.all([
    checkSearxngHealth(),
    checkFirecrawlHealth(),
  ]);
  const firecrawlConfig = getFirecrawlConfig();

  const status = !searxng.reachable
    ? 'unhealthy'
    : firecrawlConfig.enabled && !firecrawl.reachable
      ? 'degraded'
      : 'healthy';

  return Response.json(
    {
      status,
      timestamp: new Date().toISOString(),
      services: {
        searxng,
        firecrawl,
        nativeExtraction: {
          enabled: true,
          role: firecrawlConfig.enabled ? 'fallback' : 'primary',
        },
      },
      researchModes: {
        speed: 'native',
        balanced: firecrawlConfig.enabled
          ? 'firecrawl-with-native-fallback'
          : 'native',
        quality: firecrawlConfig.enabled
          ? 'firecrawl-with-native-fallback'
          : 'native',
      },
    },
    { status: status === 'unhealthy' ? 503 : 200 },
  );
};
