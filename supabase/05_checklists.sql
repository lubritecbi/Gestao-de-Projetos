-- =====================================================================
-- Gestão de Projetos · Etapa 5 · Checklists nos cartões
-- ---------------------------------------------------------------------
-- Por quê: cada cartão passa a ter checklists com nome (ex.: "Testes",
-- "Documentação"), cada uma com itens para marcar.
--
-- As checklists ficam numa coluna nova do próprio cartão (formato JSON).
-- Assim valem as mesmas regras que o cartão já tem, sem nada novo:
--   - quem vê o cartão vê as checklists; quem edita o cartão marca os itens
--     (Leitor só visualiza), pelas regras RLS que já existem;
--   - a auditoria registra "cartao.alterado" com o campo "checklists".
--
-- Como usar: Supabase > SQL Editor > New query > cole tudo > Run.
-- Rode ANTES de publicar as telas novas. Pode rodar mais de uma vez sem problema.
-- =====================================================================

begin;

-- Coluna nova: começa vazia ([]) em todos os cartões que já existem.
alter table public.cards
  add column if not exists checklists jsonb not null default '[]'::jsonb;

-- Trava de segurança: precisa ser uma lista, com no máximo 10 checklists,
-- e um tamanho total limitado (evita que alguém grave um volume enorme
-- chamando a API direto, sem passar pelas telas).
alter table public.cards drop constraint if exists cards_checklists_ck;
alter table public.cards add constraint cards_checklists_ck check (
  jsonb_typeof(checklists) = 'array'
  and jsonb_array_length(checklists) <= 10
  and octet_length(checklists::text) <= 200000
);

commit;

-- Avisa a API do Supabase que a tabela ganhou uma coluna.
notify pgrst, 'reload schema';
