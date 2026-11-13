-- ============================================================================
-- LinkSpace — Organizador de links (Supabase / PostgreSQL 15+)
-- ----------------------------------------------------------------------------
-- Execute este arquivo inteiro no Supabase: Dashboard > SQL Editor > New query.
-- O script é idempotente: pode ser executado mais de uma vez sem duplicar nada.
--
-- MODO DE IMPLANTAÇÃO PADRÃO: "pessoal" (sem login).
--   As políticas de RLS liberam leitura/escrita para a chave `anon`.
--   Leia a seção 9 (SEGURANÇA) antes de publicar o front na internet.
--   O "MODO B" (multiusuário com Supabase Auth) está no final do arquivo.
-- ============================================================================

begin;

create extension if not exists pgcrypto;
create extension if not exists pg_trgm;
create extension if not exists unaccent;

-- ============================================================================
-- 0. UTILITÁRIOS
-- ============================================================================

-- Gera slug estável a partir de um texto ou caminho de pasta.
--   "VÍDEOS SISTEMAS SAUDE" -> "videos-sistemas-saude"
--   "SAUDE/SAMU"            -> "saude-samu"
create or replace function public.slugify(p_text text)
returns text
language sql
stable
as $$
  select trim(both '-' from
    regexp_replace(
      regexp_replace(lower(unaccent(coalesce(p_text, ''))), '[^a-z0-9/]+', '-', 'g'),
      '[/-]+', '-', 'g'
    )
  );
$$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ============================================================================
-- 1. TABELAS
-- ============================================================================

-- 1.1 Categorias (pastas do navegador viram categorias; pastas aninhadas são
--     achatadas em `path` + `parent_id`, mantendo o nome original em `name`).
create table if not exists public.categories (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null unique,
  path        text not null default '',
  parent_id   uuid references public.categories (id) on delete set null,
  color       text,
  position    integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint categories_name_not_blank check (length(btrim(name)) > 0),
  constraint categories_slug_format   check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  constraint categories_name_len      check (length(name) <= 120)
);

-- 1.2 Links. `url` guarda a URL original (como o usuário vê);
--     `url_key` guarda a URL canônica usada para deduplicação (UNIQUE).
create table if not exists public.links (
  id             uuid primary key default gen_random_uuid(),
  category_id    uuid references public.categories (id) on delete set null,
  title          text not null,
  url            text not null,
  url_key        text not null,
  domain         text not null default '',
  description    text,
  tags           text[] not null default '{}'::text[],
  favicon_url    text,
  is_favorite    boolean not null default false,
  position       integer not null default 0,
  source         text not null default 'manual'
                 check (source in ('manual', 'firefox', 'chrome', 'safari', 'generic')),
  external_id    text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  last_opened_at timestamptz,
  constraint links_title_not_blank check (length(btrim(title)) > 0),
  constraint links_url_http        check (url ~* '^https?://'),
  constraint links_url_len         check (length(url) <= 4096),
  constraint links_url_key_not_blank check (length(btrim(url_key)) > 0)
);

-- 1.3 Anotações (editor rico do modal "Anotações").
--     `link_id` permite anotação por link (P1); NULL = anotação geral.
create table if not exists public.notes (
  id           uuid primary key default gen_random_uuid(),
  title        text not null default 'Anotações gerais',
  content_html text not null default '',
  content_text text not null default '',
  link_id      uuid references public.links (id) on delete cascade,
  is_pinned    boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint notes_title_not_blank check (length(btrim(title)) > 0)
);

-- 1.4 Histórico de importações (auditoria + relatório exibido na UI).
create table if not exists public.import_logs (
  id                  uuid primary key default gen_random_uuid(),
  source_file         text,
  format              text not null default 'json',
  mode                text not null default 'merge' check (mode in ('merge', 'replace')),
  total_found         integer not null default 0,
  inserted            integer not null default 0,
  skipped_duplicates  integer not null default 0,
  skipped_invalid     integer not null default 0,
  categories_created  integer not null default 0,
  report              jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now()
);

-- 1.5 Preferências do app (singleton id = 1) — tema, ordenação, etc.
create table if not exists public.app_settings (
  id          smallint primary key default 1 check (id = 1),
  theme       text not null default 'light' check (theme in ('light', 'dark', 'system')),
  sort_mode   text not null default 'created_desc',
  view_mode   text not null default 'grid' check (view_mode in ('grid', 'list')),
  updated_at  timestamptz not null default now()
);

insert into public.app_settings (id) values (1) on conflict (id) do nothing;

-- ============================================================================
-- 2. ÍNDICES
-- ============================================================================

create unique index if not exists links_url_key_uidx   on public.links (url_key);
create index if not exists links_category_idx          on public.links (category_id);
create index if not exists links_created_idx           on public.links (created_at desc);
create index if not exists links_domain_idx            on public.links (domain);
create index if not exists links_tags_gin              on public.links using gin (tags);
create index if not exists links_title_trgm            on public.links using gin (lower(title) gin_trgm_ops);
create index if not exists links_url_trgm              on public.links using gin (lower(url) gin_trgm_ops);
create index if not exists links_external_id_idx       on public.links (external_id) where external_id is not null;
create index if not exists categories_position_idx     on public.categories (position, name);
create index if not exists notes_updated_idx           on public.notes (updated_at desc);
create index if not exists import_logs_created_idx     on public.import_logs (created_at desc);

-- ============================================================================
-- 3. TRIGGERS
-- ============================================================================

drop trigger if exists links_touch_updated_at on public.links;
create trigger links_touch_updated_at
  before update on public.links
  for each row execute function public.set_updated_at();

drop trigger if exists categories_touch_updated_at on public.categories;
create trigger categories_touch_updated_at
  before update on public.categories
  for each row execute function public.set_updated_at();

drop trigger if exists notes_touch_updated_at on public.notes;
create trigger notes_touch_updated_at
  before update on public.notes
  for each row execute function public.set_updated_at();

drop trigger if exists app_settings_touch_updated_at on public.app_settings;
create trigger app_settings_touch_updated_at
  before update on public.app_settings
  for each row execute function public.set_updated_at();

-- ============================================================================
-- 4. VIEWS
-- ============================================================================

-- Contagem de links por categoria (usada na sidebar).
create or replace view public.v_categories
with (security_invoker = true)
as
select
  c.id,
  c.name,
  c.slug,
  c.path,
  c.parent_id,
  c.color,
  c.position,
  c.created_at,
  count(l.id)::int as link_count
from public.categories c
left join public.links l on l.category_id = c.id
group by c.id;

-- Estatísticas gerais (rodapé da sidebar / tela de configurações).
create or replace view public.v_stats
with (security_invoker = true)
as
select
  (select count(*)::int from public.links)              as total_links,
  (select count(*)::int from public.categories)         as total_categories,
  (select count(distinct domain)::int from public.links) as total_domains,
  (select count(*)::int from public.links where is_favorite) as total_favorites,
  (select max(created_at) from public.import_logs)      as last_import_at;

-- ============================================================================
-- 5. IMPORTAÇÃO IDEMPOTENTE (RPC)
-- ----------------------------------------------------------------------------
-- Recebe o payload já normalizado pelo front:
-- {
--   "categories": [{ "name": "SAUDE", "path": "SAUDE", "slug": "saude", "position": 3 }],
--   "links": [{
--     "title": "PEC - Cidadão",
--     "url": "https://esus.altolonga.pi.gov.br/",
--     "url_key": "https://esus.altolonga.pi.gov.br",
--     "domain": "esus.altolonga.pi.gov.br",
--     "category_slug": "saude",
--     "description": null,
--     "tags": [],
--     "favicon_url": null,
--     "source": "firefox",
--     "external_id": "guid-do-navegador",
--     "created_at": "2026-11-13T12:00:00Z"
--   }]
-- }
--
-- Regras:
--   * modo 'merge'   -> adiciona apenas o que ainda não existe (padrão)
--   * modo 'replace' -> apaga links e categorias antes de importar (destrutivo)
--   * duplicados são detectados por url_key (índice UNIQUE)
--   * links inválidos (sem url ou url_key) são contados e ignorados
--   * retorna um relatório JSON e grava em import_logs
-- ============================================================================

create or replace function public.import_links(
  payload   jsonb,
  p_mode    text default 'merge',
  p_source  text default 'import.json'
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_item        jsonb;
  v_link        jsonb;
  v_cat_id      uuid;
  v_cat_slug    text;
  v_rows        integer;
  v_total       integer := 0;
  v_inserted    integer := 0;
  v_dups        integer := 0;
  v_invalid     integer := 0;
  v_cats        integer := 0;
  v_report      jsonb;
  v_log_id      uuid;
begin
  if p_mode not in ('merge', 'replace') then
    raise exception 'p_mode inválido: % (use merge ou replace)', p_mode
      using errcode = '22023';
  end if;

  if payload is null or jsonb_typeof(payload) <> 'object' then
    raise exception 'payload deve ser um objeto JSON' using errcode = '22023';
  end if;

  if p_mode = 'replace' then
    delete from public.links;
    delete from public.categories;
  end if;

  -- 5.1 Categorias -----------------------------------------------------------
  for v_item in
    select value from jsonb_array_elements(coalesce(payload -> 'categories', '[]'::jsonb))
  loop
    continue when coalesce(btrim(v_item ->> 'name'), '') = '';

    insert into public.categories (name, slug, path, position)
    values (
      btrim(v_item ->> 'name'),
      coalesce(
        nullif(btrim(v_item ->> 'slug'), ''),
        public.slugify(coalesce(nullif(btrim(v_item ->> 'path'), ''), v_item ->> 'name'))
      ),
      coalesce(nullif(btrim(v_item ->> 'path'), ''), btrim(v_item ->> 'name')),
      coalesce(nullif(v_item ->> 'position', '')::integer, 0)
    )
    on conflict (slug) do nothing;

    get diagnostics v_rows = row_count;
    v_cats := v_cats + v_rows;
  end loop;

  -- 5.2 Links ----------------------------------------------------------------
  for v_link in
    select value from jsonb_array_elements(coalesce(payload -> 'links', '[]'::jsonb))
  loop
    v_total := v_total + 1;

    if coalesce(btrim(v_link ->> 'url'), '') = ''
       or coalesce(btrim(v_link ->> 'url_key'), '') = '' then
      v_invalid := v_invalid + 1;
      continue;
    end if;

    v_cat_id := null;
    v_cat_slug := nullif(btrim(v_link ->> 'category_slug'), '');
    if v_cat_slug is not null then
      select id into v_cat_id from public.categories where slug = v_cat_slug;
    end if;

    insert into public.links (
      category_id, title, url, url_key, domain, description, tags,
      favicon_url, is_favorite, position, source, external_id, created_at
    )
    values (
      v_cat_id,
      coalesce(
        nullif(btrim(v_link ->> 'title'), ''),
        nullif(v_link ->> 'domain', ''),
        'Sem título'
      ),
      btrim(v_link ->> 'url'),
      btrim(v_link ->> 'url_key'),
      coalesce(nullif(btrim(v_link ->> 'domain'), ''), split_part(v_link ->> 'url_key', '/', 3)),
      nullif(btrim(v_link ->> 'description'), ''),
      coalesce(
        (
          select array_agg(btrim(elem.tag))
          from jsonb_array_elements_text(coalesce(v_link -> 'tags', '[]'::jsonb)) as elem(tag)
          where btrim(elem.tag) <> ''
        ),
        '{}'::text[]
      ),
      nullif(btrim(v_link ->> 'favicon_url'), ''),
      coalesce(nullif(v_link ->> 'is_favorite', '')::boolean, false),
      coalesce(nullif(v_link ->> 'position', '')::integer, 0),
      coalesce(nullif(btrim(v_link ->> 'source'), ''), 'generic'),
      nullif(btrim(v_link ->> 'external_id'), ''),
      coalesce(nullif(v_link ->> 'created_at', '')::timestamptz, now())
    )
    on conflict (url_key) do nothing;

    get diagnostics v_rows = row_count;
    v_inserted := v_inserted + v_rows;
    v_dups := v_dups + (1 - v_rows);
  end loop;

  -- 5.3 Relatório ------------------------------------------------------------
  v_report := jsonb_build_object(
    'mode', p_mode,
    'total', v_total,
    'inserted', v_inserted,
    'duplicates', v_dups,
    'invalid', v_invalid,
    'categories_created', v_cats
  );

  insert into public.import_logs (
    source_file, format, mode, total_found, inserted,
    skipped_duplicates, skipped_invalid, categories_created, report
  )
  values (
    p_source, 'json', p_mode, v_total, v_inserted,
    v_dups, v_invalid, v_cats, v_report
  )
  returning id into v_log_id;

  return v_report || jsonb_build_object('import_log_id', v_log_id);
end;
$$;

-- ============================================================================
-- 6. BUSCA SERVER-SIDE (opcional — P1; o P0 filtra no cliente)
-- ============================================================================

create or replace function public.search_links(p_query text, p_limit integer default 500)
returns setof public.links
language sql
stable
security invoker
set search_path = public
as $$
  select l.*
  from public.links l
  where p_query is null
     or btrim(p_query) = ''
     or l.title ilike '%' || p_query || '%'
     or l.url   ilike '%' || p_query || '%'
     or l.domain ilike '%' || p_query || '%'
  order by l.created_at desc
  limit least(coalesce(p_limit, 500), 2000);
$$;

-- ============================================================================
-- 7. ROW LEVEL SECURITY — MODO A ("pessoal", sem login)
-- ============================================================================

alter table public.categories  enable row level security;
alter table public.links       enable row level security;
alter table public.notes       enable row level security;
alter table public.import_logs enable row level security;
alter table public.app_settings enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['categories', 'links', 'notes', 'import_logs', 'app_settings']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_mode_a_all', t);
    execute format(
      'create policy %I on public.%I for all to anon, authenticated using (true) with check (true)',
      t || '_mode_a_all', t
    );
  end loop;
end;
$$;

-- ============================================================================
-- 8. PERMISSÕES
-- ============================================================================

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.categories, public.links, public.notes,
      public.import_logs, public.app_settings to anon, authenticated;
grant select on public.v_categories, public.v_stats to anon, authenticated;
grant execute on function public.import_links(jsonb, text, text) to anon, authenticated;
grant execute on function public.search_links(text, integer)     to anon, authenticated;
grant execute on function public.slugify(text)                   to anon, authenticated;

commit;

-- ============================================================================
-- 9. SEGURANÇA — LEIA ANTES DE PUBLICAR
-- ----------------------------------------------------------------------------
-- No MODO A a chave `anon` embutida no front permite que QUALQUER pessoa com a
-- URL do site leia e escreva nos seus links. Isso é aceitável apenas para uso
-- pessoal/local. Antes de publicar publicamente, escolha uma das opções:
--
--   (a) MODO B (recomendado): login com Supabase Auth e RLS por usuário.
--       Descomente o bloco 10 e apague as políticas do item 7.
--   (b) Keep-private: mantenha o site em rede local / atrás de Cloudflare
--       Access ou Vercel Password Protection.
--   (c) Rate limiting + monitoramento no painel do Supabase.
--
-- NUNCA use a chave `service_role` no front-end. Apenas `anon` (public).
-- ============================================================================

-- ============================================================================
-- 10. MODO B (multiusuário, opcional) — descomente para ativar
-- ----------------------------------------------------------------------------
-- Requer Supabase Auth habilitado (e-mail/senha ou magic link).
--
-- alter table public.links      add column if not exists user_id uuid default auth.uid() references auth.users (id) on delete cascade;
-- alter table public.categories add column if not exists user_id uuid default auth.uid() references auth.users (id) on delete cascade;
-- alter table public.notes      add column if not exists user_id uuid default auth.uid() references auth.users (id) on delete cascade;
-- alter table public.app_settings add column if not exists user_id uuid default auth.uid() references auth.users (id) on delete cascade;
--
-- drop index if exists links_url_key_uidx;
-- create unique index links_user_url_key_uidx on public.links (user_id, url_key);
-- drop index if exists categories_slug_key;
-- alter table public.categories drop constraint if exists categories_slug_key;
-- create unique index categories_user_slug_uidx on public.categories (user_id, slug);
--
-- -- troque as políticas do item 7 por estas:
-- drop policy if exists links_mode_a_all on public.links;
-- create policy links_own on public.links for all to authenticated
--   using (user_id = auth.uid()) with check (user_id = auth.uid());
-- -- ... repita o padrão para categories, notes, import_logs e app_settings.
--
-- -- o RPC precisa filtrar por usuário; ajuste o corpo de import_links para
-- -- incluir user_id := auth.uid() nos INSERTs e no ON CONFLICT (user_id, url_key).
-- ============================================================================
