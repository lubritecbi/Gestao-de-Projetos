// Endereço e chave PÚBLICA do projeto no Supabase.
// Onde achar: Supabase > Project Settings > API (ou "Data API" / "API Keys").
//   url:   "Project URL"            (ex.: https://abcdefghijkl.supabase.co)
//   chave: "anon public" ou "publishable" (começa com eyJ... ou sb_publishable_...)
// Esta chave PODE ficar no GitHub: ela só faz o que as regras do banco (RLS) permitem.
// NUNCA coloque aqui a chave "service_role" ou "secret".
window.GP_CONFIG = {
  url: 'https://pzoflktbghricjjriirt.supabase.co',
  chave: 'sb_publishable_2rptTww-EbywFBgD2vPD3w_hTZMuCzW',
  // Sai automaticamente após este tempo sem uso (mesma regra do sistema original)
  minutosInatividade: 30,
};
