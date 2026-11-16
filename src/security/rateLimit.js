'use strict';
// Limitador por janela deslizante em memória (adequado para uma instância).
// Para várias instâncias, troque por Redis.
function rateLimit({ windowMs, max, keyFn = (req) => req.ip, message = 'Muitas requisições. Tente novamente em alguns minutos.' }) {
  const hits = new Map();
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [k, arr] of hits) {
      while (arr.length && arr[0] < cutoff) arr.shift();
      if (!arr.length) hits.delete(k);
    }
  }, Math.min(windowMs, 60000)).unref();

  return (req, res, next) => {
    const key = keyFn(req);
    const now = Date.now();
    const arr = hits.get(key) || [];
    while (arr.length && arr[0] < now - windowMs) arr.shift();
    if (arr.length >= max) {
      res.set('Retry-After', String(Math.ceil((arr[0] + windowMs - now) / 1000)));
      return res.status(429).json({ error: message });
    }
    arr.push(now);
    hits.set(key, arr);
    return next();
  };
}

module.exports = { rateLimit };
