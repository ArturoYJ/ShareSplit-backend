require('dotenv').config();

// ── 3.3 Validación temprana de variables de entorno críticas ─────────────────────
(function validateEnv() {
  const jwtSecret = process.env.JWT_SECRET || '';
  if (!jwtSecret || jwtSecret.length < 32) {
    console.error(
      '\u274C  [FATAL] JWT_SECRET no está configurado o tiene menos de 32 caracteres.',
      '\n         Configura JWT_SECRET en backend/.env antes de iniciar.'
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

function resolveCorsOrigins() {
  const configured = process.env.CORS_ORIGIN || 'http://localhost:3000';
  return configured
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

const allowedOrigins = resolveCorsOrigins();

app.set('trust proxy', process.env.TRUST_PROXY === '1');

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error('Origin no permitido por CORS'));
    },
    credentials: true,
  })
);

app.use(express.json({ limit: '500kb' }));
// extended: false — this is a JSON API; the qs parser is unnecessary
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());



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
    console.log(`[ShareSplit API] Servidor corriendo en http://localhost:${PORT}`);
    console.log(`[ShareSplit API] Entorno: ${process.env.NODE_ENV || 'development'}`);
  });
}

module.exports = app;
