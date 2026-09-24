create table if not exists lecture_transcripts (
  id uuid primary key default gen_random_uuid(),
  resource_id uuid not null unique references resources(id) on delete cascade,
  source text not null default 'youtube',
  language text default 'en',
  transcript text not null,
  fetched_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists ai_study_packs (
  id uuid primary key default gen_random_uuid(),
  resource_id uuid not null unique references resources(id) on delete cascade,
  notes jsonb not null default '{}'::jsonb,
  questions jsonb not null default '[]'::jsonb,
  flashcards jsonb not null default '[]'::jsonb,
  model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists study_activity (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  resource_id uuid references resources(id) on delete set null,
  activity_type text not null check (activity_type in ('lecture_open','lecture_complete','notes_review','quiz_attempt','flashcard_review','tutor_chat','break_game')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists quiz_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  resource_id uuid references resources(id) on delete set null,
  score integer not null default 0,
  total integer not null default 0,
  answers jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists user_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  resource_id uuid references resources(id) on delete cascade,
  body text not null default '',
  updated_at timestamptz not null default now(),
  unique(user_id, resource_id)
);

create table if not exists game_scores (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  game text not null,
  score integer not null default 0,
  duration_seconds integer not null default 60,
  created_at timestamptz not null default now()
);

create index if not exists study_activity_user_created_idx on study_activity(user_id, created_at desc);
create index if not exists study_activity_resource_idx on study_activity(resource_id, created_at desc);
create index if not exists quiz_attempts_user_created_idx on quiz_attempts(user_id, created_at desc);
create index if not exists game_scores_user_created_idx on game_scores(user_id, created_at desc);

alter table app_users enable row level security;
alter table anatomy_topics enable row level security;
alter table resources enable row level security;
alter table payments enable row level security;
alter table lecture_transcripts enable row level security;
alter table ai_study_packs enable row level security;
alter table study_activity enable row level security;
alter table quiz_attempts enable row level security;
alter table user_notes enable row level security;
alter table game_scores enable row level security;