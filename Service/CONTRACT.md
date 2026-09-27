# LocHub service contract (for the UE plugin and the web app)

Types live in `src/contract.ts`; this file is the wire-level summary. All bodies are JSON (UTF-8).
Base URL in local mode: `http://127.0.0.1:47810` (`lochub_service.mjs serve --project <ProjectDir> [--port] [--policy
validated|approved_only] [--provider anthropic|openai|xai|deepseek|gemini|custom] [--auth api|subscription]
[--translate-model <id>] [--judge-model <id>] [--web-dir <dir>] [--web-deps-dir <dir>] [--brief-file <path>]
[--base-url <url> | env LOCHUB_CUSTOM_BASE_URL] [--key-header bearer|api-key] [--structured-output json_schema|json_object|prompt_only]
[--price-in <usd>] [--price-out <usd>] [--max-parallel <1-32>] [--request-timeout <30-300>]`).
`--provider` defaults to `anthropic`, `--auth` to `api`; an absent or empty `--translate-model`/`--judge-model`
falls back to the Anthropic defaults only for `--provider anthropic` — every other provider requires both flags.
`--auth subscription` is only valid with `--provider anthropic`. `--brief-file` names a UTF-8 text file (a leading
BOM is tolerated and stripped) read once at start — the project brief, sent with every translate and judge request
(`buildCultureBlock`, `src/prompt.ts`); absent, or the file missing, means an empty brief, so an old plugin build
that never passes the flag still works.

`--length-check off|warning|confirm`, `--length-scope ui|all`, `--length-ratio <1-5>`, `--length-extra <0-100>`,
`--length-ratios <culture>=<ratio>,...` and `--length-hint on|off` configure the Length Check (Project Settings >
Plugins > LocHub > Length Check; `src/lengthCheck.ts`). Absent flags mean the check is off (an old plugin build); a
value outside those sets or ranges, a malformed or repeated culture in `--length-ratios`, is a usage error. The limit
of a unit in a culture is `ceil(visibleLength(source) × ratio) + extra` (ratios with two decimals; a culture override
matches the exact culture case-insensitively, then its language before the first `-`), or none when the check is off,
`--length-scope ui` and the unit's `LocHub.Kind` is not `ui`, or the source has nothing visible. `visibleLength` counts
what the player sees: format arguments and rich-text tags 0, a plural/ordinal/gender/hpp argument its longest form,
East Asian wide and fullwidth characters, and emoji (U+1F300–U+1F64F, U+1F900–U+1F9FF), 2; non-spacing and enclosing
marks (`\p{Mn}`, `\p{Me}`) and zero-width characters (U+200B–U+200D, U+FEFF) 0 — a spacing mark (e.g. a Devanagari
vowel sign) counts like ordinary text, not 0; the UE rich-text entities `&amp;` `&lt;` `&gt;` `&quot;` 1 each; every
other code point 1.

`--provider custom` is any OpenAI-compatible endpoint (a local model, a router, a private deployment). The Base URL
comes from `--base-url` (`http://` or `https://`, no user name or password; one trailing `/` is trimmed;
`/chat/completions` and `/models` are appended to its path, before any query string) when given, otherwise from the
environment variable `LOCHUB_CUSTOM_BASE_URL`, read exactly like `LOCHUB_API_KEY` (`src/cli.ts`'s
`resolveCustomBaseUrl`) — the editor sets this variable for the spawn and never puts the Base URL on the command
line (Windows logs a failed `CreateProcess`'s whole command line on error; macOS's argument splitter drops a value
ending in `=`); `--base-url` still wins when both are given, for a manual run or `Tools/media/shoot.mjs`. Neither
source given is a usage error naming "Custom Base URL is required"; an invalid value's error names "--base-url" when
it came from the flag and "Custom Base URL" when it came from the environment — no usage error ever echoes the base
URL itself. `--provider custom` also takes `--key-header` (default `bearer`, sending `Authorization: Bearer <key>`;
`api-key` sends `api-key: <key>`), `--structured-output` (default `json_schema`: strict `response_format:
json_schema`; `json_object`: `response_format: json_object` with the schema in the system prompt; `prompt_only`: no
`response_format`, schema in the system prompt), `--price-in`/`--price-out` (USD per 1M tokens for both models,
default `0`), `--max-parallel` (default `2`; an n-slot semaphore inside the service's one `OpenAiCompatibleLlmClient`
instance gates every request across every job running at once — not just one job's own workers — so every value
1-32 takes effect) and `--request-timeout` (seconds **per attempt**, `30`-`300`, default `300`: Node's built-in fetch
gives up on its own once a response's headers take longer than 300 s — `UND_ERR_HEADERS_TIMEOUT`, or
`UND_ERR_BODY_TIMEOUT` for a stalled body — so a larger value could never take effect; either code, on the error or
its `cause`, counts as a timeout exactly like the configured one firing). A request that times out is not retried at
the fetch level — the job splits its group the same way it does a `max_tokens` truncation (see "Timeouts and probe
mode" under Jobs), and that split, not a longer timeout, is what lets a slow model finish: each half is a shorter
request. The timeout's English reason names the limit that fired (`Custom: the request timed out after 90 seconds`,
`… after 5 minutes`). No
output-token cap (`max_tokens`/`max_completion_tokens`) is ever sent to a Custom endpoint — the server's own default
applies; a `finish_reason: "length"` still splits the group like a real cap being hit. A Custom chat request and the
startup probe both refuse a redirect (`redirect: 'error'`) instead of following it — fetch forwards every header but
`Authorization` cross-origin, `api-key` included — and report it as a non-retryable error telling the user to set
Base URL to the final address; a refused redirect is final at once (the server answers the same 3xx every time), with
no fetch-level retry. Any of the Custom-only flags with another provider is a usage error. The key still
comes only from `LOCHUB_API_KEY` and may be empty for `custom` (no auth header is sent then). Both `--translate-model`
and `--judge-model` stay required (the editor passes the translate model as the judge when Judge Model is empty).

A Custom chat error's message is built from the response body read once as text: `error.message`, a string `error`,
a top-level `message`, `detail`, then the raw text, in that order (the first non-empty one wins), scrubbed of every
full URL (reduced to `scheme://host[:port]`), of the configured Base URL's exact path and query string (split out
verbatim, so a literal character such as a comma inside a query cannot defeat the URL regex), of every query value of
4 or more characters echoed on its own — as written in the Base URL or percent-decoded, replaced with `[redacted]`
(a shorter value, or one that is part of the host or port, is left as is) — and of the key,
then cut to 200 characters. A network failure names its cause the same way the probe does (e.g. `ECONNREFUSED`)
instead of a bare "fetch failed". A missing `usage` (or a missing `completion_tokens`) falls back to the request's
approximate input/output token counts (`approxInputTokens`/`approxOutputTokens`, `src/llmShared.ts`), the same guess
used when the estimate itself is approximate. Answer parsing (`OpenAiCompatibleProfile.tolerantJson`) strips a
leading `<think>...</think>` block before extracting the JSON object, and among balanced top-level objects prefers
the one carrying the response schema's own required top-level key (`items` for translate, `issues` for judge) over
the first one — a reasoning model's chain of thought can itself contain a draft JSON object.

## Identity

- A unit is `(namespace, key)` of a UE text. The service derives `unitId = sha256(JSON.stringify([namespace, key]))`,
  first 16 hex characters. The plugin never computes ids: it sends `namespace`/`key` and gets ids back in responses.
- Metadata key `LocHub.Kind`: `"ui"` for text shown in widgets, `"text"` otherwise (affects triage).
- `cell.basedOnSource` is the English text the translation was made from; `outdated` = `cell.basedOnSourceRev < unit.sourceRev`.

## Request hygiene

- **Culture**: every path/query/body field that names a culture must match `/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/`
  (a BCP-47-ish tag; no `/`, `\` or `..`) and must be spelled exactly as an existing culture — the in-memory
  culture keys of `cells`, `glossary` and `style`, plus the cultures of jobs that are currently starting or
  running (a job holds no cells/glossary/style file yet, but still reserves its spelling) — `RU` is rejected
  once `ru` exists, with `400 { error: 'Culture must be spelled "ru"' }`, because `ru`/`RU` are the same file
  on a case-insensitive filesystem. A malformed value gets `400 { error: 'Invalid culture' }`. This applies to
  `/api/cells`, `/api/cells/:culture/...`, `/api/export`, `/api/export/ack` (`culture` field), `/api/jobs`,
  `/api/jobs/estimate`, `/api/glossary/:culture`, `/api/style/:culture`, `/api/inbox?culture=` (when given),
  `POST /api/inbox` (`culture` field) and
  `/api/summary`. It also covers every key of `push`'s and `reconcile`'s `archives`, including two keys of the
  same request that differ only in case from each other. The check runs before any store read or write.
- **Host allowlist**: every request must present `Host: 127.0.0.1:<port>` or `Host: localhost:<port>` for the
  port the service was started on (compared case-insensitively), else `403 { error: 'Forbidden host' }`
  (loopback bind alone does not stop a browser page from sending same-origin-looking requests — DNS rebinding).
  Do not run the service on port 80: a browser omits the default port from its `Host` header, so it would
  never match `127.0.0.1:80`/`localhost:80` and every real request would get `403`.
  The web app's own pages (`/`, `/*`) sit behind the same check: open it at `http://127.0.0.1:<port>/` or
  `http://localhost:<port>/`. `npm run dev` in `Plugins/LocHub/Web` proxies `/api` with `changeOrigin: true`, so the
  service sees its own address in `Host`.
- **`Sec-Fetch-Site` (cross-site requests)**: a request whose `Sec-Fetch-Site` header is `cross-site` is refused
  before routing with `403 { error: 'cross_site' }` — this is the header a browser sets on a request a foreign
  page makes across origins, including a no-cors `EventSource` kept open on `/api/bridge/stream` to probe
  `editorConnected`. `same-origin`, `same-site`, `none` and a request with no such header (the plugin's HTTP
  client, curl) all pass through unaffected.
- **Framing**: every response carries `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors
  'none'`, so a foreign page cannot embed this origin in an iframe to clickjack Approve / Estimate+Run /
  Apply-to-N.
- **JSON-only mutations**: every `POST`/`PUT`/`DELETE` must send `Content-Type: application/json`, else
  `415 { error: 'Content-Type must be application/json' }`. A route with no other required fields (for example
  `/api/cells/:culture/:unitId/approve`) still needs a body of `{}` to satisfy this.
- **Push/ack validation**: `POST /api/push` and `POST /api/export/ack` validate the whole body before making any
  store change and answer `400 { error }` naming the first offending field and index (for example
  `"entries[3].source must be a string"` or `"written[0] must have string unitId and translation"`) rather than
  applying part of the payload.

## Jobs

- The estimate returned by `/api/jobs/estimate` and by `/api/jobs` is an estimate, not an upper bound: the
  translate model thinks adaptively by default (thinking tokens bill as output), and precheck repair rounds and
  retries are not counted.
- `JobEstimate` is `{ requests, items, strings, inputTokens, outputTokens, usd: number | null, billing: 'api' |
  'subscription', approximate?, pricesUnset? }`. `requests`/`items` count the groups/units the model was actually
  asked about (TM reuse and cache hits are free and excluded); `inputTokens`/`outputTokens` are the upper-bound
  token counts the estimate is built from. `strings` is every string in scope the job would actually write —
  `items` plus TM reuse plus cached answers — and is `0` only when the scope truly has nothing to do; a web view
  uses `strings`, not `items`, to decide whether a scope is empty, since `items` alone reads `0` for a scope that
  is entirely free TM/cached work. `usd` is `null` when the translate or judge model has no entry in
  `PRICES_PER_MTOK` (an unlisted or custom model id) — the web then shows the estimate without a dollar figure.
  `billing` mirrors `ai.auth`, so the web can hide USD for a backend that is not billed per token (the
  subscription). `approximate` is present and `true` whenever at least one group's `inputTokens` came from a
  local character-count guess (`approxInputTokens`, `llmShared.ts`) instead of a real `countTokens` call: this
  covers `skipEstimate` below (every group is a guess), a rate-limit/overloaded error that survived the
  Anthropic SDK's own retries (every group not yet counted at that point, not just the one that failed — see
  the token-counting bullet below), and every provider whose `countInputTokens` is never a real provider call
  in the first place — OpenAI-compatible, Gemini and the Claude Code/subscription adapter all count locally
  with no free token-count endpoint (`LlmClient.countsAreApproximate`, `llm.ts`), so a job on any of them is
  always `approximate: true`. Absent (never `false`) only when every group's count was a real, successful
  Anthropic-with-API-key `countTokens` call. The web shows "≈" / "approximate" wording wherever it renders an
  estimate with this set.
  For `provider: 'custom'` the translate and judge models are both priced with `--price-in`/`--price-out`
  instead of `PRICES_PER_MTOK`, so `usd` is never `null`; when both prices are `0`, `usd` is `0` and
  `pricesUnset: true` is present (absent otherwise, never `false`) — Max USD then has nothing to limit, and the
  web says so. With any price above `0` the estimate and the `maxUsd` requirement work exactly as for a built-in
  provider.
  `POST /api/jobs` requires `maxUsd` (`400 { error: 'culture and maxUsd are required' }` when it is absent) and
  enforces it (`422 { error: 'budget' }`) only when billing is `'api'` **and** `usd` is known **and** nonzero; a
  subscription job, a job on an unpriced model, or a job whose `usd` is exactly `0` (no translate cost is
  estimated for it — TM reuse and cached translate answers; judging may still run against those strings) ignores
  `maxUsd` entirely — an absent `maxUsd` is accepted for any of the three. A `maxUsd` that
  *is* present but is not a finite positive number (zero, negative, `NaN`/`Infinity`, or not a number at all)
  still answers `400 { error: 'invalid_maxUsd', message: 'maxUsd must be a finite positive number' }` before any
  token counting, regardless of `usd`.
- Token counting (the only network call `/api/jobs/estimate` and `POST /api/jobs` make while estimating, and
  only for Anthropic with an API key) runs up to 8 groups concurrently instead of one at a time, and remembers
  every real count it gets back, keyed by the group's `requestId` (model, prompt version, glossary, context,
  brief, source — a changed one is simply a different key), for the life of the running service: Run right
  after Estimate, and a repeated Estimate of the same scope, make no further `countInputTokens` calls for a
  group already counted; a changed brief/glossary/model/source only re-counts the groups that changed. If a
  count still fails with a rate-limit or overloaded error after the SDK's own retries, every group not yet
  counted falls back to `approxInputTokens` instead of each making its own doomed call — the groups already in
  flight alongside the one that failed (at most 8 - 1 of them) still complete normally — instead of failing the
  whole estimate, and the result carries `approximate: true`; any other (non-rate-limit/overloaded) error stops
  every group not yet counted the same way, then fails the whole estimate with that error.
- `POST /api/jobs` accepts `skipEstimate: true` to start the job immediately with **no provider calls before
  it starts** (no `countInputTokens` for any group): `maxUsd`, if sent, is ignored outright — not required, not
  validated, not enforced against a budget — since there is no real cost estimate to hold it against. The
  response's `estimate` is still present, computed locally from `approxInputTokens` with `approximate: true`.
  Every other gate still applies (`ai_not_ready`, `job_running`, scope validation, `batch_unavailable`).
- `groupPrefix` (path/folder filter): an alternative to `groupKey` on `POST /api/jobs` and `POST /api/jobs/estimate`.
  `selectWork` matches every unit whose `groupKey` starts with it (`unit.groupKey.startsWith(groupPrefix)`), instead of
  the exact match `groupKey` does. Must be a non-empty string of at most 512 characters, and mutually exclusive with
  `groupKey` — either violation answers `400 { error: 'invalid_scope' }` before any token counting.
- `mode: 'batch'` on `POST /api/jobs` or `POST /api/jobs/estimate` answers `400 { error: 'batch_unavailable',
  message: 'Batch mode is only available for Anthropic with an API key.' }` unless the service is running
  Anthropic with an API key (`--provider anthropic --auth api`, the default) — Batch does not exist yet for the
  subscription or for any other provider. When `mode` is omitted from the request, it defaults to `'sync'` (Now/full
  price) regardless of provider or auth, since Batch can take minutes to hours and should be an explicit choice.
  Batch remains fully supported here at the API level, but the editor's Jobs UI does not offer it — it always
  sends `mode: 'sync'` (the owner's decision, not a service limitation).
- `POST /api/jobs` and `POST /api/jobs/estimate` answer `400 { error: 'ai_not_ready', message }` when `ai.auth`
  is `'api'`, the provider is not `custom`, and the key variable is not set in the environment — the same check and `message` as
  `GET /api/health`'s `ai.detail` (below), run before any LLM call. This matters most for the four providers
  whose estimate never touches the network (`approxInputTokens`, a local character count): without this gate a
  missing key used to fail the job instead of the request, silently, with no reason recorded. The subscription is
  unaffected — its readiness comes from `claude auth status`, not an environment variable, and is checked
  separately, not by this gate. Only Anthropic with an API key counts tokens through the model
  while estimating (`countTokens`); every other provider, and the subscription, estimates locally. Once the key
  is present, `POST /api/jobs` and `POST /api/jobs/estimate` can still answer `500` if the model API itself is
  unreachable, but only for that one combination — Anthropic with an API key — since that is the only path where
  estimating calls the model at all. A job that started can later end `status: 'failed'` with `error` set,
  instead of `'done'`.
- Job records live only in memory: they do not survive a service restart. `GET /api/jobs/:id` for a job that was
  `running` when the service restarted answers `404 { error: 'Unknown job' }`.
- `JobReport.errorSamples: string[]` — up to 3 distinct error messages, the last one seen for each string
  counted in `errors`, first seen first, each truncated to 300 characters and passed through `redactSecrets`
  (strips `LOCHUB_API_KEY`'s exact value, plus anything shaped like `sk-…`/`xai-…`/`AIza…`/a `Bearer` token,
  replacing it with `[redacted]`), so a misconfigured provider (a typo'd model id, an invalid key, no credit)
  surfaces a reason a reviewer can act on instead of a bare, unexplained error count. Also carries a judge
  failure's reason, prefixed `"Judge: "` — a judge failure is not itself counted in `errors`.
- First-round abort: if the very first translate round sent at least one request and every one of them
  ended in a non-retryable error (not a refusal, not `max_tokens`), the job ends `status: 'failed'` with
  `JobRecord.error` set to the first such message, redacted, before any cell is written — no cell becomes
  `needs_fix`/`llm_error` and no `ai_error` event is logged for translate work. TM reuse and any cached answer
  already written before that round are unaffected. A round with a mix of successes (including cache hits) and
  hard failures does not abort; the job finishes normally and the failures land in `errors`/`errorSamples`.
- Timeouts and probe mode (`src/job.ts`, translate phase): a request whose error message carries the shared timeout
  text (`timeoutMessage`/`isTimeoutMessage`, `src/llmShared.ts` — "the request timed out after …") has its group split
  in two like a `max_tokens` truncation, and a single string that times out fails with that reason. This applies to
  every provider whose adapter reports a timeout that way — OpenAI, xAI, DeepSeek, Gemini and Custom (LocHub's own
  limit or Node's 300 s fetch limit); the Anthropic API (its SDK retries its own timeouts) and Claude Code (a timed-out
  `claude` child is an ordinary retryable error) keep the whole-group retry. An endpoint that has **answered nothing**
  in this job is probed instead of flooded: once a timeout lands before the job's first successful answer (a cache
  hit counts as one), that round's requests that have not started yet are not sent (they are held, not failed — no
  error, no cost, no progress), and each following round sends only the two halves of the largest group that timed
  out while every other group waits unchanged. The first successful answer releases every waiting group, cut into
  pieces no larger than the largest group that was answered, and the job continues under the rules above. A single
  string that times out before any success ends the job `status: 'failed'` with that timeout's message (redacted),
  before any cell is written — like the first-round abort, TM reuse already written stays. A hung endpoint therefore
  costs about (1 + split depth) timeouts per parallel request (7 waves for a group of 40), and probe rounds do not use
  the translate round budget. A probed string that fails for another reason (a hard error, a refusal) leaves the
  waiting groups to be sent as they are once nothing is left to probe. Repair and judge requests are not probed: they
  only run after translate answers came back.
- `POST /api/cells/:culture/:unitId/retranslate`'s `502` keeps its current error code; the body's `error` text
  (there is no `message` field — `sendCellError` sends a `CellActionError` as `{ error, issues }`, `server.ts:106`)
  becomes `'The model call failed: <reason>'`, reason redacted, when the model call itself failed. A refusal
  keeps its own `'The model refused this string'` text, unchanged.
- Batch jobs survive a service restart: rerunning the same job resumes the persisted batch (`Saved/LocHub/batches/`)
  instead of paying for it again, as long as the rerun submits the same request set (round 1, and anything
  already replayed from the cache). A persisted batch the API no longer serves (crashed under a different
  workspace/org credential, past its retention window, or deleted) is dropped and a fresh batch is submitted
  instead of wedging the job; job records themselves still live in memory only, per the point above.
- `JobRecord.progress?: JobProgress` — `{ phase: 'translate' | 'repair' | 'judge' | 'write', done, total }`,
  updated from the job's own `onProgress` while it runs and left at its last value once the job ends (`done` or
  `failed`). Absent until the job's first progress event lands (a job that failed before its first LLM call
  never gets one). Units are **strings**, not requests/groups:
  - `translate`: an initial `{ done: 0, total }` fires before the first request even goes out; `total` is the
    strings actually sent to the model (TM reuse excluded, same population as `report.written + suggestions +
    needsFix + refused + errors`); `done` is strings settled — translated, or finally refused/errored — and
    rises as individual answers arrive (sync mode caches and counts each one as it comes back, not only once a
    whole round of groups finishes; batch mode gets a coarser, proportional estimate while a round's batch is
    still polling, from `request_counts`). A string whose group is still being retried or was just split is not
    counted until a later, final outcome settles it.
  - `repair`: scoped to one repair round at a time — each round starts with its own `{ done: 0, total }`, where
    `total` is the strings that round is repairing (however many still have a `hard` or `confirm` precheck issue,
    or a soft `too_long` not yet repaired in this job, when the round starts, so a later round's `total` can be
    smaller than an earlier one's), and `done` rises as
    each repair answer comes back. A job with no repair rounds (no such issues, or `maxRepairRounds: 0`) never
    reports this phase.
  - `judge`: starts with `{ done: 0, total }`; `total` is the judgeable strings (passed precheck); `done` rises
    as each judge group's answer comes back, successful or not. Skipped (no report at all) when there is
    nothing to judge.
  - `write`: reported twice — `{ done: 0, total }` right before the write loop starts, `{ done: total, total }`
    right after it ends. `total` is the same string population as `translate`'s.
  - Invariants a client can rely on: within one phase, `done` never decreases and never exceeds `total`
    (`repair`'s per-round reset is the one exception — its `total` itself changes between rounds); every phase
    that runs reaches `done === total` before the next phase's first event; phases appear in the order above;
    a phase with nothing to do for this job is skipped entirely (no event at all, not a `{0,0}` one).

## Health (`GET /api/health`)

`{ ok: true, units, editorConnected, pid, projectDir, stale, jobRunning, jobsFinished, ai }`:

- `jobRunning`: `true` while any translation job record has `status: 'running'`, `false`
  otherwise (including while a job is only `starting` — being estimated, with no record yet). The editor plugin
  reads it to avoid restarting the service under a running job when the AI settings change.
- `jobsFinished`: a monotonic counter, starting at 0 and incremented once for every job record
  that leaves `status: 'running'` (to `done` or to `failed`); never decreases and never resets for the life of
  the process. `jobRunning` alone cannot tell a web client that a job ran and finished between two health polls
  (a job shorter than one poll interval never observes `jobRunning: true`); a client instead remembers the last
  `jobsFinished` value it saw and reloads whenever a later poll reports a larger one, treating its very first
  poll as establishing that baseline rather than as a signal to reload. Absent from a service that predates this
  field — a client should treat that the same as "no reload", exactly like an old service's missing `ai`.
- `ai`: `{ provider, auth, translateModel, judgeModel, batch, ready, detail, briefSha1, keyId, customSettingsId?, endpoint?, lengthArgs }` —
  `provider`/`auth`/`translateModel`/`judgeModel` mirror the CLI's `--provider`/`--auth`/`--translate-model`/
  `--judge-model` (`AiConfig`, `src/providers.ts`).
  `briefSha1` is the lowercase hex SHA-1 of `--brief-file`'s raw bytes as read (before the BOM strip); an absent
  flag or a missing file hashes to the SHA-1 of an empty input, the same value an old plugin build (which never
  passes `--brief-file`) reports. The editor plugin compares this against the hash of what it just wrote to
  decide whether a Project Brief change already applied. A service started before this field existed has no
  `briefSha1` at all — the plugin treats that the same as "applied" (nothing to compare), the same rule
  `jobsFinished` and `ai` itself use for an older service.
  `batch` is `true` only for `provider: 'anthropic', auth: 'api'` (Batch does not exist yet for any other
  provider or for the subscription). `ready`/`detail` come from `checkClaudeAuthStatus()` (`claude auth status`,
  cached once at startup) when `auth` is `'subscription'`, otherwise from the environment alone: `ready` is
  whether `LOCHUB_API_KEY` is set (see Environment, below — the service reads no other variable, whatever
  provider is configured), `detail` is `'API key is set'` when it is (never the variable name — this text
  reaches the client over HTTP, and can reach a screen), or the fixed text `'No API key: enter
  it in Project Settings > Plugins > LocHub > AI > API Key.'` when it is not (`MISSING_KEY_MESSAGE`,
  `src/llmShared.ts`) — every place the service or the web UI reports a missing key uses this same sentence. A
  service started before this field existed has no `ai` key at all; a client should treat that the same as
  Anthropic with an API key. This same `ready`/`detail` computation (for `auth: 'api'`) is what `POST /api/jobs`
  and `POST /api/jobs/estimate` check before doing any work — see `ai_not_ready` under Jobs, above.
  `keyId` is the first 12 lowercase hex characters of SHA-1 over the UTF-8 bytes of `LOCHUB_API_KEY`, or `""`
  when there is no key (test vector: key `abc` gives `a9993e364706`). The editor plugin computes the same value
  from its Project Settings key and treats the service as applied only when the two are equal; a missing `keyId`
  (an older service) counts as applied, the same rule `briefSha1` uses.
  `lengthArgs` is the Length Check the service runs with, written back in the exact form the editor passes the
  flags (`lengthArgsOf`, `src/lengthCheck.ts`): `--length-check off` when the check is off or no flag was given,
  otherwise every flag in the fixed order `--length-check --length-scope --length-ratio --length-extra
  [--length-ratios] --length-hint`, ratios with two decimals, overrides in the order given. The editor compares it
  with the flags it would pass now and restarts the service on a difference; a missing `lengthArgs` (an older
  service) counts as applied.
  For `provider: 'custom'` only: a missing key is not an error — `ready` is `true` and `detail` is
  `'No API key (not required for a custom endpoint)'` (`NO_KEY_NEEDED_DETAIL`, `src/providers.ts`), and the
  `ai_not_ready` gate never fires. `customSettingsId` is the first 12 lowercase hex characters of SHA-1 over the raw
  values of the Base URL (whichever of `--base-url` or `LOCHUB_CUSTOM_BASE_URL` was actually used), `--key-header`,
  `--structured-output`, `--price-in`, `--price-out`, `--max-parallel` and
  `--request-timeout`, joined with `\n` in that order (test vector: `http://localhost:11434/v1`, `bearer`,
  `json_schema`, `0`, `0`, `2`, `600` gives `048a672d4a62`); the editor computes the same value and restarts the
  service when they differ (absent counts as applied). `endpoint` is `{ url, status, detail?, missingModels? }`
  (`EndpointHealth`, `src/contract.ts`): `url` is the base URL reduced to `scheme://host[:port]` (health never
  carries the path, query or user info; error texts are scrubbed of them as described under `--provider custom`
  above), `status` is `checking` until the one startup
  `GET {base}/models` (10 s timeout, same auth header as chat requests) answers, then `ok` (every configured model
  is listed; a bare name also matches its `:latest` tag), `model_missing` (`missingModels` lists the ids the
  endpoint does not serve), `unreachable` (network error, timeout, or HTTP 401/403) or `unknown` (any other HTTP
  error or a body that is not an OpenAI-style model list). The `ai` block never contains the Custom endpoint
  settings themselves.
- `pid`: `process.pid` of the running service. The plugin compares it against the pid recorded in its own
  `service.pid` file; the plugin adopts a service whose `pid` equals the node pid in `Saved/LocHub/service.pid`
  only when the host process recorded next to it (editor or `LocHubSync` commandlet) is no longer running
  (covers a `node` orphaned by an editor crash). Adopting takes a process handle and kills it on exit.
- `projectDir`: the absolute project directory the service was started with (`''` when the deps that built
  the server did not pass one — tests only; a real `node lochub_service.mjs serve --project <dir>` always sets
  it). The plugin
  compares it against its own project directory (normalized, case-insensitive) and refuses a mismatching
  service outright — the port is shared across projects (default 47810), so a healthy answer alone does not
  prove the service belongs to this project.
- `stale`: `store.changedOnDisk()` — true when a data file under `Localization/LocHub/` was added, removed or
  modified on disk since the service loaded it or last saved (typically a source control sync, e.g. `git pull`,
  while the service kept running). The plugin restarts a service it owns when this is true, and otherwise tells
  the user to restart the service themselves.

## Environment

The provider API key is a plain Project Settings field (`Plugins > LocHub > AI > API Key`), saved in
`Config/DefaultEditor.ini` and committed with the project — not something the user sets in their own shell or
OS environment. The editor passes the active provider's key to the service process it spawns in the
environment variable `LOCHUB_API_KEY`, set for that child only (the editor restores its own previous value of
the variable right after the spawn, so no other process it starts gets it). The service (`node
lochub_service.mjs serve …`, the real invocation the editor runs — `package.json` has no `bin`, there is no
`lochub` executable) reads this one variable once at start (`src/cli.ts`'s `resolveApiKey`, alongside
`readBriefFile`) and passes the resolved
value down explicitly to whichever provider client `createLlmClient` builds (`src/providers.ts`) — Anthropic
(`src/llm.ts`), the OpenAI-compatible adapters (`src/openaiCompatible.ts`: OpenAI, xAI, DeepSeek) and Gemini
(`src/gemini.ts`) all take it as an explicit constructor option and never read their own SDK/provider env var
(`OPENAI_API_KEY`, `XAI_API_KEY`, `DEEPSEEK_API_KEY`, `GOOGLE_API_KEY`/`GEMINI_API_KEY`, and for Anthropic
`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` and `ANTHROPIC_CUSTOM_HEADERS`, plus the
default credential chain — config file, profile, OIDC federation — the stock `@anthropic-ai/sdk` client
otherwise resolves lazily on the first request whenever no explicit `apiKey`/`authToken` is given; `llm.ts`'s
`LocHubAnthropic` closes all four, and with no key `runSync`/`runBatch`/`countInputTokens` all refuse locally,
before ever reaching the SDK) — those are ignored even when set. Empty or absent `LOCHUB_API_KEY` means no
key. The subscription path
(`--auth subscription`, `src/claudeCode.ts`) is unaffected: it authenticates through `claude auth status`, not
an API key, and still scrubs `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` from the child `claude` process's own
environment so an editor started from inside a Claude Code terminal cannot switch it off the subscription. A
key value is never placed on a command line, in a log line, in an error message or in a test fixture file
(`redactSecrets`, `src/llmShared.ts`, strips the `LOCHUB_API_KEY` value from provider error text).

`LOCHUB_CUSTOM_BASE_URL` (`--provider custom` only) works the same way: the editor sets it for the spawn exactly
like `LOCHUB_API_KEY` instead of putting the Base URL on the command line, the service reads it once at start
(`src/cli.ts`'s `resolveCustomBaseUrl`) and passes the resolved value into `parseCustomEndpointFlags`, which prefers
an explicit `--base-url` flag when one is given (a manual run, `Tools/media/shoot.mjs`). Unlike the key, the Base
URL is not secret by itself, but its query string or authority may carry one (a token, a password) — it is never
placed on a command line, in a log line or in an error message either; every place the service logs or returns it
reduces it to `scheme://host[:port]` first (`reduceBaseUrl`, `src/customEndpoint.ts`).

## Format checks: `hard`, `confirm`, `soft`

`PrecheckIssue = { code, severity, message }` (`src/precheck.ts`), returned by `check`, `retranslate` and a 422 from
`approve`/`edit`. `severity` is one of:

- `hard` — Unreal rejects the text or prints it broken: `empty`, `syntax` (an unmatched brace, a malformed
  modifier or a plural form name the engine cannot read — Unreal prints these as raw text), `args_extra` (an
  argument the game never passes prints as `{Name}`), `plural_redundant`, `plural_forms_missing`,
  `plural_form_unused` (`FTextFormatArgumentModifier_PluralForm::Validate`), `rich_tags_unbalanced` (the engine's
  own rule: balanced, or unbalanced exactly like the source; `<br>` is self-closing). Never approvable or saveable.
- `confirm` — valid for Unreal, but probably a mistake: `args_missing`, `plural_dropped`, `rich_tags` (tag names
  differ from the source, still balanced), `dnt` (the project's own glossary rule), `plural_unknown_form` (a
  form name outside the CLDR set; the engine skips it).
- `soft` — a hint: `untranslated`.

`too_long` (Length Check): the translation's `visibleLength` is over the unit's limit; message `Too long for the UI:
<len>/<limit> characters (Length Check in Project Settings)`. Its severity follows `--length-check`: `soft` under
`warning`, `confirm` under `confirm`. Every precheck caller passes the limit (`precheckOptionsFor`, `src/cells.ts`), so
`check`, `approve`/`edit` and job drafts agree. A job sends a soft `too_long` to repair once (the error line is the
message plus `Shorten it while keeping the meaning, every placeholder and every tag.`); a `confirm` one takes part in
every repair round like any other `confirm` issue. A repair never makes a good draft worse: for a string that did not
block auto-accept before its repair round, if the round's answer now blocks (it dropped a placeholder, a DNT term, a
required plural form...), the pre-repair text is kept instead, together with its own (soft) issues. With
`--length-hint on`, each translate item that has a limit carries it as `maxLength`. Exact translation-memory reuse
(step 0 of a job) runs the same precheck against the donor text: a reused text over its limit under `warning` still
lands in band Y with `too_long` in its `qaFlags`, exactly like a fresh draft would.

`approve`/`edit` take an optional `accept: string[]` (400 `{error:'accept must be an array of strings'}` otherwise):
any `hard` issue → 422 `{ error, issues }` whatever `accept` says; `confirm` issues → 422 `{ error, issues }` unless
`accept` names **every** `confirm` code of the text being approved/saved (a client that checked an older text cannot
approve issues it never showed). A `needs_fix` cell is re-checked like any other: clean, or confirm-only with
`accept`, is approvable. The event of an approve/edit that went through with confirm issues carries
`accepted: string[]` (the codes); the field is absent otherwise. A translation job holds its drafts to both tiers:
a draft with a `hard` or `confirm` issue goes to repair and, if it keeps one, is written `needs_fix`.

`edit` re-bands the cell from the fresh check it just ran (`R` for a blocking issue kept only because `accept` named
it, `Y` for any remaining soft issue such as a `too_long` under `warning`, `G` for none) instead of keeping the band
the cell carried before the edit — a stored band is only ever recomputed by the next job or an edit, never by a
settings change alone (see Length Check in the settings reference). `approve` does not change the band.

The plural categories these checks use are the engine's, from the last Push (`pluralForms`, Push protocol below),
falling back to Node's own ICU for a culture no Push has reported.

## Optimistic concurrency and `409 stale_cell`

`POST /api/cells/:culture/:unitId/{approve|edit|reject}` accepts two optional numbers: `expectedRevision` (the
cell's `revision` the reviewer saw) and `expectedSourceRev` (the unit's `sourceRev` the reviewer saw). Either
field present but not a number is `400 { error }`. When a field is present and differs from the current value,
the action answers `409 { "error": "stale_cell", "message": "This string changed since you opened it (new
source text or a newer translation). Review it again.", "cell": <current Cell>, "unit": <current Unit> }` and
writes nothing (no `putCell`, no event). Both fields absent keeps today's behaviour unconditionally — the
plugin and older web clients never send them. The check runs after `assertFresh()` (`409
files_changed_on_disk`, below) and before any of the three actions stage a write, so a stale revision is always
caught even if the request would otherwise have succeeded.

## Writes and `409 files_changed_on_disk`

Every route that calls `store.save()` (push, export/ack, the cell actions, import, glossary/style PUT, inbox
answer/dismiss/applied, a running job's own saves) can answer `409 { "error": "files_changed_on_disk",
"message": "Localization/LocHub changed on disk since the service loaded it (a source control sync?). Restart the LocHub
service." }` instead of its normal response: the store refused to overwrite a data file that changed on disk
since it was loaded, and wrote nothing. A job whose own save hits this ends `status: 'failed'` with that
message in `error` instead of `'done'`. Restarting the service (a fresh `load()`) picks up the external
content and clears `stale`.

## Endpoints

Plugin: push, export, reconcile, export/ack, inbox (answered), inbox/applied, bridge/stream. Web: everything else.

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/api/health` | — | `{ ok, units, editorConnected, pid, projectDir, stale, jobRunning, jobsFinished, ai }` — see below |
| GET | `/api/meta` | — | `{ nativeCulture, cultures[] }`: target cultures of the last Push plus cultures that have cells, only in spellings the culture guard accepts |
| POST | `/api/push` | `Snapshot`; query `dryRun=1` counts without applying | `PushReport` |
| POST | `/api/reconcile` | `{ archives: { <culture>: ArchiveEntry[] } }` — exactly the `archives` object of a Push snapshot, same validation rules as Push (entry shape, culture regex, case-duplicate archive keys, `checkCulture` per culture incl. in-flight job cultures) | `200 { humanEdits }`; `400 { error }` on a malformed body |
| GET | `/api/coverage` | — | `{ pushedAt, findings: CoverageFinding[] }` from the last real Push |
| GET | `/api/export?culture=ru` | — | `{ culture, policy, entries: ExportEntry[] }`; withholds `needs_fix`, `rejected` and empty cells, and any outdated cell (`basedOnSourceRev < unit.sourceRev`); under `approved_only` it withholds `ai_draft` too, so only `approved`, `edited` and `human_edit` cells are ever exported |
| POST | `/api/export/ack` | `{ culture, written: [{unitId, translation}], rejected: [{unitId, translation, errors[]}] }` | `{ ok: true }` |
| GET | `/api/cells?culture=ru` | `band, status, flag, groupKey, outdated=1, q, limit (max 1000), offset` | `{ total, rows: [{unit, cell, outdated, lengthLimit}] }` |
| POST | `/api/cells/:culture/:unitId/approve` | `{ actor?, expectedRevision?, expectedSourceRev?, accept? }` | `{ cell }`; 422 `{error, issues[]}` for a `hard` issue or a `confirm` issue `accept` does not name (Format checks, above); 400 for a malformed `accept`; 404; 409 `stale_cell` (below) |
| POST | `/api/cells/:culture/:unitId/edit` | `{ text, actor?, expectedRevision?, expectedSourceRev?, accept? }` | same |
| POST | `/api/cells/:culture/:unitId/reject` | `{ note?, actor?, expectedRevision?, expectedSourceRev? }` | same; `note` is optional, an empty reject is valid |
| POST | `/api/cells/:culture/:unitId/retranslate` | `{ note, asRule? }` | `{ cell (with suggestion), issues[] }`; 404, 422, 502 |
| GET | `/api/cells/:culture/:unitId/history` | — | `CellEvent[]`; an approve/edit confirmed despite `confirm` issues carries `accepted: string[]` |
| POST | `/api/cells/:culture/:unitId/check` | `{ text }` | `{ issues: PrecheckIssue[] }`; runs exactly the check `approve`/`edit` run (`cells.ts` `checkCell`/`checkTranslation`), so the two can never drift; read-only — no store write, no event, no freshness requirement; 404; 400 `{error:'text is required'}` for a non-string `text` |
| POST | `/api/jobs/estimate` | `{ culture, mode?, groupKey?, groupPrefix?, unitIds? }` | `{ estimate }` — `JobEstimate = { requests, items, strings, inputTokens, outputTokens, usd: number \| null, billing, approximate?, pricesUnset? }`; token counting runs up to 8 groups concurrently and remembers real counts by `requestId` for the life of the service (no repeat `countInputTokens` calls for an already-counted group); a rate-limit/overloaded error that survives the SDK's own retries falls every group not yet counted back to `approxInputTokens` and sets `approximate: true` instead of failing; a provider whose `countInputTokens` is never a real call (OpenAI-compatible, Gemini, Claude Code/subscription) also sets `approximate: true`; 400 `{error:'batch_unavailable'}` for `mode:'batch'` outside Anthropic+API key; 400 `{error:'ai_not_ready', message}` when `auth:'api'`, the provider is not `custom` and the key is unset; 400 `{error:'invalid_scope'}` for an empty/too-long `groupPrefix` or one combined with `groupKey`; 500 if the model API is unreachable — Anthropic with an API key only; every other provider/auth estimates locally and never 500s here |
| POST | `/api/jobs` | `{ culture, maxUsd?, mode? ("sync" or "batch"), groupKey?, groupPrefix?, unitIds?, skipEstimate? }` | 202 `{ jobId, estimate }`; `maxUsd` is required when absent (400 `{error:'culture and maxUsd are required'}`) and enforced (422 `{error:'budget'}`) only when billing is `'api'` and `estimate.usd` is known and nonzero — otherwise (subscription, unpriced model, or a free `usd: 0` scope) it is ignored; a present `maxUsd` that is not a finite positive number is 400 `{error:'invalid_maxUsd'}` before any token counting; `skipEstimate: true` starts the job with zero provider calls before it (no `countInputTokens`) and ignores `maxUsd` entirely (not required, not validated, not enforced) — `estimate` is then computed locally with `approxInputTokens` and carries `approximate: true`; every other gate below still applies; 400 `{error:'batch_unavailable'}` for `mode:'batch'` outside Anthropic+API key; 400 `{error:'ai_not_ready', message}` when `auth:'api'`, the provider is not `custom` and the key is unset; 400 `{error:'invalid_scope'}` for an empty/too-long `groupPrefix` or one combined with `groupKey`; 409 `{ error: 'job_running', jobId? }` (a job for this culture is running or still being estimated; `jobId` is the running job's id, present once its record exists — absent while it is still `starting`, being estimated, with no record yet); 500 if the estimate call fails — Anthropic with an API key only, and never when `skipEstimate` is true; every other provider/auth estimates locally and never 500s here |
| GET | `/api/jobs/:id` | — | `{ id, culture, status ("running", "done", "failed"), startedAt, estimate, report?, error?, progress? }`; 404 `{error:'Unknown job'}`. A running job can later end `status: 'failed'` with `error` set instead of `done`. Job records live only in memory: they are lost on a service restart, so a job that was `running` answers 404 after one. `progress` is `JobProgress` (Jobs section, above), absent until the first progress event and left at its last value once the job ends. |
| GET | `/api/jobs?culture=ru` | — | the newest job record of that culture — running, else the most recently started finished/failed one — same shape as `/api/jobs/:id`; 404 `{error:'Unknown job'}` when the culture has none. Lets a view that lost its job id (e.g. remounted after a tab switch) find the job again. |
| POST | `/api/import` | `{ culture, actor, dryRun, overwriteConflicts, acceptConfirm, previewDigest?, entries: ImportEntry[] }` | `{ rows: ImportRow[], counts, digest }` — see "Translation exchange" below; 400 `{ error }` for a malformed body, a file that names one string twice, or a culture that is not a translation culture of the project; 409 `files_changed_on_disk` on apply; 409 `{ error: 'preview_stale', message, result }` on apply when `previewDigest` no longer matches |
| GET/PUT | `/api/glossary/:culture` | `GlossaryTerm[]` | terms / `{ ok: true }`; PUT 400 unless every term has non-empty string `term`, string `translation`, boolean `dnt`, string `note` (nothing is saved) |
| GET/PUT | `/api/style/:culture` | `{ text }` | `{ text }` / `{ ok: true }` |
| GET | `/api/inbox` | `status, culture` | `{ rows: [{ item: InboxItem, unit: {namespace, key, source, origin, devNotes} \| null }] }` — `unit` is `null` when the item's unit is no longer in the store |
| POST | `/api/inbox` | `{ culture, unitId, question }` | 201 `{ item }` (`askedBy: "reviewer"`); 404 unknown unit; 422 empty question; 400 bad culture (culture guard) or missing field |
| POST | `/api/inbox/:id/answer` | `{ answer }` | `{ item }`; 404, 422 |
| POST | `/api/inbox/:id/dismiss` | — | `{ item }`; 404 |
| POST | `/api/inbox/applied` | `{ ids[] }` | `{ applied }` |
| GET | `/api/summary?culture=ru` | — | `CultureSummary` |
| GET | `/api/bridge/stream` | — | SSE: `event: command` / `data: BridgeCommand`; comment lines `: connected` on open and `: ping` every 15 s |
| POST | `/api/bridge/command` | `{ name, args }`, name is one of `BRIDGE_COMMANDS` | 202 `{delivered}`; 409 `editor_not_connected`; 400 |
| GET | `/`, `/*` | — | the web app from `--web-dir` (`Resources/LocHubWeb`) and, for files it lacks, `--web-deps-dir` (`Source/ThirdParty/LocHubWebDeps`); every file `no-cache`; 503 text when `index.html` is missing |

`lengthLimit` on a `GET /api/cells` row is the unit's Length Check limit in that culture (`number`), or `null` when it has none.

## Translation exchange (`POST /api/import`)

The web app exports CSV and XLIFF 1.2 itself from `GET /api/cells` rows (including `lengthLimit`) and parses the
translators' files itself; the service only takes the work back. The web app sends the parsed entries first with
`dryRun: true` for the preview, then the same request with `dryRun: false`.

Request: `{ culture, actor, dryRun, overwriteConflicts, acceptConfirm, previewDigest?, entries }` with `ImportEntry =
{ unitId?, namespace?, key?, source?, text, approved, exportedRevision?, exportedAt? }` (`contract.ts`). `actor` is
trimmed and cut to 64 characters, and must be non-empty when `dryRun` is false. `exportedRevision` is a whole number
≥ 0. `exportedAt` is a strict ISO 8601 date-time (`YYYY-MM-DDTHH:mm[:ss[.f]]`, where `f` is 1 to 9 fractional digits,
optionally followed by `Z` or a `±HH:MM` offset — a value with no zone marker is read as UTC, never as the service's
own local time; the pattern is `EXPORTED_AT_PATTERN` in `contract.ts`); any other shape is `400 { error }`, and so is
a request that names one string twice. `previewDigest`, when present, must be a string (400 otherwise) — see "Preview
digest" below. The culture goes through the culture guard (400) and must also be one of the project's translation
cultures — the target cultures of the last Push plus any culture that already has cells, minus the native culture,
the same set `/api/meta` lists: the native culture, or one `/api/meta` does not list, is `400 { error: "<culture> is
not a translation culture of this project" }`.

Response: `{ rows, counts, digest }` — one `ImportRow = { index, unitId?, outcome, conflict?, issues?, before?,
after? }` per entry, in order, `counts: Record<ImportOutcome, number>` over all ten outcomes, and `digest` —
`sha256(JSON.stringify(rows))`, first 16 hex characters, identifying this exact preview for the "Preview digest"
apply-time check below. `issues` (the check's `ImportIssue[]`, the shape of `PrecheckIssue`), `before` (the cell's
text) and `after` (the entry's text) are present for every entry that reached rule 5; `conflict: true` marks a
detected conflict even when `overwriteConflicts` let the entry through.

Rules per entry, in order:

1. The unit, by `unitId` when given and it resolves to an active unit; else by `namespace` + `key` — which also
   recovers an entry whose `unitId` a spreadsheet turned into a number (unit ids are 16 hex characters derived from
   `sha256(namespace, key)`; about 1 in 1,800 are all-digit and Excel/Sheets saves those as `1.23457E+15`). An
   explicit `unitId` that resolves to a *different* unit than `namespace` + `key` still wins, unchanged. Neither
   resolves → `unknown`.
2. `source` given and ≠ the unit's source → `stale`.
3. `text` empty after trim → `empty` (an import never clears a translation).
4. Nothing to do — `text` equals the cell's text and the entry approves nothing new → `unchanged`. An entry approves
   something new when it says `approved` and either the cell is not approved yet, or the cell is approved but
   `outdated` and the entry carries its `source` (re-approval, rule 7).
5. Conflict — `exportedRevision` given and ≠ the cell's `revision`; or, with no revision, `exportedAt` given and the
   cell has an event after it (`exported` and `ai_suggestion` events do not count: they leave the cell's text and
   status alone). → `conflict`, unless `overwriteConflicts`.
6. The check Save runs (`checkCell`, the same call as the `/check` route): a `hard` issue → `hard` (never applied); a
   `confirm` issue → `confirm`, unless `acceptConfirm`.
7. An overwritten conflict (rule 5 detected one and `overwriteConflicts` let it through) always lands as `changed`,
   whatever the text or `approved` says — including when the file's text equals the cell's text: the row's approval
   refers to a state of the string LocHub has since changed, so an overwritten conflict never approves. Otherwise: a
   new text (`text` ≠ the cell's text) → `changed_approved` when the row approves **and** the cell was not already
   `approved` at export — otherwise `changed`, whatever `approved` says (an exported `status` column an edited
   translation left untouched never certifies the new text). The same text, approving now and not a conflict, →
   `approved` — including an `approved`-but-`outdated` string re-approved against its current source.

The apply is tied to the exact preview the caller saw. The dry-run response's `digest` identifies that set of rows;
a non-dry-run request may send it back as `previewDigest`. The service always recomputes the rows and their digest
against the store as it is *now* — a job, another tab, a Push, a glossary edit, or a reload after
`files_changed_on_disk` can all have changed it since the preview — and when `previewDigest` is present and differs
from the fresh digest, nothing is written (no cell, no event) and the response is `409 { error: 'preview_stale',
message, result }`, where `result` is that fresh `{ rows, counts, digest }`, ready to show as the new preview.
`previewDigest` is optional and checked only on apply: an apply that omits it works exactly as before, and a dry run
never sees this check.

Applying (`dryRun: false`): `changed` → `edited`; `changed_approved` and `approved` → `approved`;
`basedOnSourceRev`/`basedOnSource` = the unit's current source; `revision` + 1. A new text gets provenance
`human:<actor>` and clears the AI fields like an edit; `approved` keeps the provenance, like Approve. Every exporter
writes the cell's revision unconditionally (`0` for a string that had no translation at export), so rule 5 also
catches a LocHub write made after the export to a string that was empty then. One store save for the whole request —
refused with 409 `files_changed_on_disk` before anything is written when the data files changed on disk, even when
nothing in the request would end up being applied (the same `assertFresh()` gate the other mutating routes use), and
refused with 409 `preview_stale` before anything is written when `previewDigest` no longer matches (above) — then one
`CellEvent` per applied row in a single append: `action: "import"`, the actor, and `accepted` (the confirm codes
`acceptConfirm` let through). A dry run writes nothing.

A save that fails before this culture's cells file is written (the freshness/case-collision check, or `units.jsonl`)
restores every applied cell in memory and writes no event: nothing from this import reaches disk. A save that fails
after that file (another culture's cells, glossary, style, `inbox.jsonl`), or an `appendEvents` failure once the save
itself already succeeded, still answers `500` — but by then this culture's translations are already on disk with no
event recorded for them; the store's multi-file save is not atomic across that wider set.

## Pull protocol (plugin side)

0. `POST /api/reconcile` with `{ archives }` (the current archive translation of every foreign culture, same
   shape and rules as Push's `archives`) for every culture, **before the first `GET /api/export`** of the Pull
   run. This is what makes that guarantee order-independent: without it, a translation edited in the archive
   outside LocHub since the last Push would be silently overwritten by the export that follows, because only
   Push used to check the archive against a human edit.
1. `GET /api/export?culture=X`.
2. Validate every entry with the engine (`FTextFormat::ValidatePattern` on culture X, plural forms, glyphs).
   This plugin-side check is the authoritative one: `GenerateLocRes` itself only logs a Warning when its own
   validation fails and still writes the entry regardless (`TextLocalizationResourceGenerator.cpp:166-241`),
   so an engine cook is not a safety net for a translation the plugin let through.
3. Write the valid ones into the archive, compile `.locres`.
4. `POST /api/export/ack` with the texts actually written and the rejected ids with engine error messages.
   `rejected[].translation` is the text the engine actually rejected; a rejection whose `translation` is no
   longer the cell's current text is ignored (a human edit or a later job has already replaced it).
5. `GET /api/inbox?status=answered`, write each answer into the unit's DevNotes (assets: in the editor; C++: a
   proposed `LOCTEXT` → `NOTELOCTEXT` change for a human), then `POST /api/inbox/applied` with the ids written.

## Push protocol (plugin side)

- Missing units are tombstoned on every real Push (retiring is reversible; the editor confirms it before the real
  Push).
- `archives` carries the current archive translation of every unit, so edits made outside LocHub are detected. It
  carries foreign (non-native) cultures only; the plugin must leave any other archive entry — one for a unit
  LocHub does not track, or for the native culture — untouched.
- Each archive entry's `source` is the English text the translation was made for. Push ignores an entry whose
  `source` differs from the unit's current source (UE keeps a stale foreign archive entry on purpose; that is not
  a decision about the current text) and an entry whose translation equals a text LocHub itself produced earlier
  for this cell (a stale export — the ack was lost, or the archive file was reverted by a source control sync,
  e.g. `git pull`), so neither can resurrect a rejected or superseded translation as a human edit.
- `coverage` carries player-visible strings that bypass localization (`FText::FromString` with a literal, literals in
  `.rml`), each with `kind, file, line, text`.
- `pluralForms` (optional) is `{ "<culture>": { "cardinal": string[], "ordinal": string[] } }` for the native culture
  and every target culture the engine resolves: the CLDR category names (`zero, one, two, few, many, other`) of
  `FCulture::GetValidPluralForms`. Unreal validates plural modifiers against these on Pull, and its ICU (UE 5.8: ICU
  64) can differ from Node's (e.g. Node 22 lists `many` for fr/es/it/pt cardinal, the engine does not), so the
  service's checks and the translate prompt use them. The latest value per culture is kept in memory and persisted
  to `<ProjectDir>/Saved/LocHub/plural_forms.json` (not `Localization/LocHub`, since it describes the running
  engine, not project data), reloaded at service start so the forms survive the restart the editor runs on every
  AI/brief setting change; a culture no Push has reported, or a missing/unreadable persisted file, falls back to
  Node's `Intl.PluralRules`. A malformed
  value (not an object, a bad culture key, keys differing only in case, a missing or empty list, a name outside the
  six categories) is `400 { error }`.
- Use `?dryRun=1` first when the numbers need a human look (for example, a large tombstone count).

## Bridge commands (args)

- `OpenOrigin { unitId, namespace, key, origin }` — open the asset / source location.
- `SetPreviewCulture { culture }` — `FTextLocalizationManager::EnableGameLocalizationPreview`.
- `ApplyLive { culture, entries: [{namespace, key, source, translation}] }` — previews `culture`, then
  `UpdateFromLocalizationResource`. `source` is the current English text: the engine ignores a live entry whose
  source hash differs (`TextLocalizationManager.cpp:1060`).
- Inside the editor tab the web app calls the same commands directly on `window.ue.lochub`
  (`openorigin(origin)`, `setpreviewculture(culture)`, `applylive(culture, entriesJson)`) and never relays them.
