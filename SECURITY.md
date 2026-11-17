# Segurança

## Como relatar um problema

Não abra issue pública para falhas de segurança. Envie os detalhes diretamente ao responsável pelo sistema (preencha aqui o e-mail interno, por exemplo `seguranca@empresa.com.br`), com os passos para reproduzir e o impacto percebido.

## Cuidados com este repositório

- Este repositório está **público** porque a plataforma é publicada pelo GitHub Pages (plano gratuito). Ele não contém senhas, mas descreve a estrutura interna do sistema: nunca envie dados reais, nomes de clientes, endereços internos ou credenciais. Quando o sistema for para um servidor, avalie voltar o repositório para privado.
- Nunca versione o arquivo `.env`, a pasta `data/` ou arquivos `.db`. O `.gitignore` já bloqueia esses itens; confira antes de cada envio.
- Ative no GitHub: **Settings > Code security** > Dependabot alerts, Dependabot security updates e Secret scanning.
- Exija revisão de outra pessoa antes de juntar mudanças na branch `main` (**Settings > Branches > Branch protection rules**).

## Versão GitHub Pages + Supabase

- **Chaves do Supabase:** só a chave pública (anon/publishable) pode ficar no código, em `web/config.js`. A chave secreta (service_role/secret) e a senha do banco ficam apenas no Supabase e nos *Secrets* do GitHub Actions. O fluxo de publicação bloqueia o envio se encontrar uma chave secreta em `web/config.js`. Se uma chave secreta vazar, gere outra em Supabase > Project Settings > API Keys imediatamente.
- **Permissões no banco:** todas as regras de acesso estão no PostgreSQL (RLS), em `supabase/01_banco.sql`. Alterar a página não dá acesso a nada além do que o perfil permite. Qualquer mudança nessas regras deve ser testada com os quatro perfis antes de ir para o Supabase.
- **Cadastro fechado:** em Supabase > Authentication, "Allow new users to sign up" deve ficar **desligado**. Só o administrador cria acessos, pela Edge Function `admin-usuarios`.
- **Senhas:** mínimo de 12 caracteres com minúsculas, maiúsculas, números e símbolos (configurado no Supabase e conferido pela página). Senhas não podem ser lidas, só redefinidas.
- **Backups:** gerados pelo GitHub Actions e **sempre criptografados** (AES-256), porque arquivos de um repositório público podem ser baixados por qualquer conta do GitHub. Guarde a `BACKUP_PASSPHRASE` fora do GitHub; troque-a se alguém que a conhecia sair da equipe.
- **Desligamento de pessoas:** desative o usuário na tela Usuários no mesmo dia. O acesso aos dados é cortado na hora e o login fica bloqueado.

## Controles implementados no sistema

Estão descritos na seção "Controles de segurança" do `README.md` e verificados pelos testes em `test/security.test.js`, que rodam automaticamente a cada envio (`.github/workflows/ci.yml`).
