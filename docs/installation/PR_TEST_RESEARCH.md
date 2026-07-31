# PR-Test Research Pipeline

The PR-test image is built from the `codex/vane-integration-pass` branch by
`docker-compose.pr-test.yaml`. This build can use a self-hosted Firecrawl
instance for page extraction while keeping SearXNG as the search/discovery
engine.

## Configure Firecrawl

Set these variables in the shell or Compose `.env` file used to launch the
PR-test stack:

```dotenv
FIRECRAWL_ENABLED=true
FIRECRAWL_API_URL=http://host.docker.internal:<firecrawl-port>
FIRECRAWL_API_KEY=
FIRECRAWL_TIMEOUT_MS=20000
FIRECRAWL_MAX_AGE_MS=3600000
FIRECRAWL_CACHE_TTL_MS=900000
```

`FIRECRAWL_API_URL` is the API base URL, not the `/v2/scrape` endpoint. The
Compose file maps `host.docker.internal` to the Linux Docker host. If Firecrawl
is on another machine or a shared Docker network, use the URL reachable from
inside the Perplexica container instead.

`FIRECRAWL_API_KEY` is optional for a self-hosted instance that does not require
authentication. Firecrawl remains off unless both `FIRECRAWL_ENABLED=true` and
`FIRECRAWL_API_URL` are set.

## Deploy The Test Build

After the branch has been pushed:

```bash
docker compose -f docker-compose.pr-test.yaml build --no-cache
docker compose -f docker-compose.pr-test.yaml up -d
```

The test instance remains on port `3002` and keeps its own data volume at
`/mnt/user/appdata/perplexica-pr-test/data`.

## Extraction Behavior

- **Speed** uses Perplexica's native HTTP/Playwright extraction only.
- **Balanced** tries Firecrawl first and falls back to native extraction per URL.
- **Quality** uses the same fallback policy with larger URL and evidence budgets.
- Firecrawl requests ask for main-content Markdown, PDF parsing, ad blocking,
  base64 image removal, and a configurable Firecrawl cache age.
- Successful Firecrawl responses are cached in the Perplexica process for 15
  minutes by default. The cache is bounded to 100 URLs.
- A Firecrawl timeout or error does not fail the research request. It creates a
  structured fallback log and continues with native extraction.

This improves results primarily on JavaScript-heavy pages, cluttered articles,
PDFs, and sites where the lightweight fetch extractor returns little useful
content. It does not replace SearXNG and does not let the research LLM decide
when to call Firecrawl.

## Verify The Services

```bash
curl -s http://localhost:3002/api/health/research | jq
```

The endpoint reports:

- `healthy`: SearXNG is reachable and every enabled extractor is reachable.
- `degraded`: SearXNG works but enabled Firecrawl is unavailable; native
  extraction is still active.
- `unhealthy`: SearXNG is unavailable, so search discovery cannot proceed.

Pipeline metrics are written as one JSON log entry per completed context build:

```bash
docker logs perplexica-pr-test 2>&1 | grep research_context_pipeline
```

The entry includes discovery counts, candidate and ranked URL counts, successful
scrapes by extraction provider, selected evidence chunks, citation sources, and
total pipeline duration. Firecrawl failures are logged with the
`research_extraction_fallback` event.

## Optional Admin Token

Set `PERPLEXICA_ADMIN_TOKEN` only when the reverse proxy can inject this header
for trusted admin requests:

```http
Authorization: Bearer <PERPLEXICA_ADMIN_TOKEN>
```

When configured, the config endpoint, provider mutations, and research health
endpoint require the token. The current browser UI does not store this
server-side token, so setting it without proxy header injection will prevent the
settings screen from loading. Leaving it unset preserves existing UI behavior.

Provider password fields are redacted from config responses regardless. The
redaction marker is preserved when editing another connection field, so an
unchanged API key is not overwritten.

## Research Result Changes

- Search candidates are sampled across originating queries and domains before
  semantic ranking. A fast engine or repetitive domain can no longer consume
  the whole embedding budget simply by returning first.
- Search-result deduplication and evidence deduplication are separate. Multiple
  relevant excerpts from one page or uploaded file survive relevance ranking.
- Selected excerpts from one source are combined into a single citation
  document with a 12,000-character source budget. Citation numbering remains
  aligned with the source panel while the writer receives substantially more
  evidence than the previous 2,000-character cap.
- Explicit user-requested URL scraping and automatic deep reading share the
  same URL safety checks. Non-HTTP schemes, local hostnames, private/reserved
  IPs, unsafe redirects, and DNS names resolving to private addresses are
  rejected.

The tradeoffs are additional balanced/quality latency, Firecrawl CPU and memory
use, more embedding work when deeper evidence is available, and a larger writer
context. Speed mode is unchanged by Firecrawl, and all deep-reading failures
retain the raw-snippet fallback.
