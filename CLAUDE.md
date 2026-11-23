# Gestão de Projetos — instruções para o Claude

## O que é o sistema
Sistema web interno com login, perfis (admin, gestor, membro, leitor), quadros kanban,
painel de desempenho e auditoria.

- Visual "Etiqueta com circuito": fundo azul escuro, azul e vermelho da empresa,
  fonte Chivo hospedada no próprio sistema.
- Projetos cadastrados: PRJ-001 Roteirizador, PRJ-002 Validação de IPE Logística,
  PRJ-003 Validador de Execução por foto.

## No ar (versão em uso, sem custo)
- Plataforma: https://lubritecbi.github.io/Gestao-de-Projetos/
- Demonstração (dados só no navegador): https://lubritecbi.github.io/Gestao-de-Projetos/demo/
- O site fica na subpasta /Gestao-de-Projetos/: em web/, use caminhos relativos
  (img/..., e não /img/...), senão imagens e arquivos quebram no GitHub Pages.

## Arquitetura em uso
- Telas no GitHub Pages: pasta web/, ponte com o banco em web/api-supabase.js.
- Supabase plano gratuito: projeto "gestao-projetos" (ID pzoflktbghricjjriirt, região us-east-2).
  - Login no Supabase Auth (cadastro público desligado).
  - PostgreSQL com permissões por perfil em RLS e auditoria por gatilhos.
  - Edge Function "admin-usuarios" para gestão de usuários. No Supabase, o endereço dela é
    /functions/v1/hyper-endpoint (é o que web/api-supabase.js chama) e "Verify JWT" fica DESLIGADO:
    ligado, o Supabase recusa a consulta prévia do navegador. A própria função confere se quem chama é admin.
  - Scripts do banco em supabase/: 01_banco, 02_primeiro_admin, 03_ajustes_telas, 04_restaurar_gatilho,
    05_checklists (coluna "checklists" nos cartões: várias checklists com nome e itens),
    06_anexos (anexos nos cartões: depósito privado "anexos" no Storage, tabela card_attachments;
    imagens e PDF até 5 MB).
- Na página só vai a chave pública (publishable). A chave secreta NUNCA vai para o GitHub.
- Versão alternativa com servidor próprio (Node.js 22 + Express + SQLite) em src/ e public/,
  para uma futura hospedagem pela TI.

## Publicação e backup
- Publicação: .github/workflows/Pages.yml ("Publicar no GitHub Pages"; Source = GitHub Actions;
  Custom domain vazio). Todo push na main publica.
- Backup: .github/workflows/backup-supabase.yml, seg/qua/sex, criptografado (AES-256),
  30 dias em Actions > Artifacts; também mantém o Supabase ativo.
  Gera dois arquivos: gestao-supabase-*.tar.gz.gpg (banco) e gestao-anexos-*.tar.gpg (arquivos do Storage).
  Segredos: SUPABASE_DB_URL (Session pooler; senha do banco só letras e números),
  BACKUP_PASSPHRASE (guardada fora do GitHub) e SUPABASE_SECRET_KEY (chave "secret" do Supabase,
  só para baixar os anexos; sem ela o backup do banco segue e o fluxo avisa).

## Documentação
README.md, SECURITY.md e PDF "Gestao-de-Projetos-Documentacao" (versão 1.1, nov/2026).

## Pendências conhecidas
- Avaliar migrar o Supabase para a região São Paulo.
- Revisar os 4 pull requests do Dependabot (afetam só a versão com servidor próprio).

## Regras de trabalho
1. Sempre que alterar configurações do sistema, atualize o PDF de documentação
   (subindo a versão) e os arquivos do GitHub.
2. Quando eu pedir um script, entregue apenas o script, sem executar.
3. Explique o porquê de cada etapa, de forma simples, em português.
4. Antes de qualquer commit, mostre os arquivos alterados e a mensagem, e espere meu "ok".
   Se eu já tiver aprovado o commit no próprio pedido, não precisa perguntar de novo.
5. Peça permissão antes de qualquer ação que envolva o meu computador ou conectores.
6. Nunca escreva senhas, tokens ou chaves secretas em arquivos do repositório.
