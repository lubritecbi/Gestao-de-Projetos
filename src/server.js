'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const config = require('./config');
require('./db');
const { loadSession, purgeExpiredSessions } = require('./security/session');
const { csrfProtection } = require('./security/csrf');
const { rateLimit } = require('./security/rateLimit');
const { requireAuth, requirePasswordOk, HttpError } = require('./access');
const { purgeOldAudit } = require('./audit');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy);

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      fontSrc: ["'self'"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      ...(config.cookieSecure ? { upgradeInsecureRequests: [] } : {}),
    },
  },
  strictTransportSecurity: config.cookieSecure ? { maxAge: 31536000, includeSubDomains: true } : false,
  crossOriginEmbedderPolicy: true,
  referrerPolicy: { policy: 'same-origin' },
}));
app.use((req, res, next) => {
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  req.id = crypto.randomBytes(6).toString('hex');
  next();
});

app.use(express.json({ limit: '100kb', strict: true }));
app.use(cookieParser());
app.use(loadSession);

// ---------- API ----------
const api = express.Router();
api.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
api.use(rateLimit({ windowMs: 60000, max: 600 }));
api.use('/auth', require('./routes/auth'));
api.use(requireAuth, requirePasswordOk, csrfProtection());
api.use('/users', require('./routes/users'));
api.use('/boards', require('./routes/boards').router);
api.use('/', require('./routes/items'));
api.use('/dashboard', require('./routes/dashboard'));
api.use((req, res) => res.status(404).json({ error: 'Recurso não encontrado.' }));
app.use('/api', api);

// ---------- Front-end estático ----------
const pub = path.join(__dirname, '..', 'public');
app.use(express.static(pub, { index: false, dotfiles: 'deny', maxAge: config.isProd ? '1h' : 0 }));
app.get('/login', (req, res) => res.sendFile(path.join(pub, 'login.html')));
app.get('/', (req, res) => {
  if (!req.user) return res.redirect('/login');
  if (req.user.mustChangePassword) return res.redirect('/login?trocar=1');
  return res.sendFile(path.join(pub, 'index.html'));
});
app.use((req, res) => res.status(404).type('text').send('Página não encontrada.'));

// ---------- Erros: nunca expõe detalhes internos ----------
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Conteúdo grande demais.' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido.' });
  console.error(`[erro ${req.id}]`, err);
  return res.status(500).json({ error: `Erro interno. Informe o código ${req.id} ao suporte.` });
});

// Limpeza periódica
purgeExpiredSessions(); purgeOldAudit();
setInterval(() => { purgeExpiredSessions(); purgeOldAudit(); }, 15 * 60000).unref();

if (require.main === module) {
  const server = app.listen(config.port, config.host, () => {
    console.log(`Gestão de Projetos em http://${config.host}:${config.port} (${config.isProd ? 'produção' : 'desenvolvimento'})`);
  });
  server.headersTimeout = 20000;
  server.requestTimeout = 30000;
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}

module.exports = app;
