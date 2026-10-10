# Aangan Studio — after-hours voice enquiry system

Answers inbound enquiry calls within seconds, day or night, qualifies them against Nikhil's rubric, books consultations on the
designers' real calendar, and hands a ready-to-use summary to the designer. Phone calls only; the data model and pipeline are
channel-agnostic so WhatsApp and web forms can be added later without rework.

```
Caller ─► Vaani (voice agent, rubric + prompt, NO pricing)
            │  tools: qualify / availability / book   (POST /api/voice/tools/*)
            │  webhooks: call started / ended / final  (POST /api/webhooks/vaani)
            ▼
        Next.js on Vercel ── Supabase (calls, leads, qualifications, bookings, audit, costs)
            ├─ rules engine (qualified.md + services.md)  ← decides; the LLM only collects facts
            ├─ Cal.com    real availability + booking
            ├─ Gemini Flash  structured post-call summary (schema-validated)
            ├─ HubSpot    contact + deal (idempotent)
            ├─ Telegram   designer handoff / complaint escalation / alerts
            └─ Dashboard  overview · calls · lead detail · review queue · bookings · analytics · integration health
```

## Quick start (local)

```bash
npm install
cp .env.example .env.local        # fill in what you have; unconfigured integrations are shown as such, never faked
npm run hash-password -- 'a-strong-password'   # paste the output into DASHBOARD_USERS
npm run dev                       # http://localhost:3000
```

* `DEMO_MODE=true` replays the 20 anonymised September phone calls (from the enquiries PDF) through the real pipeline into an
  in-memory store, clearly labelled **DEMO**. It is for evaluation only; never enable it in production.
* Without `SUPABASE_*` the app runs on an ephemeral in-memory store and says so on every page.

Checks: `npm run lint && npm run typecheck && npm test && npm run build` (all pass; 142 tests).

## Deploy (Vercel + Supabase)

1. **Supabase**: create a project → SQL editor → run `supabase/migrations/0001_init.sql`. All tables have RLS enabled with no
   policies (service-role only). Copy the project URL and **service-role** key into `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`.
2. **Vercel**: import the repo, set every variable from `.env.example` (Production), set `APP_BASE_URL` to the deployed URL.
   `vercel.json` registers a **daily** cron on `/api/cron/jobs` (retries failed Telegram/HubSpot jobs; Vercel authenticates it with
   `CRON_SECRET`). Hobby plans only allow daily crons. Messages are still sent immediately after each call; the cron only retries failures. For
   faster retries, upgrade to Pro and use `*/5 * * * *`, or hit the endpoint from an external pinger with the bearer secret.
3. **Dashboard users**: `DASHBOARD_USERS` (JSON). Roles: `owner` (all, incl. costs and integration health) and `designer`
   (leads, review, bookings, internal pricing guidance).
4. Set `ALLOW_UNSIGNED_WEBHOOKS=false` (the default).

## Integration setup

### Vaani Labs
1. Create the agent; paste **`vaani/system-prompt.md`** (or the identical `vaani/voice-context.txt`) as its system prompt. The qualification
   rubric is embedded in Stage 4; nothing else is loaded at runtime. Rebuild the copy after edits: `npm run build:voice-context` (a test fails if stale).
2. Add three HTTP tools, each sending `Authorization: Bearer $VOICE_TOOL_SECRET`: `qualify`, `availability`, `book`
   (bodies are documented at the end of the system prompt; Vaani's per-call id is sent as `call_id`).
3. Point call webhooks (started / ended / final) at `POST {APP_BASE_URL}/api/webhooks/vaani`, signed with `VAANI_WEBHOOK_SECRET`.
4. **Routing** (after-hours → Vaani, staffed hours → front desk): forward the studio number to Vaani only outside
   10:00–19:00 IST, or have the telephony layer call `GET /api/voice/route` (bearer secret) which returns `{route, after_hours}`.
   The call record stores `expected_route` and the actual `handling_mode` (ai / human / none, reported or inferred).

> **Vaani Labs webhook format (from its public OpenAPI spec, vaanilabs.in/openapi/v1/vaanivoice.yaml):** envelope `{id: "evt_…", type, created, data}`,
> events `call.completed`, `call.failed` (plus `lead.created`, `usage.charged`, `meeting.ended`, `webhook.ping`, which the app acknowledges and
> ignores), signed with `X-VaaniVoice-Signature: sha256=<hex HMAC-SHA256 of the raw body>` using the `vv_whk_…` secret shown at registration
> (put it in `VAANI_WEBHOOK_SECRET`). Vaani retries up to 8 times and **auto-disables a webhook after 5 consecutive non-2xx responses**, so the app
> returns 2xx for every documented event. Caller numbers are **masked** in webhooks, so leads cannot be merged by phone number for Vaani calls.
>
> ⚠️ **Still unverified:** the spec defines no `data` fields for call events and documents no custom HTTP tools / function calling, so (a) the field
> names inside `data` are matched by best-guess aliases in `src/domain/webhooks/vaani-adapter.ts`, and (b) whether Vaani Labs can call the `qualify` /
> `availability` / `book` tools mid-call must be confirmed with Vaani. Capture one real `call.completed` payload and adjust only that adapter.

### Cal.com
Create an event type "Design consultation" (hosts = designers, round-robin/collective as you prefer). Set `CAL_API_KEY`,
`CAL_EVENT_TYPE_ID`. Verified against the current docs: `POST /v2/bookings` with `cal-api-version: 2026-02-25`, attendee
`email` optional. Slots use `GET /v2/slots` (`2024-09-04`); override versions via env if Cal.com changes them. A booking is
**confirmed only when Cal.com returns status `accepted`**.

### Gemini Flash (optional)
Set `GEMINI_API_KEY` (and `GEMINI_MODEL`, default `gemini-2.5-flash` — confirm the current Flash model id). Output is validated against a
strict schema; on failure a labelled deterministic summary is stored and a retry job is queued. Add
`GEMINI_INPUT_RATE_PER_M` / `GEMINI_OUTPUT_RATE_PER_M` to turn token usage into an *estimated* cost.

### HubSpot
Private-app token (contacts + deals read/write), `HUBSPOT_PIPELINE_ID`, `HUBSPOT_DEAL_STAGE_ID`. Policy
`HUBSPOT_REVIEW_POLICY=require_approval` (default): GREEN leads sync automatically; AMBER only after a designer approves;
RED, INCOMPLETE and complaints never sync. One contact (matched by phone) and one deal per lead.

### Telegram
Bot token, `TELEGRAM_DESIGNER_CHAT_ID` (handoffs, missed-call alerts) and `TELEGRAM_ESCALATION_CHAT_ID` (the designated
owner for existing-client complaints — there is deliberately no silent fallback to the designer chat).

## How qualification works

`vaani/system-prompt.md` Stage 4 is the rubric the voice agent sees; `rubric.txt` is a reference copy (not loaded at runtime); `src/domain/qualification/rules.ts` is the same policy as code. The voice
agent reports **facts**; the server decides and tells the agent what to say (`ask_question`, `proceed_to_booking`,
`close_gracefully`, `human_callback`, `escalate_urgent`).

| Outcome | When |
|---|---|
| `GREEN_QUALIFIED` | No criterion fails or is unclear (criterion 4 with no volunteered budget is `not_assessed`; unknown decision-maker is noted, per `qualified.md`) |
| `RED_NOT_QUALIFIED` | A criterion clearly fails: advice-only/DIY, out of Pune/PCMC, out-of-scope space (restaurant/hotel/retail/gym), needed in < 6 weeks, or a *volunteered* budget clearly below any project |
| `AMBER_REVIEW` | Anything unclear that the rubric doesn't settle → **human review, never auto-reject** |
| `URGENT_ESCALATION` | Existing client complaining about a current project (never a sales enquiry) |
| `INCOMPLETE` | Missed / dropped / failed call without enough information → callback task |

Only `GREEN` (or a human-approved lead) can enter automatic booking; the check is enforced server-side in the tool endpoints.
Every override requires a written reason, is stored as its own row (the system decision is never erased) and audited.

### Decisions I made where the sources are silent or ambiguous (please confirm)
These are in code as named constants and flagged in the UI/evidence — none is silently invented:

1. **Small commercial space (T18, 180 sq ft).** The front desk said "typically 500 sq ft or more", but `services.md` has no minimum.
   Result: **AMBER**, with the reason shown. Not auto-declined.
2. **Timeline.** `services.md`: cannot start if needed in < 6 weeks → fail. `qualified.md`: site available within 8–10 weeks.
   6–8 weeks is genuinely borderline → **AMBER**. ≥ 8 weeks → pass. "No deadline / no rush" → pass.
3. **Caller researching for relatives (T14).** "Not sufficient on its own" but not a stated disqualifier → **AMBER**.
   Unknown decision-maker → qualified with a note (explicit in `qualified.md`).
4. **Budget "clearly below".** Only the example (a full flat) is given. The server tests a *volunteered* figure against the
   smallest all-in project value in the internal pricing guide (single-room redesign) — `BUDGET_FLOOR_INR`, a boolean test that
   never reaches callers. A figure above it is never challenged.
5. **Locality not on the list** but city is Pune (e.g. Kharadi, Nanded City): in area ("and adjoining areas"). Unrecognised
   place, no city → unknown → AMBER.
6. **Staffed days.** Hours are 10–19; days aren't stated. Default Mon–Sat (calls were answered on Saturdays in September).
   `HUMAN_DAYS` is configurable. Note: two September calls were answered by the front desk *before* 10:00 (T07 at 9:44, T20 at 9:15) — the real
   hours may be looser than stated.
7. **After-hours callback promise.** The component map says "else call back in 1 hr". The agent says "within the hour"
   (`CALLBACK_PROMISE_TEXT`) — make sure someone can honour that overnight, or change the wording.
8. **Interpreting T10** (budget "1 to 1.5 lakh" for kitchen + one bedroom): RED per `qualified.md` §4. Note the front desk
   *echoed that figure back* in the transcript; the pricing audit flags this as a possible breach (it is a studio-side turn
   containing a price figure). Worth a coaching conversation.

## Pricing isolation (hard rule)

* The numeric rate tables exist only in `src/internal/pricing-guidance.ts` (`server-only`), rendered only on the authenticated
  lead page under a dashed "Internal guidance — not a quote" banner.
* The system prompt (with its embedded rubric), `voice-context.txt` and `rubric.txt` contain no price figures. The one approved pricing sentence is
  hard-coded and tested verbatim.
* Every voice-tool response is passed through `assertNoPriceDeep` before leaving the server.
* Tests enforce: no import of `src/internal` outside the dashboard; none from voice, API, provider, booking or notification code.
* Post-call audit: any studio-side (agent or human) turn matching a price pattern flags the call, writes an audit entry and
  alerts Telegram. The live model can't be intercepted mid-sentence, so this is detection, backed by the prompt and by the agent
  never having the data to leak.

## Failure handling

* **Webhooks**: unique `(provider, event_id)`; no event id → body hash. Duplicates return 200 with no side-effects; a failed attempt
  returns 500 and is re-claimed on retry; out-of-order events never regress a call.
* **Side-effects** (Telegram, HubSpot, summary retry) go through a keyed outbox: one job per key, compare-and-set claiming,
  exponential backoff, `blocked` (not lost) when config is missing, `dead` + audit entry after `MAX_JOB_ATTEMPTS`.
* **Booking**: one active booking per lead (unique `active_key`); slot must be one this call was offered; caller confirmation
  required; a *timeout* leaves the booking `pending` with a verify task and is **never retried blindly** (could double-book);
  a definitive failure frees the lead and creates a follow-up task.
* **Costs**: `measured` (provider-reported) / `estimated` (your configured rate × usage) / `unknown` (NULL — never 0).
  Currencies are never mixed; ratios show "n/a" without data. No revenue or conversion is shown: no CRM outcomes are ingested.

## Acceptance tests → where they are covered

| # | Requirement | Test |
|---|---|---|
| 1 | After-hours → Vaani; staffed hours → front desk | `webhooks.test.ts` (routing), `pipeline.test.ts` |
| 2–3 | Pricing never quoted; asking never disqualifies | `pricing-isolation.test.ts`, `qualification.test.ts` |
| 4 | Advice-only / out-of-area per rubric | `qualification.test.ts` (+ real calls T03, T04, T19) |
| 5 | No budget question, no budget-based rejection | `qualification.test.ts` |
| 6 | Existing-project complaint → urgent escalation | `qualification.test.ts`, `integrations.test.ts`, `pipeline.test.ts` (T09) |
| 7–8 | Only real slots; confirm only after provider confirms | `booking.test.ts` |
| 9 | Duplicate webhooks create nothing twice | `webhooks.test.ts`, `integrations.test.ts` |
| 10 | Uncertain leads in review queue | `review.test.ts`, `pipeline.test.ts` |
| 11 | Pricing never in caller-facing APIs or voice context | `pricing-isolation.test.ts` |
| 12 | No fabricated cost/conversion values | `pipeline.test.ts` |
| 13 | Integration failures recorded and visible | `integrations.test.ts` |
| 14 | Tests + production build pass | `npm test`, `npm run build` |

## Ported from the team's other repo (Abhi908-Y/aangan-Degine-Stideo)

* **`lookup_caller` tool** (`POST /api/voice/tools/lookup-caller`): called at the start of every call. Recognises a number seen in the last 60 days and
  returns today's date (the agent has no clock), the first name, any booking, and `already_collected` project facts so nothing is asked twice.
  Privacy: caller ID can be spoofed, so it never returns phone, email, budget or earlier concerns, drops any text that looks like a price, and an
  earlier complaint returns no details. Caveat: Vaani masks numbers in webhooks, so matching only works if the agent passes the real number.
* **Overdue sweep** (`/api/cron/jobs`): any open follow-up task past its due time nudges the designer chat and the owner chat on Telegram, at most
  once per 12 hours per task. Review-needed leads now get a 24-hour deadline (`REVIEW_SLA_HOURS`). Call it **hourly** from cron-job.org with
  `Authorization: Bearer $CRON_SECRET`; `vercel.json` keeps a daily fallback (Vercel Hobby limit).
* **One-designer mode** (`ASSIGN_ALL_TO_DESIGNER=<name>`): every task and handoff is assigned to that designer; complaints still go to the studio head.
* **Call simulator**: `npm run simulate -- tests/calls/t01-book.json [baseUrl]` plays lookup → qualify → availability → book → signed webhook against a
  running server and checks the result. Seven scenarios in `tests/calls/` (they are also unit-tested against the rules).
* **Not ported:** the auto-decline text message (we have no SMS provider; messaging channels were out of scope), their budget question (conflicts with
  the brief) and their mock calendar / Neon database.

## What has and hasn't been verified

* ✅ 142 automated tests, lint, type-check, production build; dashboard exercised in a browser (desktop and mobile width);
  live HTTP endpoints exercised with curl (auth, signatures, idempotency, qualify flow, calendar-unconfigured path).
* ⚠️ **No real provider was called** (no Vaani, Cal.com, Gemini, HubSpot, Telegram or Supabase credentials were available).
  Provider clients are tested against mocked HTTP. Cal.com booking was checked against its published docs; Vaani's was not
  (see above); the Gemini model id, HubSpot association id and Supabase adapter should be smoke-tested once credentials exist.
* ⚠️ Login throttling is in-memory (per server instance). Put Vercel WAF/rate-limiting in front for production.

## Layout

```
rubric.txt (reference)  vaani/{system-prompt.md (embeds rubric),voice-context.txt}  supabase/migrations/0001_init.sql  .env.example
src/domain/       qualification/ (schema, areas, rules, service) · webhooks/ · booking · finalize · jobs · review · metrics · health · costs
src/providers/    calcom · gemini · hubspot · telegram
src/voice/        tool endpoints' logic + shared route wrapper (never imports internal pricing)
src/internal/     pricing-guidance.ts  (server-only, dashboard-only)
src/app/          (dashboard)/… · login · api/{webhooks,voice,cron,health}
src/demo/         the 20 September calls as fixtures (tests + DEMO_MODE)
tests/            qualification · pricing-isolation · webhooks · booking · review · integrations · pipeline
sources/          qualified.md · services.md · enquiries PDF (pricing.md intentionally NOT copied here)
```
