-- =====================================================================
-- Gestão de Projetos · Etapa 1 · Promover o primeiro administrador
-- ---------------------------------------------------------------------
-- Por quê: o cadastro público fica desligado, então ninguém entra
-- sozinho. O primeiro usuário é criado à mão no painel do Supabase e
-- depois promovido a administrador com este script. A partir daí, o
-- próprio admin cria os demais acessos pelo sistema.
--
-- Antes de rodar:
--   1. Supabase > Authentication > Users > Add user > Create new user
--      (marque "Auto Confirm User").
--   2. Troque o e-mail abaixo pelo e-mail que você acabou de criar.
-- Como usar: Supabase > SQL Editor > New query > cole > Run.
-- =====================================================================

update public.profiles
   set role = 'admin',
       name = 'Administrador',          -- troque pelo nome desejado
       must_change_password = false     -- a senha já foi definida por você no painel
 where email = lower('ti@empresa.com.br');  -- << troque pelo e-mail criado

-- Confere o resultado: deve aparecer 1 linha com role = admin
select email, name, role, active, must_change_password
  from public.profiles
 where role = 'admin';
