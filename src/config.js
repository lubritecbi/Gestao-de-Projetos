'use strict';
// Configuração central. Tudo vem de variáveis de ambiente (ver .env.example).
const path = require('path');

function int(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`Variável ${name} inválida`);
  return n;
}
function bool(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'sim'].includes(v.toLowerCase());
}

const isProd = process.env.NODE_ENV === 'production';

const config = {
  isProd,
  port: int('PORT', 3000),
  host: process.env.HOST || '127.0.0.1',
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'gestao.db'),
  // Atrás de proxy reverso (Nginx/IIS/Traefik) com HTTPS, informe o nº de saltos (normalmente 1).
  trustProxy: int('TRUST_PROXY', 0),
  // Em produção o cookie SEMPRE é Secure (exige HTTPS).
  cookieSecure: isProd ? true : bool('COOKIE_SECURE', false),
  sessionIdleMinutes: int('SESSION_IDLE_MINUTES', 30),
  sessionAbsoluteHours: int('SESSION_ABSOLUTE_HOURS', 10),
  maxFailedLogins: int('MAX_FAILED_LOGINS', 5),
  lockoutMinutes: int('LOCKOUT_MINUTES', 15),
  passwordMinLength: int('PASSWORD_MIN_LENGTH', 12),
  passwordMaxAgeDays: int('PASSWORD_MAX_AGE_DAYS', 0), // 0 = sem expiração (recomendação NIST 800-63B)
  auditRetentionDays: int('AUDIT_RETENTION_DAYS', 365),
};

if (isProd && config.host === '0.0.0.0' && config.trustProxy === 0) {
  // Aviso: em produção o app deve ficar atrás de um proxy com TLS.
  console.warn('[aviso] Produção ouvindo em 0.0.0.0 sem TRUST_PROXY: use um proxy reverso com HTTPS.');
}

module.exports = config;
