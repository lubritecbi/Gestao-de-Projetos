-- =====================================================================
-- Gestão de Projetos · Etapa 1 · Banco de dados no Supabase
-- ---------------------------------------------------------------------
-- O que este script faz:
--   1. Cria as tabelas (as mesmas do sistema atual em SQLite).
--   2. Cria as regras de permissão dos 4 perfis dentro do próprio banco
--      (RLS = Row Level Security). Assim, mesmo quem abrir o código da
--      página no GitHub Pages não consegue ver ou mudar o que não pode.
--   3. Cria a trilha de auditoria automática (gatilhos no banco).
--   4. Cria funções para ações compostas (criar quadro, mover cartão...).
--
-- Como usar: Supabase > SQL Editor > New query > cole tudo > Run.
-- Rode uma única vez, num projeto novo. Tudo roda numa transação:
-- se der qualquer erro, nada fica pela metade.
--
-- Perfis (iguais ao sistema atual):
--   admin  -> tudo (inclusive usuários e auditoria)
--   gestor -> cria quadros; gerencia os quadros de que participa
--   membro -> cria e move cartões nos quadros de que participa
--   leitor -> só visualiza os quadros de que participa
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 0. Esquema "privado"
-- Por quê: as funções de verificação de permissão ficam fora do esquema
-- "public", que é o único que o Supabase expõe na internet pela API.
-- ---------------------------------------------------------------------
create schema if not exists privado;
revoke all on schema privado from public;
grant usage on schema privado to authenticated;

-- Data de hoje no fuso de São Paulo (usada para "atrasado").
create or replace function privado.hoje() returns date
language sql stable set search_path = '' as $$
  select (now() at time zone 'America/Sao_Paulo')::date
$$;

-- =====================================================================
-- 1. TABELAS
-- =====================================================================

-- Perfis: complementam os usuários do Supabase Auth (que guarda e-mail
-- e senha com segurança). Aqui ficam nome, perfil e situação.
create table public.profiles (
  id                   uuid primary key references auth.users(id) on delete cascade,
  email                text not null,
  name                 text not null check (char_length(name) between 2 and 120),
  role                 text not null default 'leitor'
                         check (role in ('admin','gestor','membro','leitor')),
  active               boolean not null default true,
  must_change_password boolean not null default true,
  last_login_at        timestamptz,
  created_at           timestamptz not null default now()
);
create unique index profiles_email_uk on public.profiles (lower(email));

-- Quadros (projetos)
create table public.boards (
  id          bigint generated always as identity primary key,
  code        text not null unique
                check (code ~ '^[A-Za-z0-9._-]{2,20}$'),
  name        text not null check (char_length(name) between 2 and 120),
  description text not null default '' check (char_length(description) <= 4000),
  area        text not null default '' check (char_length(area) <= 120),
  sponsor     text not null default '' check (char_length(sponsor) <= 120),
  owner_id    uuid references public.profiles(id) on delete set null,
  priority    text not null default 'Média' check (priority in ('Alta','Média','Baixa')),
  start_date  date,
  due_date    date,
  archived    boolean not null default false,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint boards_datas_ck check (start_date is null or due_date is null or due_date >= start_date)
);

-- Quem participa de cada quadro
create table public.board_members (
  board_id bigint not null references public.boards(id) on delete cascade,
  user_id  uuid   not null references public.profiles(id) on delete cascade,
  primary key (board_id, user_id)
);
create index board_members_user_ix on public.board_members (user_id);

-- Colunas do quadro (A fazer, Em andamento...)
create table public.lists (
  id       bigint generated always as identity primary key,
  board_id bigint not null references public.boards(id) on delete cascade,
  name     text not null check (char_length(name) between 1 and 80),
  position integer not null default 0,
  is_done  boolean not null default false
);
create index lists_board_ix on public.lists (board_id, position);

-- Cartões (atividades)
create table public.cards (
  id           bigint generated always as identity primary key,
  board_id     bigint not null references public.boards(id) on delete cascade,
  -- "restrict": não deixa excluir uma coluna que ainda tem cartões
  list_id      bigint not null references public.lists(id) on delete restrict,
  title        text not null check (char_length(title) between 1 and 200),
  description  text not null default '' check (char_length(description) <= 10000),
  assignee_id  uuid references public.profiles(id) on delete set null,
  due_date     date,
  priority     text not null default 'Média' check (priority in ('Alta','Média','Baixa')),
  phase        text not null default '' check (char_length(phase) <= 60),
  position     integer not null default 0,
  completed_at timestamptz,
  created_by   uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index cards_board_ix    on public.cards (board_id);
create index cards_list_ix     on public.cards (list_id, position);
create index cards_assignee_ix on public.cards (assignee_id);

-- Trilha de auditoria (só o banco escreve; só o admin lê)
create table public.audit_log (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  user_id    uuid,
  user_email text,
  action     text not null,
  entity     text,
  entity_id  text,
  ip         text,
  details    jsonb
);
create index audit_log_at_ix on public.audit_log (at);

-- =====================================================================
-- 2. FUNÇÕES DE PERMISSÃO (equivalem ao src/access.js)
-- "security definer": rodam com permissão do dono para poder consultar
-- as tabelas sem cair em repetição infinita das próprias regras.
-- =====================================================================

-- Perfil de quem está logado. Retorna vazio se o usuário estiver
-- desativado ou ainda não tiver trocado a senha temporária: assim ele
-- perde acesso aos dados na hora, mesmo com a sessão aberta.
create or replace function privado.papel_atual() returns text
language sql stable security definer set search_path = '' as $$
  select p.role
  from public.profiles p
  where p.id = (select auth.uid()) and p.active and not p.must_change_password
$$;

create or replace function privado.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(privado.papel_atual() = 'admin', false)
$$;

-- Nível de acesso ao quadro: 'gerenciar', 'editar', 'ver' ou vazio.
create or replace function privado.acesso(p_board bigint, p_incluir_arquivados boolean default false)
returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v_papel  text := privado.papel_atual();
  v_membro boolean;
begin
  if v_papel is null then return null; end if;
  if not exists (select 1 from public.boards b
                 where b.id = p_board and (p_incluir_arquivados or not b.archived)) then
    return null;
  end if;
  if v_papel = 'admin' then return 'gerenciar'; end if;
  select exists (select 1 from public.board_members m
                 where m.board_id = p_board and m.user_id = (select auth.uid()))
    into v_membro;
  if not v_membro then return null; end if;
  return case v_papel when 'gestor' then 'gerenciar'
                      when 'membro' then 'editar'
                      else 'ver' end;
end $$;

-- =====================================================================
-- 3. AUDITORIA AUTOMÁTICA (equivale ao src/audit.js)
-- =====================================================================

create or replace function privado.registrar(p_acao text, p_entidade text, p_id text, p_detalhes jsonb)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_ip  text;
begin
  -- IP de quem fez a ação (o Supabase repassa o cabeçalho da requisição)
  begin
    v_ip := split_part(current_setting('request.headers', true)::json ->> 'x-forwarded-for', ',', 1);
  exception when others then v_ip := null;
  end;
  insert into public.audit_log (user_id, user_email, action, entity, entity_id, ip, details)
  values (v_uid,
          (select p.email from public.profiles p where p.id = v_uid),
          p_acao, p_entidade, p_id, nullif(v_ip, ''), p_detalhes);
end $$;

-- Lista os campos que mudaram (ignorando posição e datas automáticas,
-- para não encher a auditoria com reordenações).
create or replace function privado.campos_alterados(p_old jsonb, p_new jsonb)
returns text[]
language sql immutable set search_path = '' as $$
  select coalesce(array_agg(n.key order by n.key), '{}')
  from jsonb_each(p_new) n
  where n.value is distinct from p_old -> n.key
    and n.key not in ('position','updated_at','completed_at','last_login_at')
$$;

create or replace function privado.auditar() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_new    jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  v_old    jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  v_campos text[];
  v_ent    text := case tg_table_name when 'boards' then 'board' when 'lists' then 'list'
                                      when 'cards' then 'card' when 'profiles' then 'user'
                                      else 'board_member' end;
  v_pref   text := case tg_table_name when 'boards' then 'quadro' when 'lists' then 'lista'
                                      when 'cards' then 'cartao' when 'profiles' then 'usuario'
                                      else 'quadro.membro' end;
begin
  if tg_op = 'INSERT' then
    perform privado.registrar(
      case when tg_table_name = 'board_members' then 'quadro.membro_incluido'
           when tg_table_name = 'lists' then 'lista.criada' else v_pref || '.criado' end,
      v_ent,
      case when tg_table_name = 'board_members' then v_new ->> 'board_id' else v_new ->> 'id' end,
      case tg_table_name
        when 'boards'        then jsonb_build_object('code', v_new ->> 'code', 'name', v_new ->> 'name')
        when 'cards'         then jsonb_build_object('boardId', v_new -> 'board_id', 'title', v_new ->> 'title')
        when 'lists'         then jsonb_build_object('boardId', v_new -> 'board_id', 'name', v_new ->> 'name')
        when 'board_members' then jsonb_build_object('userId', v_new ->> 'user_id')
        when 'profiles'      then jsonb_build_object('email', v_new ->> 'email', 'role', v_new ->> 'role')
      end);
    return new;
  end if;

  if tg_op = 'DELETE' then
    perform privado.registrar(
      case when tg_table_name = 'board_members' then 'quadro.membro_removido'
           when tg_table_name = 'lists' then 'lista.excluida' else v_pref || '.excluido' end,
      v_ent,
      case when tg_table_name = 'board_members' then v_old ->> 'board_id' else v_old ->> 'id' end,
      case tg_table_name
        when 'cards'         then jsonb_build_object('boardId', v_old -> 'board_id', 'title', v_old ->> 'title')
        when 'lists'         then jsonb_build_object('boardId', v_old -> 'board_id', 'name', v_old ->> 'name')
        when 'board_members' then jsonb_build_object('userId', v_old ->> 'user_id')
        else jsonb_build_object('id', v_old ->> 'id')
      end);
    return old;
  end if;

  -- UPDATE
  if tg_table_name = 'cards' and (v_new -> 'list_id') is distinct from (v_old -> 'list_id') then
    perform privado.registrar('cartao.movido', 'card', v_new ->> 'id', jsonb_build_object(
      'de',   (select l.name from public.lists l where l.id = (v_old ->> 'list_id')::bigint),
      'para', (select l.name from public.lists l where l.id = (v_new ->> 'list_id')::bigint)));
    return new;
  end if;
  if tg_table_name = 'boards' and (v_new ->> 'archived')::boolean and not (v_old ->> 'archived')::boolean then
    perform privado.registrar('quadro.arquivado', 'board', v_new ->> 'id', null);
    return new;
  end if;

  v_campos := privado.campos_alterados(v_old, v_new);
  if array_length(v_campos, 1) > 0 then
    perform privado.registrar(case when tg_table_name = 'lists' then 'lista.alterada' else v_pref || '.alterado' end, v_ent, v_new ->> 'id', to_jsonb(v_campos));
  end if;
  return new;
end $$;

-- =====================================================================
-- 4. REGRAS AUTOMÁTICAS (gatilhos)
-- Por quê: garantem consistência mesmo que alguém chame a API direto,
-- sem passar pelas telas.
-- =====================================================================

-- 4.1 Novo usuário no Supabase Auth -> cria o perfil.
-- O perfil vem do "app_metadata", que só o servidor (Edge Function do
-- admin) consegue definir. Sem ele, entra como "leitor".
create or replace function privado.novo_usuario() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_role text := new.raw_app_meta_data ->> 'role';
begin
  if v_role is null or v_role not in ('admin','gestor','membro','leitor') then
    v_role := 'leitor';
  end if;
  insert into public.profiles (id, email, name, role)
  values (new.id,
          lower(new.email),
          coalesce(nullif(trim(new.raw_user_meta_data ->> 'name'), ''), split_part(new.email, '@', 1)),
          v_role);
  return new;
end $$;

create trigger ao_criar_usuario
  after insert on auth.users
  for each row execute function privado.novo_usuario();

-- 4.2 Perfis: protege campos e impede o admin de se trancar para fora.
create or replace function privado.perfil_antes() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.id         := old.id;
  new.email      := old.email;
  new.created_at := old.created_at;
  if old.id = (select auth.uid()) and (not new.active or new.role <> old.role) then
    raise exception 'Você não pode desativar ou mudar o perfil da própria conta.';
  end if;
  return new;
end $$;

create trigger perfil_antes before update on public.profiles
  for each row execute function privado.perfil_antes();

-- 4.3 Quadros: protege autor/data e valida responsável.
create or replace function privado.quadro_antes() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.created_by := old.created_by;
  new.created_at := old.created_at;
  new.updated_at := now();
  if new.owner_id is distinct from old.owner_id and new.owner_id is not null
     and not exists (select 1 from public.profiles p where p.id = new.owner_id and p.active) then
    raise exception 'Responsável não encontrado ou inativo.';
  end if;
  return new;
end $$;

create trigger quadro_antes before update on public.boards
  for each row execute function privado.quadro_antes();

-- 4.4 Membros: só usuários ativos.
create or replace function privado.membro_antes() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.profiles p where p.id = new.user_id and p.active) then
    raise exception 'Usuário não encontrado ou inativo.';
  end if;
  return new;
end $$;

create trigger membro_antes before insert on public.board_members
  for each row execute function privado.membro_antes();

-- 4.5 Colunas: posição automática; ao marcar/desmarcar "concluído",
-- recalcula a data de conclusão dos cartões daquela coluna.
create or replace function privado.lista_antes() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    select coalesce(max(l.position), -1) + 1 into new.position
    from public.lists l where l.board_id = new.board_id;
  else
    new.board_id := old.board_id;  -- coluna não muda de quadro
  end if;
  return new;
end $$;

create trigger lista_antes before insert or update on public.lists
  for each row execute function privado.lista_antes();

create or replace function privado.lista_depois() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.is_done is distinct from old.is_done then
    update public.cards c
       set completed_at = case when new.is_done then now() else null end
     where c.list_id = new.id;
  end if;
  return new;
end $$;

-- Mensagem clara ao tentar excluir coluna que ainda tem cartões
create or replace function privado.lista_excluir() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.cards c where c.list_id = old.id) then
    raise exception 'Mova ou exclua os cartões antes de excluir a coluna.';
  end if;
  return old;
end $$;

create trigger lista_excluir before delete on public.lists
  for each row execute function privado.lista_excluir();

create trigger lista_depois after update on public.lists
  for each row execute function privado.lista_depois();

-- 4.6 Cartões: quadro vem da coluna, responsável precisa ser membro,
-- data de conclusão automática, autor e criação protegidos.
create or replace function privado.cartao_antes() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_board bigint;
  v_done  boolean;
begin
  select l.board_id, l.is_done into v_board, v_done
  from public.lists l where l.id = new.list_id;
  if v_board is null then raise exception 'Coluna inválida para este quadro.'; end if;

  if tg_op = 'INSERT' then
    new.board_id   := v_board;
    new.created_by := (select auth.uid());
    new.created_at := now();
    select coalesce(max(c.position), -1) + 1 into new.position
    from public.cards c where c.list_id = new.list_id;
    new.completed_at := case when v_done then now() else null end;
  else
    if v_board <> old.board_id then raise exception 'Coluna inválida para este quadro.'; end if;
    new.board_id   := old.board_id;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    -- Mudou de coluna: conclui (ou reabre) conforme a coluna de destino.
    if new.list_id <> old.list_id then
      new.completed_at := case when v_done then coalesce(old.completed_at, now()) else null end;
    end if;
  end if;
  new.updated_at := now();

  if new.assignee_id is not null and (tg_op = 'INSERT' or new.assignee_id is distinct from old.assignee_id)
     and not exists (select 1 from public.board_members m
                     where m.board_id = new.board_id and m.user_id = new.assignee_id) then
    raise exception 'O responsável precisa ser membro do quadro.';
  end if;
  return new;
end $$;

create trigger cartao_antes before insert or update on public.cards
  for each row execute function privado.cartao_antes();

-- 4.7 Auditoria em todas as tabelas de negócio
create trigger auditoria after insert or update or delete on public.boards
  for each row execute function privado.auditar();
create trigger auditoria after insert or delete on public.board_members
  for each row execute function privado.auditar();
create trigger auditoria after insert or update or delete on public.lists
  for each row execute function privado.auditar();
create trigger auditoria after insert or update or delete on public.cards
  for each row execute function privado.auditar();
create trigger auditoria after insert or update on public.profiles
  for each row execute function privado.auditar();

-- =====================================================================
-- 5. REGRAS DE PERMISSÃO POR LINHA (RLS)
-- Por quê: é aqui que o banco decide, linha a linha, quem vê e quem
-- altera o quê. Sem regra = acesso negado.
-- =====================================================================

alter table public.profiles      enable row level security;
alter table public.boards        enable row level security;
alter table public.board_members enable row level security;
alter table public.lists         enable row level security;
alter table public.cards         enable row level security;
alter table public.audit_log     enable row level security;

-- Perfis: cada um vê o próprio; usuários liberados veem os ativos
-- (para escolher responsáveis); o admin vê todos e é o único que altera.
create policy perfis_ver on public.profiles for select to authenticated
  using (id = (select auth.uid())
         or privado.is_admin()
         or (active and privado.papel_atual() is not null));
create policy perfis_admin_altera on public.profiles for update to authenticated
  using (privado.is_admin()) with check (privado.is_admin());

-- Quadros: vê quem participa (ou admin). Criação só pela função
-- criar_quadro (seção 6). Alterar/arquivar: gestor do quadro ou admin.
create policy quadros_ver on public.boards for select to authenticated
  using (privado.acesso(id) is not null);
create policy quadros_altera on public.boards for update to authenticated
  using (privado.acesso(id) = 'gerenciar')
  with check (privado.acesso(id, true) = 'gerenciar');

-- Membros dos quadros: gestor do quadro ou admin inclui/remove.
-- O gestor não pode remover a si mesmo.
create policy membros_ver on public.board_members for select to authenticated
  using (privado.acesso(board_id) is not null);
create policy membros_inclui on public.board_members for insert to authenticated
  with check (privado.acesso(board_id) = 'gerenciar');
create policy membros_remove on public.board_members for delete to authenticated
  using (privado.acesso(board_id) = 'gerenciar'
         and (user_id <> (select auth.uid()) or privado.is_admin()));

-- Colunas e cartões: todos do quadro veem; membro, gestor e admin editam.
create policy colunas_ver on public.lists for select to authenticated
  using (privado.acesso(board_id) is not null);
create policy colunas_inclui on public.lists for insert to authenticated
  with check (privado.acesso(board_id) in ('editar','gerenciar'));
create policy colunas_altera on public.lists for update to authenticated
  using (privado.acesso(board_id) in ('editar','gerenciar'))
  with check (privado.acesso(board_id) in ('editar','gerenciar'));
create policy colunas_exclui on public.lists for delete to authenticated
  using (privado.acesso(board_id) in ('editar','gerenciar'));

create policy cartoes_ver on public.cards for select to authenticated
  using (privado.acesso(board_id) is not null);
create policy cartoes_inclui on public.cards for insert to authenticated
  with check (privado.acesso(board_id) in ('editar','gerenciar'));
create policy cartoes_altera on public.cards for update to authenticated
  using (privado.acesso(board_id) in ('editar','gerenciar'))
  with check (privado.acesso(board_id) in ('editar','gerenciar'));
create policy cartoes_exclui on public.cards for delete to authenticated
  using (privado.acesso(board_id) in ('editar','gerenciar'));

-- Auditoria: só o admin lê. Ninguém insere, altera ou apaga pela API.
create policy auditoria_admin_ve on public.audit_log for select to authenticated
  using (privado.is_admin());

-- =====================================================================
-- 6. FUNÇÕES CHAMADAS PELAS TELAS (RPC)
-- Por quê: ações com vários passos rodam de uma vez só no banco
-- (tudo ou nada), sem depender do navegador.
-- =====================================================================

-- 6.1 Criar quadro (admin ou gestor): gera o código PRJ-00X, cria as
-- 4 colunas padrão e inclui criador e responsável como membros.
create or replace function public.criar_quadro(
  p_name text, p_code text default null, p_description text default '',
  p_area text default '', p_sponsor text default '', p_owner uuid default null,
  p_priority text default 'Média', p_start date default null, p_due date default null)
returns table (id bigint, code text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_uid   uuid := (select auth.uid());
  v_code  text := nullif(trim(p_code), '');
  v_id    bigint;
  v_owner uuid := coalesce(p_owner, v_uid);
  i       int;
begin
  if coalesce(privado.papel_atual(), '') not in ('admin','gestor') then
    raise exception 'Você não tem permissão para esta ação.';
  end if;
  if not exists (select 1 from public.profiles p where p.id = v_owner and p.active) then
    raise exception 'Responsável não encontrado ou inativo.';
  end if;
  if v_code is null then
    i := (select count(*) from public.boards) + 1;
    loop
      v_code := 'PRJ-' || lpad(i::text, 3, '0');
      exit when not exists (select 1 from public.boards b where b.code = v_code);
      i := i + 1;
    end loop;
  elsif exists (select 1 from public.boards b where b.code = v_code) then
    raise exception 'Já existe um projeto com este ID.';
  end if;

  insert into public.boards (code, name, description, area, sponsor, owner_id, priority,
                             start_date, due_date, created_by)
  values (v_code, trim(p_name), coalesce(p_description, ''), coalesce(p_area, ''),
          coalesce(p_sponsor, ''), v_owner, coalesce(p_priority, 'Média'), p_start, p_due, v_uid)
  returning boards.id into v_id;

  insert into public.lists (board_id, name, is_done) values
    (v_id, 'A fazer', false), (v_id, 'Em andamento', false),
    (v_id, 'Em validação', false), (v_id, 'Concluído', true);

  insert into public.board_members (board_id, user_id) values (v_id, v_uid)
    on conflict do nothing;
  insert into public.board_members (board_id, user_id) values (v_id, v_owner)
    on conflict do nothing;

  return query select v_id, v_code;
end $$;

-- 6.2 Mover cartão para uma coluna/posição (respeita as regras do RLS).
create or replace function public.mover_cartao(p_card bigint, p_list bigint, p_index int)
returns void
language plpgsql security invoker set search_path = '' as $$
declare
  v_old_list bigint;
  v_ids      bigint[];
begin
  select c.list_id into v_old_list from public.cards c where c.id = p_card;
  if v_old_list is null then raise exception 'Cartão não encontrado.'; end if;

  update public.cards set list_id = p_list where id = p_card and list_id <> p_list;

  -- Reordena a coluna de destino com o cartão na posição pedida
  select coalesce(array_agg(c.id order by c.position, c.id), '{}') into v_ids
  from public.cards c where c.list_id = p_list and c.id <> p_card;
  p_index := greatest(0, least(coalesce(p_index, 0), cardinality(v_ids)));
  v_ids := v_ids[1:p_index] || p_card || v_ids[p_index + 1:];
  update public.cards c set position = x.pos - 1
    from unnest(v_ids) with ordinality as x(id, pos)
   where c.id = x.id and c.position <> x.pos - 1;

  -- Fecha o "buraco" na coluna de origem
  if v_old_list <> p_list then
    update public.cards c set position = x.pos - 1
      from (select c2.id, row_number() over (order by c2.position, c2.id) as pos
              from public.cards c2 where c2.list_id = v_old_list) x
     where c.id = x.id and c.position <> x.pos - 1;
  end if;
end $$;

-- 6.3 Reordenar colunas
create or replace function public.mover_lista(p_list bigint, p_index int)
returns void
language plpgsql security invoker set search_path = '' as $$
declare
  v_board bigint;
  v_ids   bigint[];
begin
  select l.board_id into v_board from public.lists l where l.id = p_list;
  if v_board is null then raise exception 'Coluna não encontrada.'; end if;
  select coalesce(array_agg(l.id order by l.position, l.id), '{}') into v_ids
  from public.lists l where l.board_id = v_board and l.id <> p_list;
  p_index := greatest(0, least(coalesce(p_index, 0), cardinality(v_ids)));
  v_ids := v_ids[1:p_index] || p_list || v_ids[p_index + 1:];
  update public.lists l set position = x.pos - 1
    from unnest(v_ids) with ordinality as x(id, pos)
   where l.id = x.id and l.position <> x.pos - 1;
end $$;

-- 6.4 Definir os membros de um quadro de uma vez (gestor do quadro ou admin)
create or replace function public.definir_membros(p_board bigint, p_users uuid[])
returns void
language plpgsql security invoker set search_path = '' as $$
begin
  if privado.acesso(p_board) is distinct from 'gerenciar' then
    raise exception 'Apenas gestores do quadro ou administradores podem fazer isso.';
  end if;
  -- Remove quem saiu (a regra do RLS impede o gestor de remover a si mesmo)
  delete from public.board_members m
   where m.board_id = p_board and not (m.user_id = any (coalesce(p_users, '{}')));
  -- Inclui quem entrou (só usuários ativos)
  insert into public.board_members (board_id, user_id)
  select p_board, p.id from public.profiles p
   where p.id = any (coalesce(p_users, '{}')) and p.active
  on conflict do nothing;
end $$;

-- 6.5 Após a troca da senha temporária no Supabase Auth, libera o uso.
create or replace function public.concluir_troca_senha()
returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.profiles set must_change_password = false
   where id = (select auth.uid()) and must_change_password;
  if found then perform privado.registrar('senha.trocada', 'user', (select auth.uid())::text, null); end if;
end $$;

-- 6.6 Registra o login (último acesso + auditoria).
create or replace function public.registrar_acesso()
returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.profiles set last_login_at = now()
   where id = (select auth.uid()) and active;
  if found then perform privado.registrar('login.sucesso', 'user', (select auth.uid())::text, null); end if;
end $$;

-- 6.7 Apaga registros de auditoria antigos (padrão: 365 dias). Só admin.
create or replace function public.limpar_auditoria(p_dias int default 365)
returns integer
language plpgsql security definer set search_path = '' as $$
declare v_n integer;
begin
  if not privado.is_admin() then raise exception 'Você não tem permissão para esta ação.'; end if;
  delete from public.audit_log where at < now() - make_interval(days => greatest(p_dias, 30));
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- =====================================================================
-- 7. RESUMO DOS QUADROS (usado no painel de desempenho)
-- "security_invoker": a visão respeita as regras do RLS de quem consulta.
-- O farol (No prazo / Atenção / Atrasado) é calculado na tela, com a
-- mesma regra da planilha (src/metrics.js).
-- =====================================================================
create view public.v_quadros with (security_invoker = true) as
select b.*,
       o.name                                                         as owner_name,
       count(c.id)::int                                               as total,
       count(c.id) filter (where l.is_done)::int                      as done,
       count(c.id) filter (where not l.is_done
                             and c.due_date < privado.hoje())::int    as overdue
from public.boards b
left join public.profiles o on o.id = b.owner_id
left join public.cards c    on c.board_id = b.id
left join public.lists l    on l.id = c.list_id
where not b.archived
group by b.id, o.name;

-- =====================================================================
-- 8. PERMISSÕES DE ACESSO À API
-- Por quê: "anon" é quem não fez login. Ele não acessa nada.
-- "authenticated" acessa só o que as regras do RLS liberam.
-- =====================================================================
revoke all on all tables    in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke all on all functions in schema public from anon, public;
revoke all on all functions in schema privado from anon, public;

grant select, update                 on public.profiles      to authenticated;
grant select, update                 on public.boards        to authenticated;
grant select, insert, delete         on public.board_members to authenticated;
grant select, insert, update, delete on public.lists         to authenticated;
grant select, insert, update, delete on public.cards         to authenticated;
grant select                         on public.audit_log     to authenticated;
grant select                         on public.v_quadros     to authenticated;
revoke insert, update, delete, truncate on public.audit_log from authenticated;
revoke insert, delete, truncate         on public.profiles  from authenticated;
revoke insert, delete, truncate         on public.boards    from authenticated;

grant execute on all functions in schema privado to authenticated;
grant execute on function public.criar_quadro(text, text, text, text, text, uuid, text, date, date) to authenticated;
grant execute on function public.mover_cartao(bigint, bigint, int)    to authenticated;
grant execute on function public.mover_lista(bigint, int)             to authenticated;
grant execute on function public.definir_membros(bigint, uuid[])      to authenticated;
grant execute on function public.concluir_troca_senha()               to authenticated;
grant execute on function public.registrar_acesso()                   to authenticated;
grant execute on function public.limpar_auditoria(int)                to authenticated;

commit;
