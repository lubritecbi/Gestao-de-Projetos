-- =====================================================================
-- Gestão de Projetos · Etapa 7 · Projetos arquivados (consulta e desarquivar)
-- ---------------------------------------------------------------------
-- Por quê: arquivar um projeto não apaga nada, mas até aqui ele sumia
-- para todos, inclusive para o administrador, e só voltava pelo SQL Editor.
--
-- O que este script faz:
--   1. O ADMINISTRADOR passa a LER os projetos arquivados (quadro, colunas,
--      cartões, membros, anexos e os arquivos dos anexos).
--      Só leitura: as regras de alteração continuam valendo apenas para
--      projetos ativos, então nada muda num projeto arquivado.
--   2. Cria a função "desarquivar_quadro", que só o administrador pode usar.
--      A auditoria registra "quadro.desarquivado".
-- As regras que já existem não são alteradas; aqui só se somam novas.
--
-- Como usar: Supabase > SQL Editor > New query > cole tudo > Run.
-- Rode ANTES de publicar as telas novas. Pode rodar mais de uma vez sem problema.
-- =====================================================================

begin;

-- Verdadeiro quando quem consulta é admin e o projeto está arquivado.
create or replace function privado.arquivado_admin(p_board bigint) returns boolean
language sql stable security definer set search_path = '' as $$
  select privado.is_admin()
     and exists (select 1 from public.boards b where b.id = p_board and b.archived)
$$;

-- 1. Leitura dos arquivados pelo administrador (somente SELECT).
drop policy if exists quadros_ver_arquivados on public.boards;
create policy quadros_ver_arquivados on public.boards for select to authenticated
  using (archived and privado.is_admin());

drop policy if exists colunas_ver_arquivados on public.lists;
create policy colunas_ver_arquivados on public.lists for select to authenticated
  using (privado.arquivado_admin(board_id));

drop policy if exists cartoes_ver_arquivados on public.cards;
create policy cartoes_ver_arquivados on public.cards for select to authenticated
  using (privado.arquivado_admin(board_id));

drop policy if exists membros_ver_arquivados on public.board_members;
create policy membros_ver_arquivados on public.board_members for select to authenticated
  using (privado.arquivado_admin(board_id));

drop policy if exists anexos_ver_arquivados on public.card_attachments;
create policy anexos_ver_arquivados on public.card_attachments for select to authenticated
  using (privado.arquivado_admin(board_id));

drop policy if exists anexos_arquivo_ver_arquivados on storage.objects;
create policy anexos_arquivo_ver_arquivados on storage.objects for select to authenticated
  using (bucket_id = 'anexos' and privado.arquivado_admin(privado.quadro_do_anexo(name)));

-- 2. Desarquivar (só administrador).
create or replace function public.desarquivar_quadro(p_board bigint) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not privado.is_admin() then
    raise exception 'Apenas administradores podem desarquivar projetos.';
  end if;
  update public.boards set archived = false where id = p_board and archived;
  if not found then raise exception 'Projeto arquivado não encontrado.'; end if;
  perform privado.registrar('quadro.desarquivado', 'board', p_board::text, null);
end $$;

-- Permissões de execução
revoke all on function privado.arquivado_admin(bigint)   from public, anon;
revoke all on function public.desarquivar_quadro(bigint) from public, anon;
grant execute on function privado.arquivado_admin(bigint)   to authenticated;
grant execute on function public.desarquivar_quadro(bigint) to authenticated;

commit;

-- Avisa a API do Supabase que há uma função nova.
notify pgrst, 'reload schema';
