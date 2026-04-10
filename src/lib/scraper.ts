import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { Mutex } from 'async-mutex';
import TurnDown from 'turndown';

const turndownService = new TurnDown();

class Scraper {
  private static browser: any | undefined;
  private static IDLE_KILL_TIMEOUT = 30000;
  private static NAVIGATION_TIMEOUT = 20000;
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
  ): Promise<{ content: string; title: string }> {
    await this.initBrowser();

    if (!this.browser) throw new Error('Browser not initialized');

    const context = await this.browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    const page = await context.newPage();

    this.userCount++;

    try {
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: this.NAVIGATION_TIMEOUT,
      });

      await page
        .waitForLoadState('load', { timeout: 5000 })
        .catch(() => undefined);
      await page.waitForTimeout(500);

      const html = await page.content();
      const dom = new JSDOM(html, { url });
      const readable = new Readability(dom.window.document).parse();
      const title = await page.title();

      return {
        title,
        content: `
# ${title ?? 'No title'} - ${url}
${readable?.textContent?.trim() ?? 'No content available'}
        `,
      };
    } finally {
      this.userCount--;

      await context.close().catch(() => undefined);

      if (this.userCount === 0) {
        this.scheduleIdleKill();
      }
    }
  }

  private static async scrapeWithFetch(
    url: string,
  ): Promise<{ content: string; title: string }> {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; Perplexica/1.0; +https://github.com/ItzCrazyKns/Perplexica)',
      },
    });

    const html = await res.text();
    const title =
      html.match(/<title>(.*?)<\/title>/i)?.[1] || `Content from ${url}`;
    const markdown = turndownService.turndown(html);

    return {
      title,
      content: `
# ${title} - ${url}
${markdown}
      `,
    };
  }

  static async scrape(
    url: string,
  ): Promise<{ content: string; title: string }> {
    try {
      return await this.scrapeWithBrowser(url);
    } catch (error) {
      console.log(`Falling back to fetch scraper for ${url}:`, error);

      try {
        return await this.scrapeWithFetch(url);
      } catch (fallbackError) {
        console.log(`Error scraping ${url}:`, fallbackError);

        return {
          title: 'Failed to scrape',
          content: `# ${url}\n\nError scraping content.`,
        };
      }
    }
  }
}

export default Scraper;
