create table if not exists public.wechat_accounts (
  openid_hash text primary key,
  user_id uuid not null unique references auth.users(id) on delete cascade,
  unionid text,
  nickname text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.wechat_accounts enable row level security;

revoke all on table public.wechat_accounts from anon, authenticated;
grant all on table public.wechat_accounts to service_role;

-- This table is accessed only by the wechat-session Edge Function with the
-- service role. No client-side read or write policy is intentional.
