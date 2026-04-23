require('dotenv').config();

// ── Validación temprana de variables de entorno críticas ─────────────────────
(function validateEnv() {
  const jwtSecret = process.env.JWT_SECRET || '';
  if (!jwtSecret || jwtSecret.length < 32) {
    console.error(
      '\u274C  [FATAL] JWT_SECRET no está configurado o tiene menos de 32 caracteres.',
      '\n         Configura JWT_SECRET antes de iniciar.'
    );
    process.exit(1);
  }
  const dbUrl = process.env.DATABASE_URL || '';
  if (!dbUrl) {
    console.error('\u274C  [FATAL] DATABASE_URL no está configurada.');
    process.exit(1);
  }
  console.log('[ShareSplit API] ✅ Variables de entorno validadas');
})();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const { sendError } = require('./utils/http');

const authRouter = require('./routes/auth');
const groupsRouter = require('./routes/groups');
const expensesRouter = require('./routes/expenses');
const claimsRouter = require('./routes/claims');
const balancesRouter = require('./routes/balances');

const app = express();
const PORT = process.env.PORT || 3001;

// ── CORS: orígenes literales + regex para previews de Vercel ─────────────────
function resolveCorsOrigins() {
  return (process.env.CORS_ORIGIN || 'http://localhost:3000')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

function resolveCorsRegexes() {
  // CORS_ORIGIN_REGEX puede ser una lista coma-separada. Sin delimitadores, sin flags.
  // Ejemplo: ^https:\/\/sharesplit-frontend(-[a-z0-9-]+)?\.vercel\.app$
  return (process.env.CORS_ORIGIN_REGEX || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((src) => {
      try {
        return new RegExp(src);
      } catch (e) {
        console.warn(`[CORS] Regex inválida ignorada: ${src} (${e.message})`);
        return null;
      }
    })
    .filter(Boolean);
}

const allowedOrigins = resolveCorsOrigins();
const allowedRegexes = resolveCorsRegexes();

// Render y otros hostings corren detrás de un proxy TLS.
// Sin esto, express-rate-limit ve a todos los usuarios como el mismo IP.
app.set('trust proxy', process.env.TRUST_PROXY === '1' ? 1 : 0);

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true); // curl, healthchecks, SSR
      if (allowedOrigins.includes(origin)) return callback(null, true);
      if (allowedRegexes.some((r) => r.test(origin))) return callback(null, true);
      return callback(new Error('Origin no permitido por CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  })
);

app.use(express.json({ limit: '500kb' }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// ── Rate limiting ────────────────────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_GLOBAL_MAX || 800),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) =>
    sendError(res, 429, 'Demasiadas solicitudes, intenta más tarde', 'RATE_LIMIT_EXCEEDED'),
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_AUTH_MAX || 50),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) =>
    sendError(res, 429, 'Demasiados intentos de autenticación', 'AUTH_RATE_LIMIT_EXCEEDED'),
});

app.use('/api', globalLimiter);

// ── Rutas ────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/auth', authLimiter, authRouter);
app.use('/api/groups', groupsRouter);
app.use('/api/groups/:groupId/expenses', expensesRouter);
app.use('/api/groups/:groupId/expenses/:expenseId/items', claimsRouter);
app.use('/api/groups/:groupId', balancesRouter);

app.use((_req, res) => {
  sendError(res, 404, 'Ruta no encontrada', 'ROUTE_NOT_FOUND');
});

app.use((err, _req, res, _next) => {
  console.error('[Unhandled Error]', err);

  if (err?.message?.includes('CORS')) {
    return sendError(res, 403, 'Origen no permitido', 'CORS_FORBIDDEN');
  }

  return sendError(res, 500, 'Error interno del servidor', 'INTERNAL_SERVER_ERROR');
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[ShareSplit API] Servidor corriendo en puerto ${PORT}`);
    console.log(`[ShareSplit API] Entorno: ${process.env.NODE_ENV || 'development'}`);
  });
}

module.exports = app;