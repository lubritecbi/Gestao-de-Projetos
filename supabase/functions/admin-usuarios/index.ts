// =====================================================================
// Gestão de Projetos · Etapa 2 · Edge Function "admin-usuarios"
// ---------------------------------------------------------------------
// Por que existe: criar usuário, trocar senha de outra pessoa e bloquear
// login exigem a "chave mestra" do Supabase (service role). Essa chave
// NUNCA pode ir para a página no GitHub Pages. Então ela fica só aqui,
// no servidor do Supabase, e esta função só obedece a administradores.
//
// Ações (enviadas no corpo JSON, campo "acao"):
//   criar           { email, name, role }   -> devolve senha temporária
//   redefinir_senha { userId }              -> devolve nova senha temporária
//   alterar         { userId, name?, role? }
//   desativar       { userId }              -> bloqueia login e acesso
//   ativar          { userId }
//
// A senha temporária aparece UMA vez para o admin e não fica guardada.
// No primeiro acesso, o sistema obriga a pessoa a trocá-la.
// =====================================================================

import { createClient } from "npm:@supabase/supabase-js@2";

// Endereços que podem chamar esta função (o site e testes locais).
const ORIGENS_PERMITIDAS = [
  "https://lubritecbi.github.io",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];
const PAPEIS = ["admin", "gestor", "membro", "leitor"];
const BLOQUEIO_PERMANENTE = "876000h"; // ~100 anos

// O Supabase entrega estes valores à função automaticamente.
// SUPABASE_SECRET_KEY só é necessária se o projeto não fornecer a SERVICE_ROLE_KEY
// (nesse caso, crie-a em Edge Functions > Secrets com a chave "secret" do projeto).
const URL_SUPABASE = Deno.env.get("SUPABASE_URL") ?? "";
const CHAVE_MESTRA = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SECRET_KEY") || "";
if (!URL_SUPABASE || !CHAVE_MESTRA) console.error("admin-usuarios: SUPABASE_URL ou chave de servidor ausente.");

// Cliente com a chave mestra: ignora o RLS, por isso só é usado depois
// de confirmar que quem chamou é administrador.
const mestre = createClient(URL_SUPABASE, CHAVE_MESTRA, {
  auth: { persistSession: false, autoRefreshToken: false },
});

class ErroHttp extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function cabecalhosCors(origem: string | null): Record<string, string> {
  const permitido = origem && ORIGENS_PERMITIDAS.includes(origem) ? origem : ORIGENS_PERMITIDAS[0];
  return {
    "Access-Control-Allow-Origin": permitido,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function responder(corpo: unknown, status: number, origem: string | null) {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { ...cabecalhosCors(origem), "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// Senha temporária forte: 16 caracteres com maiúsculas, minúsculas,
// números e símbolos, sorteados com gerador criptográfico.
function senhaTemporaria(): string {
  const grupos = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "#$%&*+-=?@"];
  const todos = grupos.join("");
  const sorteio = (n: number) => crypto.getRandomValues(new Uint32Array(n));
  const chars = grupos.map((g, i) => g[sorteio(4)[i] % g.length]);
  for (const r of sorteio(12)) chars.push(todos[r % todos.length]);
  // embaralha (Fisher-Yates)
  const r = sorteio(chars.length);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = r[i] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

function texto(v: unknown, campo: string, min: number, max: number): string {
  if (typeof v !== "string") throw new ErroHttp(400, `Informe ${campo}.`);
  const s = v.trim();
  if (s.length < min || s.length > max) throw new ErroHttp(400, `${campo} deve ter entre ${min} e ${max} caracteres.`);
  return s;
}
function papel(v: unknown): string {
  if (typeof v !== "string" || !PAPEIS.includes(v)) throw new ErroHttp(400, "Perfil inválido.");
  return v;
}
function idUsuario(v: unknown): string {
  if (typeof v !== "string" || !/^[0-9a-f-]{36}$/i.test(v)) throw new ErroHttp(400, "Usuário inválido.");
  return v;
}

// Confirma quem está chamando: precisa estar logado, ativo, com a senha
// já trocada e com perfil admin.
async function exigirAdmin(req: Request) {
  const token = req.headers.get("Authorization") ?? "";
  if (!token.startsWith("Bearer ")) throw new ErroHttp(401, "Sessão expirada. Entre novamente.");
  // Confere o token da sessão diretamente no Supabase Auth
  const { data, error } = await mestre.auth.getUser(token.slice(7));
  if (error || !data.user) throw new ErroHttp(401, "Sessão expirada. Entre novamente.");
  const { data: perfil } = await mestre.from("profiles")
    .select("id, email, role, active, must_change_password").eq("id", data.user.id).single();
  if (!perfil || !perfil.active || perfil.must_change_password || perfil.role !== "admin") {
    throw new ErroHttp(403, "Você não tem permissão para esta ação.");
  }
  return perfil as { id: string; email: string };
}

async function auditar(admin: { id: string; email: string }, req: Request, action: string, alvo: string, details: unknown) {
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || null;
  await mestre.from("audit_log").insert({
    user_id: admin.id, user_email: admin.email, action, entity: "user", entity_id: alvo, ip, details,
  });
}

async function perfilDe(userId: string) {
  const { data } = await mestre.from("profiles").select("id, email, role, active").eq("id", userId).single();
  if (!data) throw new ErroHttp(404, "Usuário não encontrado.");
  return data;
}

Deno.serve(async (req) => {
  const origem = req.headers.get("Origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: cabecalhosCors(origem) });
  if (req.method !== "POST") return responder({ error: "Método não permitido." }, 405, origem);

  try {
    const admin = await exigirAdmin(req);
    const corpo = await req.json().catch(() => ({}));
    const acao = corpo?.acao;

    if (acao === "criar") {
      const email = texto(corpo.email, "o e-mail", 5, 200).toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ErroHttp(400, "E-mail inválido.");
      const name = texto(corpo.name, "o nome", 2, 120);
      const role = papel(corpo.role);
      const temp = senhaTemporaria();
      const { data, error } = await mestre.auth.admin.createUser({
        email, password: temp, email_confirm: true,
        user_metadata: { name },
        app_metadata: { role }, // só o servidor define o perfil
      });
      if (error) {
        if (/already|registered|exists/i.test(error.message)) throw new ErroHttp(409, "Já existe um usuário com este e-mail.");
        throw new ErroHttp(400, "Não foi possível criar o usuário.");
      }
      await auditar(admin, req, "usuario.criado", data.user.id, { email, role });
      return responder({ id: data.user.id, temporaryPassword: temp }, 201, origem);
    }

    if (acao === "redefinir_senha") {
      const userId = idUsuario(corpo.userId);
      await perfilDe(userId);
      const temp = senhaTemporaria();
      const { error } = await mestre.auth.admin.updateUserById(userId, { password: temp });
      if (error) throw new ErroHttp(400, "Não foi possível redefinir a senha.");
      // Até trocar a nova senha, as regras do banco bloqueiam o acesso aos dados.
      await mestre.from("profiles").update({ must_change_password: true }).eq("id", userId);
      await auditar(admin, req, "usuario.senha_redefinida", userId, null);
      return responder({ ok: true, temporaryPassword: temp }, 200, origem);
    }

    if (acao === "alterar") {
      const userId = idUsuario(corpo.userId);
      const alvo = await perfilDe(userId);
      const mudancas: Record<string, string> = {};
      if (corpo.name !== undefined) mudancas.name = texto(corpo.name, "o nome", 2, 120);
      if (corpo.role !== undefined) mudancas.role = papel(corpo.role);
      if (!Object.keys(mudancas).length) throw new ErroHttp(400, "Nada para alterar.");
      if (userId === admin.id && mudancas.role && mudancas.role !== "admin") {
        throw new ErroHttp(400, "Você não pode desativar ou rebaixar a própria conta.");
      }
      await mestre.from("profiles").update(mudancas).eq("id", userId);
      if (mudancas.role) {
        await mestre.auth.admin.updateUserById(userId, { app_metadata: { role: mudancas.role } });
      }
      await auditar(admin, req, "usuario.alterado", userId, { email: alvo.email, ...mudancas });
      return responder({ ok: true }, 200, origem);
    }

    if (acao === "desativar" || acao === "ativar") {
      const userId = idUsuario(corpo.userId);
      const alvo = await perfilDe(userId);
      const ativar = acao === "ativar";
      if (userId === admin.id && !ativar) throw new ErroHttp(400, "Você não pode desativar ou rebaixar a própria conta.");
      // Bloqueia (ou libera) o login no Supabase Auth...
      const { error } = await mestre.auth.admin.updateUserById(userId, {
        ban_duration: ativar ? "none" : BLOQUEIO_PERMANENTE,
      });
      if (error) throw new ErroHttp(400, "Não foi possível alterar o acesso.");
      // ...e o acesso aos dados (as regras do banco checam "active").
      await mestre.from("profiles").update({ active: ativar }).eq("id", userId);
      await auditar(admin, req, ativar ? "usuario.ativado" : "usuario.desativado", userId, { email: alvo.email });
      return responder({ ok: true }, 200, origem);
    }

    throw new ErroHttp(400, "Ação inválida.");
  } catch (e) {
    if (e instanceof ErroHttp) return responder({ error: e.message }, e.status, origem);
    console.error("admin-usuarios:", e instanceof Error ? e.message : e); // sem dados sensíveis
    return responder({ error: "Erro interno. Tente novamente." }, 500, origem);
  }
});
