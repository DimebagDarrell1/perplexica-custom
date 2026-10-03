# Optional Jev reranking

Jev is a reasonable experiment for deciding which search results to read in depth. This integration uses its typed relevance judgments after embedding ranking and before page extraction. SearXNG still discovers results, Firecrawl or native extraction reads pages, and the configured chat model writes the answer.

The integration is off by default. No account, dependency, database migration, or change to the chat-model provider is required to keep using the existing workflow.

## Set up and compare in the app

Open Settings > Search. Choose Automatic, OpenRouter, or TypeSafe, enter a dedicated Jev API key, then enable optional Jev ranking. The key stays in the server's existing settings file. Settings responses mask it, and saving the mask preserves the key. Clearing the field removes the saved key. No real key was added during development.

The Jev toggle sits beside the question box and follow-up box. It starts off for a new chat. Choose Balanced or Quality to turn it on. Speed mode and chats with uploaded files exclude Jev. Setting up the provider does not itself send an inference request.

For a useful comparison, run the same question in two new chats with the same model, embedding provider and search mode. Leave Jev off in one and turn it on in the other. Inspect selected sources, citations, answer usefulness, elapsed time and OpenRouter usage. Search results can change between runs, so this is a practical comparison rather than a controlled benchmark.

New answers save a source label that reports whether Jev was used, skipped or unavailable. Authentication failures, provider mismatches, rate limits, credit failures, and timeouts have specific messages. Saved source metadata includes model and mode identifiers, engine provenance, and Jev usage when returned by the provider. Context recovery retains completed Jev ordering and page reads. The label distinguishes retained ranking from an attempt that did not reach the answer, and identifies snippet or partial-page context. An enabled toggle alone does not prove that Jev affected an answer. Older answers have no such label.

Saved Jev settings take precedence over environment defaults. Disable it in Settings > Search to stop its use after UI configuration. Queries and public search snippets leave the server when a search actually uses Jev, and OpenRouter bills those requests separately from any Codex subscription.

## Configure environment defaults

Choose one provider and supply its key through the server environment or the Compose `.env` file. Both Compose files pass these settings to the app:

```dotenv
JEV_ENABLED=true
JEV_PROVIDER=auto
JEV_API_KEY=your-provider-key
JEV_MODEL=
JEV_MAX_CANDIDATES=24
JEV_TIMEOUT_MS=2000
```

Automatic recognizes keys beginning with `sk-or-` as OpenRouter and uses TypeSafe for other keys. An explicitly selected TypeSafe provider with an OpenRouter-format key is rejected locally. For OpenRouter, you can also set `JEV_PROVIDER=openrouter` and use an OpenRouter key in `JEV_API_KEY`. The integration does not automatically reuse keys from your saved chat providers, `OPENROUTER_API_KEY`, or `TYPESAFE_API_KEY`. The app never saves the key in browser local storage. The Search settings form sends it to the server when you enter it.

| Provider     | Native endpoint                             | Default model       |
| ------------ | ------------------------------------------- | ------------------- |
| `typesafe`   | `https://api.typesafe.ai/v1/systemone`      | `jev-1.13.0`        |
| `openrouter` | `https://openrouter.ai/api/alpha/decisions` | `typesafe/jev-1.13` |

A blank `JEV_MODEL` chooses the provider's default above. An override must support the same native decision contract. Jev is not called through chat completions. Defaults are based on the [TypeSafe model documentation](https://docs.typesafe.ai/models) and [OpenRouter's Jev integration guide](https://openrouter.ai/blog/tutorials/how-to-use-jev/), checked September 29, 2026.

Use a build containing this integration. The ordinary Compose file's upstream image tag will not contain these local changes unless you build this checkout. Changing Compose environment variables requires recreating that container; changing a shell's environment does not change an already-running app. No container was deployed as part of this stage.

If you have not saved a UI override, set `JEV_ENABLED=false` and restart or recreate the app to return to embedding-only ranking. Otherwise disable it in Settings > Search. A key alone never enables Jev.

## Behavior and limits

- Balanced and quality modes may make one Jev request per context build. Speed mode makes none.
- Searches with attached files stay on the existing ranking path, even when no file excerpts were retrieved. The reranker also rejects mixed file/web inputs defensively.
- Only discovered web, academic, and discussion snippets are eligible. Uploaded content, already-extracted pages, credential-bearing URLs, and recognizable local URLs are excluded. DNS-based private-host detection remains part of the existing scraper, not a privacy classifier for search snippets.
- The request contains the standalone query when available, otherwise the current query, plus bounded candidate titles and snippets. It does not include URL fields, file names, arbitrary metadata, the full chat history, system instructions, or API keys from other providers. A query or snippet can itself contain sensitive text; enable this only when sending that search content to the chosen hosted provider is acceptable.
- The default shortlist is 24 candidates, configurable from 2 to a hard maximum of 32. Query text is capped at 256 tokens, each title at 64, and each snippet at 384 using the existing tokenizer. JSON payloads over 128 KiB are rejected locally. Provider responses are capped at 64 KiB.
- The default two-second deadline includes the response body. Configuration is limited to 100–5,000 ms. There are no retries or automatic provider switches. Rate limits, timeouts, network failures, and malformed or incomplete scores preserve the original embedding ranking.
- Scores are matched to explicit candidate IDs, then used to reorder the shortlist. Ties preserve original order. Candidates keep their original content, URLs, and citation metadata. Jev cannot invent a new source or execute an action.
- Stop response cancels an in-flight Jev request. Context-processing timeout also cancels it. User cancellation propagates rather than becoming a fallback that continues generation.

This adds latency and billable input to an enabled search. Limits bound each request, not total account spending. Jev's relevance judgment is not a factual accuracy or source-trust check. A bounded live Coraline comparison produced cited answers with Jev off and on; Jev added the official LAIKA source in that test. This single result is not a general quality benchmark. See [the reliability review](../maintenance/search-reliability-2026-10-03.md). TypeSafe documents limitations with literal instructions, large states, adversarial text, and non-English accuracy; see its [known limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13).

## Check configuration and evaluate

`GET /api/jev` reports Jev configuration without contacting the provider. `GET /api/health/research` also includes `services.jev`. It reports `disabled`, `misconfigured`, or `ready-unverified`, with no key value. `networkChecked` remains false because this endpoint does not make paid inference requests. The existing overall health status still describes SearXNG and extraction availability.

An attempted rerank emits a `research_jev_rerank` log entry containing status, a bounded error category, candidate count, duration, returned model ID, and token usage when provided. It does not log the query, snippets, or provider error body.

From the project root, after installing development dependencies:

```sh
yarn eval:jev
```

The default command makes no requests. It prepares six authored examples covering ambiguous words, software versions, partial evidence, instructions embedded in snippets, semantic matching, and a French query. The examples are a smoke test, not a representative quality benchmark. Their original order is fixture order, not an embedding benchmark.

After configuring a dedicated key and explicitly enabling Jev through the environment, this command makes up to six billable requests to the selected provider:

```sh
yarn eval:jev --live
```

It prints the expected candidate's position before and after reranking, latency, model, and returned usage. It stops on the first provider failure. The six-case synthetic live evaluation has not been run. The separately documented Coraline comparison used the configured OpenRouter key.

Before enabling Jev routinely, compare real representative searches with it off and on, including your common ambiguous queries and languages. Check useful sources in the first pages read, answer citations, latency, and provider usage. Keep it disabled if it does not improve those outcomes.

## Why this integration point

[TypeSafe's reranking cookbook](https://docs.typesafe.ai/cookbooks/rerank_typesafe) supports using a fast first-stage shortlist followed by typed candidate relevance questions. This fork already has that shortlist and a bounded page-reading budget, making this a small optional addition.

Replacing the classifier would still require a generative model to rewrite follow-up queries. Replacing the writer is unsuitable because Jev returns decisions rather than prose. Adding citation verification or research stop/go decisions would introduce additional calls and require separate evaluation. Those changes are not included here.
