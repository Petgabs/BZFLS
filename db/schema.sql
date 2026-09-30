-- ---------------------------------------------------------------------------
-- BZFLS-SchoolCloud counter storage (Supabase / Postgres).
--
-- Run this once in the Supabase SQL editor. It replaces the anonymous Abacus
-- counter with a durable, backed-up table that we own.
--
-- Security model: the browser only ever holds the public anon key. Row-level
-- security lets that key READ counters and call increment_counter(), but not
-- write arbitrary values, delete rows, or create keys outside the expected
-- shape.
-- ---------------------------------------------------------------------------

create table if not exists public.counters (
  key         text primary key,
  value       bigint      not null default 0 check (value >= 0),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.counters is
  'Visit and per-file download counters for the public library.';

-- Atomic increment. SECURITY DEFINER so the anon role can bump a counter
-- without holding direct INSERT/UPDATE rights on the table.
create or replace function public.increment_counter(counter_key text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  next_value bigint;
begin
  -- Reject anything that is not a plausible counter key so the anon role
  -- cannot fill the table with junk rows.
  if counter_key is null
     or length(counter_key) = 0
     or length(counter_key) > 80
     or counter_key !~ '^[a-z0-9][a-z0-9-]*$' then
    raise exception 'Invalid counter key';
  end if;

  insert into public.counters as c (key, value)
       values (counter_key, 1)
  on conflict (key) do update
          set value = c.value + 1,
              updated_at = now()
    returning c.value into next_value;

  return next_value;
end;
$$;

comment on function public.increment_counter(text) is
  'Atomically increments a counter and returns its new value.';

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table public.counters enable row level security;

-- Anyone may read the totals; they are displayed publicly on the site.
drop policy if exists "counters are publicly readable" on public.counters;
create policy "counters are publicly readable"
  on public.counters
  for select
  to anon, authenticated
  using (true);

-- No direct write policy is defined on purpose: all writes must go through
-- increment_counter(), which validates the key and can only add one.

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

grant usage on schema public to anon, authenticated;
grant select on public.counters to anon, authenticated;
grant execute on function public.increment_counter(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Optional: seed the visit counter so the first page view reads 0, not null.
-- ---------------------------------------------------------------------------

insert into public.counters (key, value)
     values ('site-visits', 0)
on conflict (key) do nothing;
