-- =====================================================================
-- Gestão de Projetos · Etapa 3 · Ajuste para as telas
-- ---------------------------------------------------------------------
-- Por quê: no 01_banco.sql, quando um Leitor tentava mover um cartão ou
-- uma coluna, o banco já bloqueava (nada mudava), mas sem avisar. Com
-- este ajuste, ele recebe a mensagem "Seu perfil permite apenas
-- visualizar este quadro." e a tela mostra o aviso.
--
-- Como usar: Supabase > SQL Editor > New query > cole tudo > Run.
-- Pode rodar mais de uma vez sem problema.
-- =====================================================================

begin;

create or replace function public.mover_cartao(p_card bigint, p_list bigint, p_index int)
returns void
language plpgsql security invoker set search_path = '' as $$
declare
  v_old_list bigint;
  v_board    bigint;
  v_ids      bigint[];
begin
  select c.list_id, c.board_id into v_old_list, v_board from public.cards c where c.id = p_card;
  if v_old_list is null then raise exception 'Cartão não encontrado.'; end if;
  if coalesce(privado.acesso(v_board), '') not in ('editar','gerenciar') then
    raise exception 'Seu perfil permite apenas visualizar este quadro.';
  end if;

  update public.cards set list_id = p_list where id = p_card and list_id <> p_list;

  select coalesce(array_agg(c.id order by c.position, c.id), '{}') into v_ids
  from public.cards c where c.list_id = p_list and c.id <> p_card;
  p_index := greatest(0, least(coalesce(p_index, 0), cardinality(v_ids)));
  v_ids := v_ids[1:p_index] || p_card || v_ids[p_index + 1:];
  update public.cards c set position = x.pos - 1
    from unnest(v_ids) with ordinality as x(id, pos)
   where c.id = x.id and c.position <> x.pos - 1;

  if v_old_list <> p_list then
    update public.cards c set position = x.pos - 1
      from (select c2.id, row_number() over (order by c2.position, c2.id) as pos
              from public.cards c2 where c2.list_id = v_old_list) x
     where c.id = x.id and c.position <> x.pos - 1;
  end if;
end $$;

create or replace function public.mover_lista(p_list bigint, p_index int)
returns void
language plpgsql security invoker set search_path = '' as $$
declare
  v_board bigint;
  v_ids   bigint[];
begin
  select l.board_id into v_board from public.lists l where l.id = p_list;
  if v_board is null then raise exception 'Coluna não encontrada.'; end if;
  if coalesce(privado.acesso(v_board), '') not in ('editar','gerenciar') then
    raise exception 'Seu perfil permite apenas visualizar este quadro.';
  end if;
  select coalesce(array_agg(l.id order by l.position, l.id), '{}') into v_ids
  from public.lists l where l.board_id = v_board and l.id <> p_list;
  p_index := greatest(0, least(coalesce(p_index, 0), cardinality(v_ids)));
  v_ids := v_ids[1:p_index] || p_list || v_ids[p_index + 1:];
  update public.lists l set position = x.pos - 1
    from unnest(v_ids) with ordinality as x(id, pos)
   where l.id = x.id and l.position <> x.pos - 1;
end $$;

revoke all on function public.mover_cartao(bigint, bigint, int) from anon, public;
revoke all on function public.mover_lista(bigint, int)          from anon, public;
grant execute on function public.mover_cartao(bigint, bigint, int) to authenticated;
grant execute on function public.mover_lista(bigint, int)          to authenticated;

commit;
