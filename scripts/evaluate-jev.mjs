import fs from 'node:fs';
import { loadTs } from '../test/helpers/loadTs.mjs';

// Synthetic examples only. Default execution builds payloads without calling a provider.
const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--live') || args.length > 1) {
  throw new Error('Usage: node scripts/evaluate-jev.mjs [--live]');
}
const live = args.includes('--live');
const { getJevConfig, buildJevRequest, rerankWithJev } =
  loadTs('src/lib/jev.ts');
const config = getJevConfig();
if (live && (!config.enabled || !config.configured)) {
  throw new Error(
    'Live evaluation requires JEV_ENABLED=true, a supported JEV_PROVIDER, and JEV_API_KEY. No requests were sent.',
  );
}
const cases = JSON.parse(
  fs.readFileSync(
    new URL('../test/fixtures/jev/relevance.json', import.meta.url),
    'utf8',
  ),
);
const output = [];
for (const example of cases) {
  const candidates = example.candidates.map((candidate, index) => ({
    chunk: {
      content: candidate.snippet,
      metadata: {
        title: candidate.title,
        sourceType: 'web',
        url: `https://example.com/${candidate.id}`,
      },
    },
    score: 1 / (index + 1),
  }));
  const payload = buildJevRequest(example.query, candidates, config.model);
  const originalRank =
    example.candidates.findIndex(
      (candidate) => candidate.id === example.expectedFirst,
    ) + 1;
  if (!live) {
    output.push({
      id: example.id,
      candidates: candidates.length,
      payloadBytes: Buffer.byteLength(JSON.stringify(payload)),
      originalRank,
      status: 'offline-payload-check',
    });
    continue;
  }
  const result = await rerankWithJev(example.query, candidates);
  output.push({
    id: example.id,
    status: result.status,
    reason: result.reason,
    originalRank,
    rerankedPosition:
      result.status === 'applied'
        ? result.results.findIndex(
            (item) =>
              item.chunk.metadata.url ===
              `https://example.com/${example.expectedFirst}`,
          ) + 1
        : null,
    durationMs: result.durationMs,
    model: result.model,
    usage: result.usage,
  });
  // Stop on the first provider failure instead of making more billable attempts.
  if (result.status !== 'applied') break;
}
console.log(
  JSON.stringify(
    {
      mode: live ? 'live-synthetic-evaluation' : 'offline',
      note: 'These authored examples are a smoke test, not a representative search-quality benchmark. Original order is fixture order, not a measured embedding ranking.',
      maxProviderRequests: live ? cases.length : 0,
      cases: output,
    },
    null,
    2,
  ),
);
if (live && output.some((result) => result.status !== 'applied'))
  process.exitCode = 1;
