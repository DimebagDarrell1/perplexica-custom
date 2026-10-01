# Final review, October 1, 2026

The local implementation and verification are complete. The final source passed
82 regression tests, TypeScript, and a production build under Node 24.21.0.
ESLint reports zero errors and 33 warnings. The dependency audit reports zero
known vulnerabilities across 909 dependencies. These checks support the tested
local workflows; Linux containers and live search providers still need testing.

All changes from these stages remain local and uncommitted on
`codex/vane-integration-pass`, based on commit `3379745`. Nothing from this work
was pushed or deployed. Existing data and unrelated working-tree changes were
preserved.

| Work | Result |
| --- | --- |
| [Stage 1](stage-1-2026-09-26.md) | Correct tool-result ordering, source identity and file ranking; safer DNS-bound HTTP/browser extraction, answer markup and citation links. |
| [Stage 2](stage-2-2026-09-29.md) | Updated dependencies, restored 34 tracked assets, repaired standalone browser packaging, added QA and container CI. Audit findings fell from 333 dependency-path findings to zero. |
| [Stage 3](stage-3-2026-09-29.md) | Stop with saved partial answers, reconnect without restarting research, reliable stream parsing, bounded evidence, snippet fallback, atomic settings writes, upload and IME fixes. |
| [Stage 4](stage-4-2026-09-29.md) | Optional Jev snippet reranking with time, size and privacy limits, original-order fallback and an offline evaluation command. It remains disabled. |
| [Stage 5](stage-5-2026-09-30.md) | Fixed a reproduced Node 24 SQLite native crash, improved service health checks, added migration compatibility tests and disposable runtime checks. |
| Final review | Migration rollback and history preservation, lower streaming replay memory, API cancellation and cleanup, bounded Firecrawl responses, PDF cleanup, isolated uploads, and recoverable weather errors. |

The upstream review informed selected fixes, including cancellation, empty tool
arguments, and IME handling. The proposals and review-time status are recorded
in stage 3. They were adapted to this fork; no wholesale upstream merge was made.

The runtime target is Node 24.21.0 with Yarn 1.22.22. Supported Node versions are
22.13 through 24. Main pinned upgrades include Next.js 16.3.6, React 18.3.1,
Playwright 1.63.0, jsPDF 4.2.1, and better-sqlite3 13.0.3. The stage 2 report lists
all dependency updates; stage 5 supersedes its intermediate SQLite version.

The final review fixed these additional issues:

- Pending SQLite migrations and their records now run in one immediate
  transaction. Failure rolls back the batch and prevents startup with an
  incomplete schema. The migration connection always closes.
- Legacy chat conversion now preserves citations, interleaved chats,
  consecutive questions and trailing unanswered questions. Already-applied
  migrations stay applied. This cannot restore history lost during an earlier
  migration; do not delete migration markers to force a rerun.
- Chat reconnect replay keeps current block snapshots instead of every growing
  text patch. This removes quadratic retained patch history. A regression test
  sends 1,000 updates to a 100,000-character answer, checks all live updates,
  and verifies replay uses the final block. This is not a general memory cap.
- API research shares cancellation with its parent session and passes signals
  through models, context building and widgets. Request or response-reader
  cancellation stops work. Completion and failure release subscriptions;
  non-streaming failures return HTTP 500. Streaming responses now declare
  `application/x-ndjson`, matching their existing JSON-lines payload.
- Firecrawl rejects redirects, reads at most 2,000,000 response bytes, retains
  at most 50,000 content characters per page and caps its timeout at 60 seconds.
  Cancellation is checked before cache use. Errors retain native fallback.
  These limits do not replace network isolation on the remote Firecrawl server.
- PDF parsers close on success and failure. Uploads respect `DATA_DIR`, keeping
  isolated runs out of the normal upload directory.
- Weather failures now show an accessible status and Retry button. Requests
  have deadlines and clean up on unmount; refreshes do not overlap. The widget
  uses device location only when permission is already granted, otherwise it
  uses approximate IP location. It no longer opens an automatic location prompt.
- API and Firecrawl documentation describe the new behavior. Generated browser
  snapshots and screenshots are excluded from Git and remain available locally.

Verification used a separate source copy, configuration and SQLite database.
All application code, tests and build inputs in the workspace match that tested
copy. The three original files under `data/` retain their baseline SHA-256 hashes.

The built app completed discovery, embeddings, extraction, citations, answer
streaming and persistence with controlled service fixtures. Tests confirmed
cancellation saves partial output, reconnect reuses the running writer, and the
JSON search API completes. Native browser extraction also succeeded against
example.com. Fixture results do not establish live model or search quality.

Desktop at 1280 by 900 and mobile at 390 by 844 passed the affected interaction
checks. Weather failure and retry recovered correctly. Mobile Stop saved the
partial answer through reload, with viewport and document width both 390 pixels.
No page JavaScript error occurred in the final mobile check. The existing Stop
button measures 33 by 33 pixels; this was not a full accessibility audit.

Evidence is in `/private/tmp/perplexica-final-20260930/`, including QA, build,
audit, runtime, migration and API logs, the original source snapshot, data hashes,
and the review diff. Browser screenshots are in `output/playwright/`. Temporary
files may be removed by macOS. The project reports and regression tests persist.
The disposable browser and servers at ports 3022 and 4022 were stopped afterward.

Before upgrading an instance, stop it and back up its entire data directory,
including SQLite, configuration and uploads. Use Node 24.21.0 and Yarn 1.22.22
for a local install, then run `yarn install --frozen-lockfile`, `yarn qa` and
`yarn build`. Install the matching browser with `yarn browser:install` for native
extraction. `yarn start --hostname 127.0.0.1 --port 3000` serves a locally built
preview at `http://127.0.0.1:3000`. Use a disposable data directory for verification
and copy `drizzle/` into it before starting with `DATA_DIR` set.

The remaining checks require a Docker-capable test host and reachable SearXNG
and Firecrawl URLs. Docker and alternative container runtimes are unavailable
on this Mac. Neither image nor the new GitHub Actions container job has run.
The remote Compose build uses the branch on GitHub and will not include these
uncommitted local changes. To test the current source, copy the working tree to
the test host and build from its local context, without production volumes:

```sh
docker build -f Dockerfile -t perplexica-custom:verify .
docker run --rm -i perplexica-custom:verify node --input-type=module < scripts/check-browser.mjs
docker run -d --name perplexica-final-check -e HOSTNAME=0.0.0.0 -e JEV_ENABLED=false -e FIRECRAWL_ENABLED=false perplexica-custom:verify
docker exec -i perplexica-final-check node --input-type=module - http://127.0.0.1:3000 --bundled-search < scripts/check-runtime.mjs
docker logs perplexica-final-check
docker rm -f perplexica-final-check
```

Use an unused container name. Repeat with `Dockerfile.slim`, omitting
`--bundled-search`. The runtime check expects an empty disposable database.
Then configure the intended services on an isolated test instance and verify
real search, a successful Firecrawl scrape and native fallback. Health alone
does not prove extraction works. The same checks are encoded in
`.github/workflows/quality.yaml` for a later authorized push.

Keep `JEV_ENABLED=false` until representative live searches show better sources
or answers at acceptable latency and cost. No paid Jev call was made and no
quality gain is claimed. See [Jev setup and evaluation](../installation/JEV.md)
for explicit live-test requirements. Speed mode and chats with attachments skip
Jev. Jev receives query, title and snippet text when enabled.

Chat reconnect sessions remain in memory for up to 30 minutes and do not survive
server restarts. Model initialization before streaming is not interruptible;
local transformer computation can stop waiting without forcibly terminating the
underlying calculation. API request cancellation stops its job rather than
preserving it for reconnect. The 33 remaining lint warnings and these runtime
limits are documented; no production stability or universal optimization claim
is implied by the passing local checks.
