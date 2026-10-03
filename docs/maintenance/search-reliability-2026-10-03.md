# Search reliability fixes

Build `1.12.1-dorian.2` addresses the failed Balanced Coraline search. The original run attempted Jev against the wrong provider, mixed unrelated discovery results into a small quota, and accepted page scripts as useful evidence. These are functional fixes, not dependency upgrades.

## Changes

- Jev automatically recognizes OpenRouter-format keys when no provider was chosen. Explicit provider/key mismatches fail locally. Compose defaults now match the Automatic option. Source labels distinguish authentication, credit, rate-limit, timeout, and response failures.
- Native and browser extraction share readable-content cleanup. Scripts, styles, templates, and noscript payloads are removed. Title-only pages and recognized access-check shells enter fallback instead of counting as useful reads. Short facts, literal plain text, and real code examples remain supported.
- Discovery examines up to 100 merged results before applying the existing result limit. It promotes query-term matches, preserves original ordering within groups, and keeps unmatched semantic results as fallback. Media ordering remains unchanged. Invalid optional response fields cannot discard valid sibling results.
- Search engine provenance survives deduplication, page redirects, and final citation grouping. New answers save model identifiers, mode, and returned Jev usage. Regrouping evidence preserves passage counts.
- The writer is instructed to answer supported parts with citations when some sources are unhelpful, and to ignore page code and instructions embedded in sources.

## Verification

All 153 research tests pass. Lint has zero errors and the same 33 existing warnings. TypeScript and the final production build passed. Initial-query, follow-up, backend-failure, valid-empty-result, and saved-chat HTTP checks passed on the isolated local build using fixtures, with no paid calls. Desktop at 1280 × 720 and mobile at 390 × 844 passed the settings layout check with no horizontal overflow; the key field remains a password input.

An isolated probe ran patched research modules against Unraid's real SearXNG and provider credentials without changing the running application. The same two queries, candidate pool, `qwen/qwen3-embedding-8b` model, Balanced limits, and `gpt-5.4` writer were used with Jev off and on. Embeddings and successful page reads were cached across the pair, so total elapsed times are not a fair speed comparison.

For the initial query, four unrelated results in the original top eight became eight Coraline results after selection. The final probe found no known page-code markers in selected evidence. Title-only Pinterest responses were rejected as page reads and fell back to their search snippets.

Both generated answers completed with citations. The embedding-only answer cited three source IDs. The Jev answer cited five, including LAIKA's official page and its production facts. Jev ranked 15 candidates in 223 ms and reported $0.000136164 for that request. This is a useful result for one question, not proof that it improves every query or verifies source accuracy. Chat and embedding costs are separate.

The first comparison exposed an unrelated configuration error: a saved OpenAI model ID is `GPT-5.4`, while the account's live model catalog lists `gpt-5.4`. The uppercase ID returned HTTP 404. The successful probe used the verified lowercase ID without changing the saved setting.

Two Jev inference requests were made across the initial and final probes, plus embedding calls and two successful bounded writer calls. The initial writer attempt returned 404. No new chats were written to the production database.

## Remaining limits

External engines can still return weak results, rate limits, or access challenges. Lexical discovery selection is conservative and is not semantic fact checking. Jev stays optional and starts off for new chats. Familiar sources can contain mistakes, and generated answers still require judgment. This release does not implement Codex OAuth or change the chat-provider architecture.
