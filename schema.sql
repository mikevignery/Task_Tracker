-- Task Tracker schema for Supabase (Postgres)
-- Run this whole file once in Supabase > SQL Editor > New query > Run.
-- Hierarchy:  projects -> tasks -> task_notes
--                               -> work_logs -> work_log_notes
-- A task may exist without a project (project_id is nullable) so nothing is
-- ever forced into a project you did not create.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Helper: keep updated_at fresh
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table if not exists public.projects (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name        text not null check (length(btrim(name)) > 0),
  description text,
  status      text not null default 'active' check (status in ('active','on_hold','done','archived')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.tasks (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  project_id  uuid references public.projects(id) on delete set null,
  title       text not null check (length(btrim(title)) > 0),
  description text,
  status      text not null default 'todo' check (status in ('todo','in_progress','blocked','done')),
  priority    text not null default 'medium' check (priority in ('low','medium','high')),
  due_date    date,
  source      text not null default 'manual',   -- 'manual' or 'transcript'
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.task_notes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  task_id    uuid not null references public.tasks(id) on delete cascade,
  body       text not null check (length(btrim(body)) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A work log is one sitting of work on a task. Time is either typed in
-- (minutes) or built up with the timer (timer_started_at is set while running).
create table if not exists public.work_logs (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() references auth.users(id) on delete cascade,
  task_id          uuid not null references public.tasks(id) on delete cascade,
  work_date        date not null default current_date,
  minutes          integer not null default 0 check (minutes >= 0),
  summary          text,
  timer_started_at timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Only one running timer per user at a time.
create unique index if not exists work_logs_one_running_timer
  on public.work_logs (user_id) where timer_started_at is not null;

create table if not exists public.work_log_notes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  work_log_id uuid not null references public.work_logs(id) on delete cascade,
  body        text not null check (length(btrim(body)) > 0),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
create index if not exists tasks_user_project_idx   on public.tasks (user_id, project_id);
create index if not exists tasks_user_status_idx    on public.tasks (user_id, status);
create index if not exists task_notes_task_idx      on public.task_notes (task_id);
create index if not exists work_logs_task_idx       on public.work_logs (task_id);
create index if not exists work_log_notes_log_idx   on public.work_log_notes (work_log_id);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['projects','tasks','task_notes','work_logs','work_log_notes'] loop
    execute format('drop trigger if exists %I_updated_at on public.%I', t, t);
    execute format('create trigger %I_updated_at before update on public.%I
                    for each row execute function public.set_updated_at()', t, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Row Level Security  (THIS IS WHAT PROTECTS YOUR DATA - do not skip)
-- The anon key in the website is public by design. RLS is what stops anyone
-- with that key from reading or writing rows. Every policy below requires the
-- row to belong to the signed-in user, and child rows must point at a parent
-- that also belongs to that user.
-- ---------------------------------------------------------------------------
alter table public.projects       enable row level security;
alter table public.tasks          enable row level security;
alter table public.task_notes     enable row level security;
alter table public.work_logs      enable row level security;
alter table public.work_log_notes enable row level security;

drop policy if exists projects_own on public.projects;
create policy projects_own on public.projects
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists tasks_own on public.tasks;
create policy tasks_own on public.tasks
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and (project_id is null or exists (
          select 1 from public.projects p
          where p.id = project_id and p.user_id = (select auth.uid())))
  );

drop policy if exists task_notes_own on public.task_notes;
create policy task_notes_own on public.task_notes
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and exists (select 1 from public.tasks t
                where t.id = task_id and t.user_id = (select auth.uid()))
  );

drop policy if exists work_logs_own on public.work_logs;
create policy work_logs_own on public.work_logs
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and exists (select 1 from public.tasks t
                where t.id = task_id and t.user_id = (select auth.uid()))
  );

drop policy if exists work_log_notes_own on public.work_log_notes;
create policy work_log_notes_own on public.work_log_notes
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and exists (select 1 from public.work_logs w
                where w.id = work_log_id and w.user_id = (select auth.uid()))
  );

-- Nothing is granted to the anonymous (logged-out) role.
revoke all on public.projects, public.tasks, public.task_notes,
              public.work_logs, public.work_log_notes from anon;
grant select, insert, update, delete on public.projects, public.tasks,
      public.task_notes, public.work_logs, public.work_log_notes to authenticated;

-- ---------------------------------------------------------------------------
-- OPTIONAL but recommended: after you create your own account, turn off new
-- sign-ups (Authentication > Sign In / Providers > "Allow new users to sign
-- up" = off) so nobody else can register against your database.
-- ---------------------------------------------------------------------------
