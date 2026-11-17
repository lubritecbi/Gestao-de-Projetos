# Segurança

## Como relatar um problema

Não abra issue pública para falhas de segurança. Envie os detalhes diretamente ao responsável pelo sistema (preencha aqui o e-mail interno, por exemplo `seguranca@empresa.com.br`), com os passos para reproduzir e o impacto percebido.

## Cuidados com este repositório

- Este repositório está **público** para permitir a demonstração no GitHub Pages. Ele não contém senhas, mas descreve a estrutura interna do sistema: nunca envie dados reais, nomes de clientes, endereços internos ou credenciais. Quando o sistema for para um servidor, avalie voltar o repositório para privado.
- Nunca versione o arquivo `.env`, a pasta `data/` ou arquivos `.db`. O `.gitignore` já bloqueia esses itens; confira antes de cada envio.
- Ative no GitHub: **Settings > Code security** > Dependabot alerts, Dependabot security updates e Secret scanning.
- Exija revisão de outra pessoa antes de juntar mudanças na branch `main` (**Settings > Branches > Branch protection rules**).

## Controles implementados no sistema

Estão descritos na seção "Controles de segurança" do `README.md` e verificados pelos testes em `test/security.test.js`, que rodam automaticamente a cada envio (`.github/workflows/ci.yml`).
