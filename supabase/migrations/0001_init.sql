-- Aangan voice enquiry system: schema. Apply with `supabase db push` or the SQL editor.
-- All tables are server-only: RLS is enabled with NO policies, so only the service-role key can read/write.

create extension if not exists pgcrypto;

create table leads (
  id uuid primary key default gen_random_uuid(),
  phone_e164 text unique,
  name text,
  email text,
  system_outcome text,
  effective_outcome text,
  review_status text not null default 'none',   -- none | pending | approved | kept | declined
  flags jsonb not null default '[]',
  hubspot_contact_id text,
  hubspot_deal_id text,
  last_call_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table calls (
  id uuid primary key default gen_random_uuid(),
  provider_call_id text unique not null,
  lead_id uuid references leads(id),
  source text not null default 'vaani',          -- vaani | demo
  direction text,
  from_number text,
  to_number text,
  started_at timestamptz,
  answered_at timestamptz,
  ended_at timestamptz,
  duration_seconds integer,
  handling_mode text,                            -- ai | human | none
  handling_mode_source text,                     -- reported | inferred
  expected_route text,                           -- front_desk | vaani
  after_hours boolean,
  status text not null default 'in_progress',    -- in_progress | completed | missed | disconnected | failed
  end_reason text,
  transcript jsonb,
  first_response_at timestamptz,
  response_seconds integer,
  response_basis text,                           -- answered | callback | none
  system_outcome text,
  effective_outcome text,
  extracted jsonb,
  evaluation jsonb,
  summary jsonb,
  summary_source text,                           -- gemini | deterministic_fallback
  asked_criteria jsonb not null default '[]',
  pricing_violation boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index calls_lead_idx on calls(lead_id);
create index calls_started_idx on calls(started_at desc);

create table qualifications (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references calls(id),
  lead_id uuid references leads(id),
  source text not null,                          -- live_tool | final_payload | gemini | merged
  input_hash text not null,
  outcome text not null,
  evaluation jsonb not null,
  fields jsonb not null,
  rubric_version text not null,
  created_at timestamptz not null default now(),
  unique (call_id, input_hash)
);

create table overrides (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id),
  call_id uuid references calls(id),
  action text not null,                          -- approve | keep | decline | reclassify
  from_outcome text,
  to_outcome text,
  reason text not null,
  actor text not null,
  created_at timestamptz not null default now()
);

create table offered_slots (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references calls(id),
  start_at timestamptz not null,
  end_at timestamptz not null,
  timezone text not null,
  designer text,
  offered_at timestamptz not null default now()
);

create table bookings (
  id uuid primary key default gen_random_uuid(),
  call_id uuid references calls(id),
  lead_id uuid not null references leads(id),
  -- Equals lead_id while the booking is active (requested/pending/confirmed), NULL otherwise.
  -- The unique constraint prevents two active bookings for one lead (duplicate-booking guard).
  active_key text unique,
  provider text not null default 'cal.com',
  provider_booking_uid text,
  status text not null,                          -- requested | pending | confirmed | failed | cancelled | rescheduled
  designer text,
  start_at timestamptz,
  end_at timestamptz,
  timezone text,
  attendee_email text,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table followup_tasks (
  id uuid primary key default gen_random_uuid(),
  dedupe_key text unique not null,
  lead_id uuid references leads(id),
  call_id uuid references calls(id),
  kind text not null,                            -- callback | booking_followup | review | complaint_callback | verify_booking
  due_at timestamptz,
  status text not null default 'open',           -- open | done | cancelled
  assignee text,
  notes text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

-- Outbox for side effects (Telegram, HubSpot, summary retries). `key` makes each effect idempotent.
create table jobs (
  id uuid primary key default gen_random_uuid(),
  key text unique not null,
  kind text not null,                            -- telegram_handoff | telegram_alert | hubspot_sync | summary_retry
  payload jsonb not null default '{}',
  status text not null default 'pending',        -- pending | processing | sent | blocked | dead
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  provider_ref text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create table webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  event_id text not null,
  event_type text,
  status text not null default 'received',       -- received | processing | processed | failed | rejected
  signature_valid boolean,
  payload jsonb,
  error text,
  attempts integer not null default 0,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (provider, event_id)
);

create table audit_logs (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  actor text not null,
  actor_type text not null,                      -- user | system | provider
  action text not null,
  entity_type text not null,
  entity_id text,
  before jsonb,
  after jsonb,
  reason text
);
create index audit_entity_idx on audit_logs(entity_type, entity_id);

-- basis: measured (provider-reported) | estimated (our rate × usage) | unknown (amount is NULL, never 0)
create table cost_events (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references calls(id),
  provider text not null,
  kind text not null,
  amount numeric,
  currency text,
  basis text not null,
  units jsonb,
  created_at timestamptz not null default now(),
  unique (call_id, provider, kind)
);

create table integration_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  ok boolean not null,
  operation text,
  detail text,
  at timestamptz not null default now()
);
create index integration_events_idx on integration_events(provider, at desc);

do $$
declare t text;
begin
  for t in select unnest(array['leads','calls','qualifications','overrides','offered_slots','bookings','followup_tasks','jobs','webhook_events','audit_logs','cost_events','integration_events'])
  loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;
