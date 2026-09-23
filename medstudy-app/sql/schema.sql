create extension if not exists pgcrypto;

create table if not exists app_users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  phone text unique,
  password_hash text not null,
  role text not null default 'student' check (role in ('student','developer')),
  subscription_status text not null default 'locked' check (subscription_status in ('locked','pending','active')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (email is not null or phone is not null)
);

create table if not exists anatomy_topics (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  group_name text not null default 'General anatomy',
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists resources (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('video','slides','reference')),
  title text not null,
  subject text not null,
  topic text not null,
  url text,
  page text,
  created_by uuid references app_users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  amount integer not null default 600,
  payment_number text not null,
  mpesa_code text not null unique,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at timestamptz not null default now(),
  verified_at timestamptz,
  verified_by uuid references app_users(id) on delete set null
);

create unique index if not exists resources_url_unique_idx on resources(url) where url is not null;
create index if not exists resources_subject_topic_idx on resources(subject, topic);
create index if not exists payments_status_idx on payments(status);

insert into anatomy_topics (name, group_name, sort_order) values
('Anatomy foundations & terminology','Foundations',10),
('Upper limb','Regional anatomy',20),
('Lower limb','Regional anatomy',30),
('Back & vertebral column','Regional anatomy',40),
('Thorax & mediastinum','Regional anatomy',50),
('Abdomen & pelvis','Regional anatomy',60),
('Head, neck & face','Regional anatomy',70),
('Neuroanatomy','Neuroanatomy',80),
('Cardiovascular anatomy','Systemic anatomy',90),
('Digestive anatomy','Systemic anatomy',100),
('Lymphatic anatomy','Systemic anatomy',110),
('Histology','Microscopic anatomy',120),
('Embryology','Developmental anatomy',130)
on conflict (name) do nothing;

insert into resources (kind,title,subject,topic,url,page) values
('video','Embryology lecture playlist','Anatomy','Embryology','https://youtube.com/playlist?list=PLcwW9ZjoDYopncM1GqcnFXG_UBu5u1522','Curated playlist'),
('video','Head, neck and face anatomy lecture playlist','Anatomy','Head, neck & face','https://youtube.com/playlist?list=PLcwW9ZjoDYooSI1yLqYnhNd_xM9pTEuGy','Curated playlist'),
('video','Overview of lower limb anatomy','Anatomy','Lower limb','https://youtu.be/DJDpu4MLV8Q?si=rNVgq2fYUrqbNz4_','Curated video'),
('video','Posterior thigh and popliteal fossa anatomy','Anatomy','Lower limb','https://youtu.be/2ksO2qPYjqQ?si=DF25h5rssGyIuqjn','Curated video'),
('video','Topographic anatomy of the thigh','Anatomy','Lower limb','https://youtu.be/XqcG4dV3so4?si=TXWzBD3V3EuRz700','Curated video'),
('video','Gluteal region: topographic anatomy','Anatomy','Lower limb','https://youtu.be/VJ3W3Wh_ezE?si=LFpp2YswhRp_PDuG','Curated video'),
('video','Basic anatomy of the heart','Anatomy','Cardiovascular anatomy','https://youtu.be/I239yH1i0T8?si=JgW2VtuDQ6XJ-neS','Curated video'),
('video','Anatomy of the skeletal system','Anatomy','Anatomy foundations & terminology','https://youtu.be/Qrka3Lcebxo?si=t5eNkFpPVicZ_nKf','Curated video'),
('video','Cells, tissues and organs of the lymphatic system','Anatomy','Lymphatic anatomy','https://youtu.be/jqbGpRur6EM?si=dbJQYfk0TrKLnFfp','Curated video'),
('video','Propulsion tissue organisation','Anatomy','Histology','https://youtu.be/h5n3nELm_8M?si=3ST-jVNDbFR8_p8S','Curated video'),
('video','Second week of human embryonic development','Anatomy','Embryology','https://youtu.be/aKpscU7jTOI?si=ThYrSSnAyhfzWmKR','Curated video'),
('video','Digestive system: organisation and upper gastrointestinal tract','Anatomy','Digestive anatomy','https://youtu.be/6cNu_Hq-dA4?si=-4NmS9j3iQW0QB-o','Curated video'),
('video','Fertilisation and its results','Anatomy','Embryology','https://youtu.be/HGyKB5JyvVI?si=gDf8H3Q3hAQhWhlA','Curated video')
on conflict do nothing;