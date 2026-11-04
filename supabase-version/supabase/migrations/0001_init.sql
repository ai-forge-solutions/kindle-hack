-- Subrayados: libros, subrayados y estado de repaso por persona.
-- Cada fila pertenece a un usuario de Supabase Auth y solo él puede leerla o cambiarla (RLS).

create extension if not exists pgcrypto;

create table if not exists public.books (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  source         text not null check (source in ('kindle', 'clippings')),
  -- 'asin:<ASIN>' para libros del Notebook de Kindle, 'clip:<hash>' para My Clippings.txt
  source_key     text not null,
  asin           text,
  title          text not null,
  author         text,
  cover_url      text,
  -- Fecha del último subrayado tal como la muestra el Notebook; sirve para saber si hay que releer el libro
  last_annotated text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (user_id, source_key)
);

create table if not exists public.highlights (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  book_id        uuid not null references public.books(id) on delete cascade,
  -- 'kindle:<id de Amazon>' o 'clip:<hash>'
  external_id    text not null,
  text           text not null default '',
  -- Nota escrita en el Kindle (la sincronización la sobrescribe)
  kindle_note    text,
  -- Nota escrita en la app (la sincronización nunca la toca)
  note           text,
  location       integer,
  page           text,
  color          text,
  highlighted_at timestamptz,
  is_note        boolean not null default false,
  -- Estado de repaso (solo lo cambia la app)
  fav            boolean not null default false,
  discarded      boolean not null default false,
  due            date,
  interval_days  integer not null default 0,
  reviews        integer not null default 0,
  last_reviewed  date,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (user_id, external_id)
);

create index if not exists highlights_user_book_idx on public.highlights (user_id, book_id);
create index if not exists highlights_user_due_idx on public.highlights (user_id, due);
create index if not exists highlights_book_idx on public.highlights (book_id);

create table if not exists public.review_settings (
  user_id     uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  daily_count integer not null default 10,
  streak      integer not null default 0,
  last_done   date,
  session     jsonb,
  updated_at  timestamptz not null default now()
);

create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists books_touch on public.books;
create trigger books_touch before update on public.books for each row execute function public.touch_updated_at();
drop trigger if exists highlights_touch on public.highlights;
create trigger highlights_touch before update on public.highlights for each row execute function public.touch_updated_at();
drop trigger if exists review_settings_touch on public.review_settings;
create trigger review_settings_touch before update on public.review_settings for each row execute function public.touch_updated_at();

alter table public.books enable row level security;
alter table public.highlights enable row level security;
alter table public.review_settings enable row level security;

drop policy if exists "own books" on public.books;
create policy "own books" on public.books for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "own highlights" on public.highlights;
create policy "own highlights" on public.highlights for all to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.books b where b.id = book_id and b.user_id = (select auth.uid()))
  );

drop policy if exists "own settings" on public.review_settings;
create policy "own settings" on public.review_settings for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

grant select, insert, update, delete on public.books, public.highlights, public.review_settings to authenticated;
