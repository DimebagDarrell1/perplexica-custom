import { Mutex } from 'async-mutex';
import {
  getFirecrawlConfig,
  scrapeWithFirecrawl,
  type FirecrawlConfig,
} from './firecrawl';
import { assertSafePublicUrl } from './web/urlSafety';
import { safeFetch } from './web/safeFetch';
import { secureBrowserContext } from './web/browserNetwork';
import { extractReadableHtml } from './web/readableContent';

const MIN_USEFUL_CONTENT_CHARS = 500;

export type ScrapeProvider = 'firecrawl' | 'fetch' | 'playwright';

export type ScrapeResult = {
  content: string;
  title: string;
  url: string;
  provider: ScrapeProvider;
  cached?: boolean;
};

export type ScrapeOptions = {
  preferFirecrawl?: boolean;
  signal?: AbortSignal;
  /** Resolved Settings → Search values; defaults to environment variables. */
  firecrawl?: FirecrawlConfig;
};

class Scraper {
  private static browser: any | undefined;
  private static IDLE_KILL_TIMEOUT = 30_000;
  private static NAVIGATION_TIMEOUT = 20_000;
  private static idleTimeout: NodeJS.Timeout | undefined;
  private static browserMutex = new Mutex();
  private static userCount = 0;

  private static async initBrowser() {
    await this.browserMutex.runExclusive(async () => {
      if (!this.browser) {
        const { chromium } = await import('playwright');
        this.browser = await chromium.launch({
          headless: true,
          channel: 'chromium-headless-shell',
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-blink-features=AutomationControlled',
          ],
        });
      }

      if (this.idleTimeout) clearTimeout(this.idleTimeout);
    });
  }

  private static scheduleIdleKill() {
    if (this.idleTimeout) clearTimeout(this.idleTimeout);

    this.idleTimeout = setTimeout(async () => {
      await this.browserMutex.runExclusive(async () => {
        if (this.browser && this.userCount === 0) {
          await this.browser.close();
          this.browser = undefined;
        }
      });
    }, this.IDLE_KILL_TIMEOUT);
  }

  private static async scrapeWithBrowser(
    url: string,
    signal?: AbortSignal,
  ): Promise<ScrapeResult> {
    signal?.throwIfAborted();
    await assertSafePublicUrl(url);
    await this.initBrowser();
    signal?.throwIfAborted();

    if (!this.browser) throw new Error('Browser not initialized');

    const context = await this.browser.newContext({
      serviceWorkers: 'block',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    });

    const browserSignal = AbortSignal.any([
      ...(signal ? [signal] : []),
      AbortSignal.timeout(30_000),
    ]);
    const abortNavigation = () => context.close().catch(() => undefined);
    browserSignal.addEventListener('abort', abortNavigation, { once: true });
    this.userCount++;

    try {
      browserSignal.throwIfAborted();
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });
      const navigation = await secureBrowserContext(context, browserSignal);
      const page = await context.newPage();
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: this.NAVIGATION_TIMEOUT,
      });

      await page
        .waitForLoadState('load', { timeout: 5_000 })
        .catch(() => undefined);
      await page.waitForTimeout(500);

      const finalUrl = navigation.finalUrl || page.url();
      await assertSafePublicUrl(finalUrl);

      const html = await page.content();
      browserSignal.throwIfAborted();
      const { title, content } = extractReadableHtml(html, finalUrl);
      browserSignal.throwIfAborted();

      return {
        title,
        url: finalUrl,
        content,
        provider: 'playwright',
      };
    } finally {
      browserSignal.removeEventListener('abort', abortNavigation);
      this.userCount--;
      await context.close().catch(() => undefined);

      if (this.userCount === 0) this.scheduleIdleKill();
    }
  }

  private static async scrapeWithFetch(
    url: string,
    signal?: AbortSignal,
  ): Promise<ScrapeResult> {
    const { response, url: finalUrl } = await safeFetch(url, signal);
    if (!response.ok) throw new Error(`Page returned HTTP ${response.status}`);
    const contentType = response.headers.get('content-type') || '';
    if (
      !['text/html', 'text/plain', 'application/xhtml'].some((type) =>
        contentType.includes(type),
      )
    ) {
      throw new Error(`Unsupported content type: ${contentType || 'none'}`);
    }
    const body = await response.text();
    signal?.throwIfAborted();
    const { title, content } = contentType.includes('text/plain')
      ? { title: `Content from ${finalUrl}`, content: body.trim() }
      : extractReadableHtml(body, finalUrl);
    signal?.throwIfAborted();
    if (!content) throw new Error('Fetch extraction returned no content');
    return { title, url: finalUrl, content, provider: 'fetch' };
  }

  static async scrape(
    url: string,
    options: ScrapeOptions = {},
  ): Promise<ScrapeResult> {
    options.signal?.throwIfAborted();
    await assertSafePublicUrl(url);

    const firecrawl = options.firecrawl ?? getFirecrawlConfig();
    if (options.preferFirecrawl && firecrawl.enabled) {
      try {
        return await scrapeWithFirecrawl(url, options.signal, firecrawl);
      } catch (error) {
        options.signal?.throwIfAborted();
        console.warn(
          JSON.stringify({
            event: 'research_extraction_fallback',
            from: 'firecrawl',
            url,
            error: error instanceof Error ? error.message : 'Unknown error',
          }),
        );
      }
    }

    let fetchResult: ScrapeResult | undefined;
    try {
      fetchResult = await this.scrapeWithFetch(url, options.signal);
      if (fetchResult.content.length >= MIN_USEFUL_CONTENT_CHARS) {
        return fetchResult;
      }
    } catch (error) {
      if (options.signal?.aborted) throw error;
    }

    try {
      const browserResult = await this.scrapeWithBrowser(url, options.signal);
      if (
        !fetchResult ||
        browserResult.content.length >= fetchResult.content.length
      ) {
        return browserResult;
      }
      return fetchResult;
    } catch (error) {
      options.signal?.throwIfAborted();
      if (fetchResult) return fetchResult;
      throw error;
    }
  }
}

export default Scraper;
