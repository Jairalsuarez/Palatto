alter table public.profiles
  add column if not exists must_change_password boolean not null default false;

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  endpoint text not null unique check (length(endpoint) < 4096 and endpoint ~ '^https://'),
  p256dh text not null check (length(p256dh) between 80 and 100),
  auth text not null check (length(auth) between 20 and 30),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon, authenticated;
