# Optional Jev reranking

Jev is a reasonable experiment for deciding which search results to read in depth. This integration uses its typed relevance judgments after embedding ranking and before page extraction. SearXNG still discovers results, Firecrawl or native extraction reads pages, and the configured chat model writes the answer.

The integration is off by default. No account, dependency, database migration, or change to the chat-model provider is required to keep using the existing workflow.

## Enable it

Choose one provider and supply its key through the server environment or the Compose `.env` file. Both Compose files pass these settings to the app:

```dotenv
JEV_ENABLED=true
JEV_PROVIDER=typesafe
JEV_API_KEY=your-provider-key
JEV_MODEL=
JEV_MAX_CANDIDATES=24
JEV_TIMEOUT_MS=2000
```

For OpenRouter, set `JEV_PROVIDER=openrouter` and use an OpenRouter key in `JEV_API_KEY`. The integration does not automatically reuse keys from your saved chat providers, `OPENROUTER_API_KEY`, or `TYPESAFE_API_KEY`. Keep the key server-side; there is no browser setting for it.

| Provider | Native endpoint | Default model |
| --- | --- | --- |
| `typesafe` | `https://api.typesafe.ai/v1/systemone` | `jev-1.13.0` |
| `openrouter` | `https://openrouter.ai/api/alpha/decisions` | `typesafe/jev-1.13` |

A blank `JEV_MODEL` chooses the provider's default above. An override must support the same native decision contract. Jev is not called through chat completions. Defaults are based on the [TypeSafe model documentation](https://docs.typesafe.ai/models) and [OpenRouter's Jev integration guide](https://openrouter.ai/blog/tutorials/how-to-use-jev/), checked September 29, 2026.

Use a build containing this integration. The ordinary Compose file's upstream image tag will not contain these local changes unless you build this checkout. Changing Compose environment variables requires recreating that container; changing a shell's environment does not change an already-running app. No container was deployed as part of this stage.

Set `JEV_ENABLED=false` and restart or recreate the app to return to embedding-only ranking. A key alone never enables Jev.

## Behavior and limits

- Balanced and quality modes may make one Jev request per context build. Speed mode makes none.
- Searches with attached files stay on the existing ranking path, even when no file excerpts were retrieved. The reranker also rejects mixed file/web inputs defensively.
- Only discovered web, academic, and discussion snippets are eligible. Uploaded content, already-extracted pages, credential-bearing URLs, and recognizable local URLs are excluded. DNS-based private-host detection remains part of the existing scraper, not a privacy classifier for search snippets.
- The request contains the standalone query when available, otherwise the current query, plus bounded candidate titles and snippets. It does not include URL fields, file names, arbitrary metadata, the full chat history, system instructions, or API keys from other providers. A query or snippet can itself contain sensitive text; enable this only when sending that search content to the chosen hosted provider is acceptable.
- The default shortlist is 24 candidates, configurable from 2 to a hard maximum of 32. Query text is capped at 256 tokens, each title at 64, and each snippet at 384 using the existing tokenizer. JSON payloads over 128 KiB are rejected locally. Provider responses are capped at 64 KiB.
- The default two-second deadline includes the response body. Configuration is limited to 100–5,000 ms. There are no retries or automatic provider switches. Rate limits, timeouts, network failures, and malformed or incomplete scores preserve the original embedding ranking.
- Scores are matched to explicit candidate IDs, then used to reorder the shortlist. Ties preserve original order. Candidates keep their original content, URLs, and citation metadata. Jev cannot invent a new source or execute an action.
- Stop response cancels an in-flight Jev request. Context-processing timeout also cancels it. User cancellation propagates rather than becoming a fallback that continues generation.

This adds latency and billable input to an enabled search. Limits bound each request, not total account spending. Jev's relevance judgment is not a factual accuracy or source-trust check. Its performance on this fork has not been measured against a live provider. TypeSafe documents limitations with literal instructions, large states, adversarial text, and non-English accuracy; see its [known limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13).

## Check configuration and evaluate

`GET /api/health/research` includes `services.jev`. It reports `disabled`, `misconfigured`, or `ready-unverified`, with no key value. `networkChecked` remains false because this endpoint does not make paid inference requests. The existing overall health status still describes SearXNG and extraction availability.

An attempted rerank emits a `research_jev_rerank` log entry containing status, a bounded error category, candidate count, duration, returned model ID, and token usage when provided. It does not log the query, snippets, or provider error body.

From the project root, after installing development dependencies:

```sh
yarn eval:jev
```

The default command makes no requests. It prepares six authored examples covering ambiguous words, software versions, partial evidence, instructions embedded in snippets, semantic matching, and a French query. The examples are a smoke test, not a representative quality benchmark. Their original order is fixture order, not an embedding benchmark.

After configuring a dedicated key and explicitly enabling Jev, this command makes up to six billable requests to the selected provider:

```sh
yarn eval:jev --live
```

It prints the expected candidate's position before and after reranking, latency, model, and returned usage. It stops on the first provider failure. This live evaluation has not been run because no dedicated Jev key was configured.

Before enabling Jev routinely, compare real representative searches with it off and on, including your common ambiguous queries and languages. Check useful sources in the first pages read, answer citations, latency, and provider usage. Keep it disabled if it does not improve those outcomes.

## Why this integration point

[TypeSafe's reranking cookbook](https://docs.typesafe.ai/cookbooks/rerank_typesafe) supports using a fast first-stage shortlist followed by typed candidate relevance questions. This fork already has that shortlist and a bounded page-reading budget, making this a small optional addition.

Replacing the classifier would still require a generative model to rewrite follow-up queries. Replacing the writer is unsuitable because Jev returns decisions rather than prose. Adding citation verification or research stop/go decisions would introduce additional calls and require separate evaluation. Those changes are not included here.
