'use strict';
// Proteção CSRF em camadas para requisições que alteram dados:
// 1) cookie SameSite=Strict; 2) exige Content-Type JSON (força preflight CORS em outra origem);
// 3) confere Origin/Referer com o host; 4) token sincronizado por sessão no cabeçalho X-CSRF-Token.
const crypto = require('crypto');

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

function sameOrigin(req) {
  const origin = req.get('origin') || req.get('referer');
  if (!origin) return true; // alguns clientes internos não enviam; as demais camadas continuam valendo
  try {
    const u = new URL(origin);
    return u.host === req.get('host');
  } catch {
    return false;
  }
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

function csrfProtection({ requireToken = true } = {}) {
  return (req, res, next) => {
    if (SAFE.has(req.method)) return next();
    if (!req.is('application/json')) return res.status(415).json({ error: 'Envie os dados como JSON.' });
    if (!sameOrigin(req)) return res.status(403).json({ error: 'Origem da requisição não permitida.' });
    if (requireToken) {
      if (!req.session || !safeEqual(req.get('x-csrf-token'), req.session.csrfToken)) {
        return res.status(403).json({ error: 'Token de segurança inválido. Recarregue a página.' });
      }
    }
    return next();
  };
}

module.exports = { csrfProtection };
