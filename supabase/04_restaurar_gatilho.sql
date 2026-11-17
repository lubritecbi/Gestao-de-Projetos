-- =====================================================================
-- Gestão de Projetos · Restauração de backup · último passo
-- ---------------------------------------------------------------------
-- Por quê: o gatilho que cria o perfil quando o admin cadastra alguém
-- fica na tabela de logins do Supabase (auth.users), fora do backup.
-- Depois de restaurar 02_logins.sql e 01_sistema.sql, rode este script
-- para religá-lo e reaplicar as permissões de acesso. Pode rodar mais de uma vez sem problema.
-- Como usar: Supabase > SQL Editor > New query > cole tudo > Run.
-- =====================================================================
drop trigger if exists ao_criar_usuario on auth.users;
create trigger ao_criar_usuario
  after insert on auth.users
  for each row execute function privado.novo_usuario();

-- Reaplica as permissões de acesso à API (iguais ao 01_banco.sql, seção 8).
-- Por quê: um projeto novo do Supabase libera as tabelas para "anon" por padrão.
revoke all on all tables    in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke all on all functions in schema public from anon, public;
revoke all on all functions in schema privado from anon, public;
grant usage on schema privado to authenticated;
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

-- Conferência: deve mostrar 1 gatilho e os totais restaurados
select (select count(*) from pg_trigger where tgname = 'ao_criar_usuario') as gatilho,
       (select count(*) from public.boards)   as quadros,
       (select count(*) from public.cards)    as cartoes,
       (select count(*) from public.profiles) as usuarios;
