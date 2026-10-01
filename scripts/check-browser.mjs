import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({
  headless: true,
  channel: 'chromium-headless-shell',
});
try {
  const page = await browser.newPage();
  await page.setContent(
    '<title>Browser ready</title><p>Local browser check</p>',
  );
  assert.equal(await page.title(), 'Browser ready');
  console.log(
    `Chromium ${browser.version()} launched using the locked Playwright package.`,
  );
} finally {
  await browser.close();
}
