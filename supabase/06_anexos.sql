-- =====================================================================
-- Gestão de Projetos · Etapa 6 · Anexos nos cartões (imagens e PDF)
-- ---------------------------------------------------------------------
-- Por quê: cada cartão passa a guardar prints, fotos e PDFs que todos
-- os membros do projeto podem abrir ou baixar.
--
-- Os arquivos ficam no Storage do Supabase (depósito de arquivos), num
-- depósito PRIVADO chamado "anexos": nada é público na internet. Cada
-- arquivo fica na pasta do projeto ("<id do quadro>/<id do cartão>/..."),
-- e as regras abaixo usam essa pasta para decidir quem pode acessar:
--   - quem vê o projeto vê e baixa os anexos;
--   - Membro, Gestor e Admin enviam e excluem; Leitor só visualiza.
-- A ficha de cada anexo (nome, tipo, tamanho, autor, data) fica na
-- tabela card_attachments, e a auditoria registra inclusões e exclusões.
--
-- Limites: imagens (PNG, JPG, WEBP, GIF) e PDF, até 5 MB por arquivo.
-- Atenção: o backup automático (backup-supabase.yml) copia o banco,
-- mas NÃO os arquivos do Storage.
--
-- Como usar: Supabase > SQL Editor > New query > cole tudo > Run.
-- Rode ANTES de publicar as telas novas. Pode rodar mais de uma vez sem problema.
-- =====================================================================

begin;

-- 1. Depósito de arquivos privado, com tamanho e tipos limitados pelo próprio Supabase.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('anexos', 'anexos', false, 5242880,
        array['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- 2. Ficha de cada anexo.
create table if not exists public.card_attachments (
  id         uuid primary key default gen_random_uuid(),
  card_id    bigint not null references public.cards(id) on delete cascade,
  board_id   bigint not null references public.boards(id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 150),
  mime       text not null check (mime in ('image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf')),
  size       integer not null check (size between 1 and 5242880),
  path       text not null unique,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists card_attachments_card_ix  on public.card_attachments (card_id);
create index if not exists card_attachments_board_ix on public.card_attachments (board_id);

-- 3. Descobre o projeto (quadro) pela pasta do arquivo: "12/34/arquivo.png" -> 12.
create or replace function privado.quadro_do_anexo(p_name text) returns bigint
language sql immutable set search_path = '' as $$
  select case when split_part(p_name, '/', 1) ~ '^[0-9]{1,18}$'
              then split_part(p_name, '/', 1)::bigint end
$$;

-- 4. Regras automáticas ao incluir: projeto vem do cartão, autor e data
--    protegidos, e o arquivo precisa estar na pasta daquele cartão.
create or replace function privado.anexo_antes() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  select c.board_id into new.board_id from public.cards c where c.id = new.card_id;
  if new.board_id is null then raise exception 'Cartão não encontrado.'; end if;
  if new.path not like new.board_id || '/' || new.card_id || '/%' then
    raise exception 'Local do arquivo inválido para este cartão.';
  end if;
  new.created_by := (select auth.uid());
  new.created_at := now();
  return new;
end $$;

drop trigger if exists anexo_antes on public.card_attachments;
create trigger anexo_antes before insert on public.card_attachments
  for each row execute function privado.anexo_antes();

-- 5. Auditoria: registra inclusão e exclusão no cartão.
create or replace function privado.anexo_auditar() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform privado.registrar('cartao.anexo_incluido', 'card', new.card_id::text,
      jsonb_build_object('boardId', new.board_id, 'arquivo', new.name));
    return new;
  end if;
  perform privado.registrar('cartao.anexo_excluido', 'card', old.card_id::text,
    jsonb_build_object('boardId', old.board_id, 'arquivo', old.name));
  return old;
end $$;

drop trigger if exists anexo_auditoria on public.card_attachments;
create trigger anexo_auditoria after insert or delete on public.card_attachments
  for each row execute function privado.anexo_auditar();

-- 6. Quem vê e quem altera as fichas (mesmas regras dos cartões).
alter table public.card_attachments enable row level security;

drop policy if exists anexos_ver on public.card_attachments;
create policy anexos_ver on public.card_attachments for select to authenticated
  using (privado.acesso(board_id) is not null);
drop policy if exists anexos_inclui on public.card_attachments;
create policy anexos_inclui on public.card_attachments for insert to authenticated
  with check (privado.acesso(board_id) in ('editar', 'gerenciar'));
drop policy if exists anexos_exclui on public.card_attachments;
create policy anexos_exclui on public.card_attachments for delete to authenticated
  using (privado.acesso(board_id) in ('editar', 'gerenciar'));

-- 7. Quem vê, envia e exclui os ARQUIVOS no depósito (pela pasta do projeto).
drop policy if exists anexos_arquivo_ver on storage.objects;
create policy anexos_arquivo_ver on storage.objects for select to authenticated
  using (bucket_id = 'anexos' and privado.acesso(privado.quadro_do_anexo(name)) is not null);
drop policy if exists anexos_arquivo_inclui on storage.objects;
create policy anexos_arquivo_inclui on storage.objects for insert to authenticated
  with check (bucket_id = 'anexos' and privado.acesso(privado.quadro_do_anexo(name)) in ('editar', 'gerenciar'));
drop policy if exists anexos_arquivo_exclui on storage.objects;
create policy anexos_arquivo_exclui on storage.objects for delete to authenticated
  using (bucket_id = 'anexos' and privado.acesso(privado.quadro_do_anexo(name)) in ('editar', 'gerenciar'));

-- 8. Permissões de acesso pela API (ninguém altera uma ficha; só inclui ou exclui).
revoke all on public.card_attachments from anon;
grant select, insert, delete on public.card_attachments to authenticated;
revoke all on function privado.quadro_do_anexo(text) from public, anon;
revoke all on function privado.anexo_antes()         from public, anon;
revoke all on function privado.anexo_auditar()       from public, anon;
grant execute on function privado.quadro_do_anexo(text) to authenticated;

commit;

-- Avisa a API do Supabase que há uma tabela nova.
notify pgrst, 'reload schema';
