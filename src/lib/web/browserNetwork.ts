import type { BrowserContext } from 'playwright';
import { Semaphore } from 'async-mutex';
import { safeFetch } from './safeFetch';

/** Browser subrequests use the same DNS-bound transport as native scraping. */
export const secureBrowserContext = async (
  context: BrowserContext,
  signal: AbortSignal,
) => {
  const navigation = { finalUrl: '' };
  const slots = new Semaphore(5);
  let requests = 0;
  let bytes = 0;
  await context.routeWebSocket('**/*', (socket) => socket.close());
  await context.route('**/*', async (route) => {
    const request = route.request();
    if (
      ++requests > 100 ||
      signal.aborted ||
      request.method() !== 'GET' ||
      ['image', 'media', 'font'].includes(request.resourceType())
    ) {
      await route.abort('blockedbyclient').catch(() => undefined);
      return;
    }
    try {
      await slots.runExclusive(async () => {
        signal.throwIfAborted();
        if (bytes >= 30_000_000)
          throw new Error('Browser extraction exceeded its transfer limit');
        const { response, url } = await safeFetch(request.url(), signal);
        let body = Buffer.from(await response.arrayBuffer());
        bytes += body.length;
        if (bytes > 30_000_000)
          throw new Error('Browser extraction exceeded its transfer limit');
        if (request.isNavigationRequest() && !request.frame().parentFrame()) {
          navigation.finalUrl = url;
        }
        // A fulfilled redirect must retain the destination's relative URL base.
        if (
          url !== request.url() &&
          response.headers.get('content-type')?.includes('text/html')
        ) {
          const base = url
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;');
          body = Buffer.from(
            body
              .toString()
              .replace(
                /<head\b[^>]*>/i,
                (head) => `${head}<base href="${base}">`,
              ),
          );
        }
        await route.fulfill({
          status: response.status,
          headers: Object.fromEntries(response.headers),
          body,
        });
      });
    } catch {
      await route.abort('blockedbyclient').catch(() => undefined);
    }
  });
  return navigation;
};
