import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from '../helpers/loadTs.mjs';

const { extractReadableHtml } = loadTs('src/lib/web/readableContent.ts');
const url = 'https://fixture.example/films/coraline';
const sourceProse = `
  <p>Coraline had nine different outfits created for the production. More than 500 crew members worked together on the film.</p>
  <p>${'This authored fixture describes puppet costumes, handmade sets, and the careful work of the animation team. '.repeat(8)}</p>
`;
const noisyPage = (body = sourceProse) => `
  <!doctype html><html><head>
    <title>Coraline &amp; production</title>
    <script>window.application = "ScriptNoiseMarker ${'Coraline tracking '.repeat(100)}";</script>
    <script type="application/ld+json">{"description":"JsonNoiseMarker ${'Coraline metadata '.repeat(100)}"}</script>
    <style>.navigation { content: "StyleNoiseMarker ${'layout '.repeat(100)}"; }</style>
  </head><body>
    <nav>${'NavigationNoiseMarker '.repeat(60)}</nav>
    <template><article>TemplateNoiseMarker ${'Coraline bootstrap '.repeat(100)}</article></template>
    <main><article><h1>Coraline production</h1>${body}</article></main>
  </body></html>
`;
const codeOnlyPage = `
  <html><head><title>Application shell</title></head><body>
    <script>window.application = "ScriptOnlyMarker ${'Coraline data '.repeat(100)}";</script>
    <style>.content { content: "StyleOnlyMarker ${'CSS '.repeat(100)}"; }</style>
    <template><p>TemplateOnlyMarker</p></template>
  </body></html>
`;

function scraperFixture(html, { contentType = 'text/html', fetchPage } = {}) {
  let requests = 0;
  const { default: Scraper } = loadTs('src/lib/scraper.ts', {
    './firecrawl': { getFirecrawlConfig: () => ({ enabled: false }) },
    './web/urlSafety': { assertSafePublicUrl: async (value) => new URL(value) },
    './web/safeFetch': {
      safeFetch: async (value, signal) => {
        requests++;
        return fetchPage
          ? fetchPage(value, signal)
          : {
              response: new Response(html, {
                headers: { 'content-type': contentType },
              }),
              url,
            };
      },
    },
    './web/browserNetwork': {
      secureBrowserContext: async () => ({ finalUrl: url }),
    },
  });
  return { Scraper, requests: () => requests };
}

function browserFixture(Scraper, html, { onContent } = {}) {
  let opened = 0;
  let closed = 0;
  Scraper.initBrowser = async () => {};
  Scraper.scheduleIdleKill = () => {};
  Scraper.browser = {
    newContext: async () => {
      opened++;
      return {
        addInitScript: async () => {},
        close: async () => {
          closed++;
        },
        newPage: async () => ({
          goto: async () => {},
          waitForLoadState: async () => {},
          waitForTimeout: async () => {},
          content: async () => {
            onContent?.();
            return html;
          },
          url: () => url,
        }),
      };
    },
  };
  return { opened: () => opened, closed: () => closed };
}

test('native HTML extraction removes scripts, JSON-LD, styles and templates while preserving article facts', async () => {
  const fixture = scraperFixture(noisyPage());
  const result = await fixture.Scraper.scrape(
    'https://fixture.example/original',
  );
  assert.equal(result.provider, 'fetch');
  assert.equal(result.url, url);
  assert.equal(result.title, 'Coraline & production');
  assert.match(result.content, /nine different outfits/);
  assert.match(result.content, /500 crew members/);
  assert.doesNotMatch(
    result.content,
    /ScriptNoiseMarker|JsonNoiseMarker|StyleNoiseMarker|TemplateNoiseMarker|NavigationNoiseMarker/,
  );
  assert.equal(fixture.requests(), 1);
});

test('native HTML extraction retains legitimate preformatted code and escaped script examples', () => {
  const result = extractReadableHtml(
    noisyPage(`${sourceProse}
    <h2>Example code</h2>
    <pre><code>const total = 2 + 2;\nconsole.log(total);</code></pre>
    <pre><code>&lt;script&gt;alert("Example only");&lt;/script&gt;</code></pre>
  `),
    url,
  );
  assert.match(result.content, /const total = 2 \+ 2;/);
  assert.match(result.content, /console\.log\(total\)/);
  assert.match(result.content, /<script>alert\("Example only"\);<\/script>/);
  assert.doesNotMatch(result.content, /ScriptNoiseMarker|StyleNoiseMarker/);
});

test('clean content length, rather than page code, determines whether browser fallback is needed', async () => {
  const fixture = scraperFixture(
    noisyPage(
      '<p>ShortArticleMarker: Coraline had nine different outfits and more than 500 crew members.</p>',
    ),
  );
  let browserCalls = 0;
  fixture.Scraper.scrapeWithBrowser = async () => {
    browserCalls++;
    throw new Error('Browser unavailable');
  };
  const result = await fixture.Scraper.scrape(url);
  assert.equal(browserCalls, 1);
  assert.equal(result.provider, 'fetch');
  assert.ok(result.content.length < 500);
  assert.match(result.content, /ShortArticleMarker/);
  assert.doesNotMatch(result.content, /NoiseMarker/);
});

test('a script-only page falls back to cleaned browser content instead of successful fetch evidence', async () => {
  const fixture = scraperFixture(codeOnlyPage);
  const browser = browserFixture(fixture.Scraper, noisyPage());
  const result = await fixture.Scraper.scrape(url);
  assert.equal(browser.opened(), 1);
  assert.equal(browser.closed(), 1);
  assert.equal(fixture.Scraper.userCount, 0);
  assert.equal(result.provider, 'playwright');
  assert.match(result.content, /nine different outfits/);
  assert.doesNotMatch(result.content, /NoiseMarker|OnlyMarker/);
});

test('script-only pages fail if browser extraction also lacks readable content', async () => {
  const fixture = scraperFixture(codeOnlyPage);
  const browser = browserFixture(fixture.Scraper, codeOnlyPage);
  await assert.rejects(fixture.Scraper.scrape(url), /no readable content/);
  assert.equal(browser.closed(), 1);
  assert.equal(fixture.Scraper.userCount, 0);
});

test('plain-text responses preserve literal code rather than interpreting it as HTML', async () => {
  const text = `PlainTextMarker\n<script>this is a literal example</script>\n${'Readable fixture text. '.repeat(30)}`;
  const fixture = scraperFixture(text, {
    contentType: 'text/plain; charset=utf-8',
  });
  const result = await fixture.Scraper.scrape(url);
  assert.equal(result.provider, 'fetch');
  assert.equal(result.content, text.trim());
});

test('a body-only document keeps readable text when no article or main element exists', () => {
  const result = extractReadableHtml(
    '<html><head><title>Short page</title></head><body><p>ReadableBodyMarker: Useful explanatory prose remains available.</p></body></html>',
    url,
  );
  assert.match(result.content, /ReadableBodyMarker/);
});

test('title-only output is rejected after case, punctuation and whitespace normalization', () => {
  for (const [title, body] of [
    ['Coraline Facts', '<h1>  CORALINE   facts! </h1>'],
    ['Making Coraline Stop Motion', '<p>Making Coraline Stop Motion</p>'],
  ]) {
    assert.throws(
      () =>
        extractReadableHtml(
          `<html><head><title>${title}</title></head><body>${body}</body></html>`,
          url,
        ),
      /title-only/,
    );
  }
});

test('title-only fetch output triggers browser fallback rather than becoming evidence', async () => {
  const fixture = scraperFixture(
    '<html><head><title>Coraline Facts</title></head><body><h1>Coraline Facts</h1></body></html>',
  );
  const browser = browserFixture(fixture.Scraper, noisyPage());
  const result = await fixture.Scraper.scrape(url);
  assert.equal(browser.opened(), 1);
  assert.equal(browser.closed(), 1);
  assert.equal(result.provider, 'playwright');
  assert.match(result.content, /nine different outfits/);
});

test('title-only pages fail when the browser also has no useful content', async () => {
  const html =
    '<html><head><title>Coraline Facts</title></head><body><h1>Coraline Facts</h1></body></html>';
  const fixture = scraperFixture(html);
  const browser = browserFixture(fixture.Scraper, html);
  await assert.rejects(fixture.Scraper.scrape(url), /title-only/);
  assert.equal(browser.closed(), 1);
  assert.equal(fixture.Scraper.userCount, 0);
});

test('short factual prose remains readable even when it is shorter than the browser threshold', () => {
  const result = extractReadableHtml(
    '<html><head><title>Coraline Facts</title></head><body><p>Coraline had nine outfits and more than 500 crew members.</p></body></html>',
    url,
  );
  assert.match(result.content, /nine outfits/);
  assert.match(result.content, /500 crew members/);
  assert.ok(result.content.length < 500);
});

test('noscript text cannot make an application shell count as readable evidence', () => {
  assert.throws(
    () =>
      extractReadableHtml(
        `<html><head><title>Application shell</title></head><body><noscript>${'Enable JavaScript and cookies to continue. '.repeat(50)}</noscript></body></html>`,
        url,
      ),
    /no readable content/,
  );
});

test('noscript payloads are removed without losing the readable article', () => {
  const result = extractReadableHtml(
    noisyPage(
      `<noscript>${'NoscriptNoiseMarker '.repeat(100)}</noscript>${sourceProse}`,
    ),
    url,
  );
  assert.match(result.content, /nine different outfits/);
  assert.doesNotMatch(result.content, /NoscriptNoiseMarker/);
});

for (const title of ['Just a moment...', 'Verify human', 'Access Denied']) {
  test(`a ${title} shell cannot bypass browser fallback by repeating access instructions`, async () => {
    const instruction =
      title === 'Access Denied'
        ? 'You do not have permission to access this page. Your request has been blocked. '
        : 'Enable JavaScript and cookies to continue. ';
    const fixture = scraperFixture(
      `<html><head><title>${title}</title></head><body><h1>${title}</h1><p>${instruction.repeat(40)}</p></body></html>`,
    );
    const browser = browserFixture(fixture.Scraper, noisyPage());
    const result = await fixture.Scraper.scrape(url);
    assert.equal(browser.opened(), 1);
    assert.equal(browser.closed(), 1);
    assert.equal(result.provider, 'playwright');
    assert.match(result.content, /nine different outfits/);
    assert.doesNotMatch(
      result.content,
      /Enable JavaScript|request has been blocked/,
    );
  });
}

test('challenge shells fail when browser rendering cannot recover readable content', async () => {
  const html = `<html><head><title>Just a moment...</title></head><body><h1>Just a moment...</h1><p>${'Enable JavaScript and cookies to continue. '.repeat(40)}</p></body></html>`;
  const fixture = scraperFixture(html);
  const browser = browserFixture(fixture.Scraper, html);
  await assert.rejects(fixture.Scraper.scrape(url), /access challenge shell/);
  assert.equal(browser.closed(), 1);
  assert.equal(fixture.Scraper.userCount, 0);
});

test('documentation discussing browser challenges stays readable, including when its title is Access Denied', () => {
  for (const title of ['Handling JavaScript and cookies', 'Access Denied']) {
    const result = extractReadableHtml(
      `<html><head><title>${title}</title></head><body><article><h1>${title}</h1>
        <p>DocumentationMarker: A page may say "Just a moment" or "Verify human" when a protection service checks the request.</p>
        <p>The message "Enable JavaScript and cookies to continue" asks the browser to enable both features. Check whether a privacy extension blocks the site's scripts, then reload the page.</p>
        <pre><code>const message = "Access Denied";</code></pre>
      </article></body></html>`,
      url,
    );
    assert.match(result.content, /DocumentationMarker/);
    assert.match(result.content, /Enable JavaScript and cookies/);
    assert.match(result.content, /const message = "Access Denied";/);
  }
});

test('an already-cancelled extraction never starts a request', async () => {
  const fixture = scraperFixture(noisyPage());
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    fixture.Scraper.scrape(url, { signal: controller.signal }),
    { name: 'AbortError' },
  );
  assert.equal(fixture.requests(), 0);
});

test('cancellation after native fetch does not trigger a browser fallback', async () => {
  const controller = new AbortController();
  const fixture = scraperFixture('', {
    fetchPage: async (value, signal) => {
      assert.equal(signal, controller.signal);
      controller.abort();
      return {
        response: new Response(noisyPage(), {
          headers: { 'content-type': 'text/html' },
        }),
        url: value,
      };
    },
  });
  let browserCalls = 0;
  fixture.Scraper.scrapeWithBrowser = async () => {
    browserCalls++;
  };
  await assert.rejects(
    fixture.Scraper.scrape(url, { signal: controller.signal }),
    { name: 'AbortError' },
  );
  assert.equal(browserCalls, 0);
});

test('browser cancellation cannot return an earlier short fetch result', async () => {
  const controller = new AbortController();
  const fixture = scraperFixture(
    noisyPage('<p>ShortArticleMarker: A short but readable article.</p>'),
  );
  const browser = browserFixture(fixture.Scraper, noisyPage(), {
    onContent: () => controller.abort(),
  });
  await assert.rejects(
    fixture.Scraper.scrape(url, { signal: controller.signal }),
    { name: 'AbortError' },
  );
  assert.ok(browser.closed() >= 1);
  assert.equal(fixture.Scraper.userCount, 0);
});

test('clean native extraction reaches indexed writer context with primary facts and no page code', async () => {
  const fixture = scraperFixture(noisyPage());
  const { buildFilteredContext } = loadTs(
    'src/lib/agents/search/contextFilter.ts',
    {
      '@/lib/config': {
        __esModule: true,
        default: { getConfig: (_key, fallback) => fallback },
      },
      '@/lib/scraper': { __esModule: true, default: fixture.Scraper },
    },
  );
  const { prepareWriterContext, formatWriterContext } = loadTs(
    'src/lib/agents/search/writerContext.ts',
    {
      './contextFilter': { buildFilteredContext },
      '@/lib/uploads/store': {},
    },
  );
  const evidence = await prepareWriterContext(
    [
      {
        content: 'Coraline production facts',
        metadata: { title: 'Coraline production', url },
      },
    ],
    'Coraline production facts',
    undefined,
    {
      embedText: async (texts) => texts.map(() => [1, 0]),
    },
    'speed',
    undefined,
    false,
    false,
  );
  const context = formatWriterContext(evidence, []);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].metadata.extractionProvider, 'fetch');
  assert.equal(evidence[0].metadata.url, url);
  assert.match(context, /<result index="1" source_type="web"/);
  assert.match(context, /nine different outfits/);
  assert.match(context, /500 crew members/);
  assert.doesNotMatch(
    context,
    /ScriptNoiseMarker|JsonNoiseMarker|StyleNoiseMarker|TemplateNoiseMarker|NavigationNoiseMarker/,
  );
});

test('a Readability miss falls back to cleaned main prose rather than scripts or navigation', () => {
  const { extractReadableHtml: extract } = loadTs(
    'src/lib/web/readableContent.ts',
    {
      '@mozilla/readability': {
        Readability: class {
          parse() {
            return null;
          }
        },
      },
    },
  );
  const result = extract(
    noisyPage(
      '<p>MainProseMarker: Readable facts remain available when article detection fails.</p><pre><code>const total = 4;</code></pre><noscript>NoscriptNoiseMarker: Enable JavaScript and cookies to continue.</noscript>',
    ),
    url,
  );
  assert.match(result.content, /MainProseMarker/);
  assert.match(result.content, /const total = 4;/);
  assert.doesNotMatch(result.content, /NoiseMarker/);
});
