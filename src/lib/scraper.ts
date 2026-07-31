import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { Mutex } from 'async-mutex';
import TurnDown from 'turndown';
import { getFirecrawlConfig, scrapeWithFirecrawl } from './firecrawl';
import { assertSafePublicUrl } from './web/urlSafety';

const turndownService = new TurnDown();
const MAX_RESPONSE_BYTES = 10_000_000;
const MAX_REDIRECTS = 5;
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
    await assertSafePublicUrl(url);
    await this.initBrowser();

    if (!this.browser) throw new Error('Browser not initialized');

    const context = await this.browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    await context.route('**/*', async (route: any) => {
      try {
        await assertSafePublicUrl(route.request().url());
        await route.continue();
      } catch {
        await route.abort('blockedbyclient');
      }
    });

    const page = await context.newPage();
    const abortNavigation = () => page.close().catch(() => undefined);
    signal?.addEventListener('abort', abortNavigation, { once: true });
    this.userCount++;

    try {
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: this.NAVIGATION_TIMEOUT,
      });

      await page
        .waitForLoadState('load', { timeout: 5_000 })
        .catch(() => undefined);
      await page.waitForTimeout(500);

      const finalUrl = page.url();
      await assertSafePublicUrl(finalUrl);

      const html = await page.content();
      const dom = new JSDOM(html, { url: finalUrl });
      const readable = new Readability(dom.window.document).parse();
      const title = (await page.title()) || `Content from ${finalUrl}`;
      const content = readable?.textContent?.trim() || '';

      if (!content) throw new Error('Browser extraction returned no content');

      return {
        title,
        url: finalUrl,
        content,
        provider: 'playwright',
      };
    } finally {
      signal?.removeEventListener('abort', abortNavigation);
      this.userCount--;
      await context.close().catch(() => undefined);

      if (this.userCount === 0) this.scheduleIdleKill();
    }
  }

  private static async scrapeWithFetch(
    url: string,
    signal?: AbortSignal,
  ): Promise<ScrapeResult> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15_000);
    const abortRequest = () => controller.abort();
    signal?.addEventListener('abort', abortRequest, { once: true });

    try {
      let currentUrl = (await assertSafePublicUrl(url)).href;

      for (
        let redirectCount = 0;
        redirectCount <= MAX_REDIRECTS;
        redirectCount++
      ) {
        const response = await fetch(currentUrl, {
          signal: controller.signal,
          redirect: 'manual',
          headers: {
            'User-Agent':
              'Mozilla/5.0 (compatible; Perplexica/1.0; +https://github.com/ItzCrazyKns/Perplexica)',
          },
        });

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (!location) throw new Error('Redirect response had no location');
          currentUrl = (
            await assertSafePublicUrl(new URL(location, currentUrl).href)
          ).href;
          continue;
        }

        if (!response.ok) {
          throw new Error(`Page returned HTTP ${response.status}`);
        }

        const contentType = response.headers.get('content-type') || '';
        if (
          !contentType.includes('text/html') &&
          !contentType.includes('text/plain') &&
          !contentType.includes('application/xhtml')
        ) {
          throw new Error(`Unsupported content type: ${contentType || 'none'}`);
        }

        const declaredSize = Number(
          response.headers.get('content-length') || 0,
        );
        if (declaredSize > MAX_RESPONSE_BYTES) {
          throw new Error('Page exceeded the extraction size limit');
        }

        const bytes = await response.arrayBuffer();
        if (bytes.byteLength > MAX_RESPONSE_BYTES) {
          throw new Error('Page exceeded the extraction size limit');
        }

        const html = new TextDecoder().decode(bytes);
        const title =
          html.match(/<title>([\s\S]*?)<\/title>/i)?.[1]?.trim() ||
          `Content from ${currentUrl}`;
        const content = turndownService.turndown(html).trim();
        if (!content) throw new Error('Fetch extraction returned no content');

        return {
          title,
          url: currentUrl,
          content,
          provider: 'fetch',
        };
      }

      throw new Error('Page exceeded the redirect limit');
    } finally {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', abortRequest);
    }
  }

  static async scrape(
    url: string,
    options: ScrapeOptions = {},
  ): Promise<ScrapeResult> {
    await assertSafePublicUrl(url);

    if (options.preferFirecrawl && getFirecrawlConfig().enabled) {
      try {
        return await scrapeWithFirecrawl(url, options.signal);
      } catch (error) {
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
      if (fetchResult) return fetchResult;
      throw error;
    }
  }
}

export default Scraper;
