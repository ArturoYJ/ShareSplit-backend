require('dotenv').config();

const express = require('express');
const cors = require('cors');

const authRouter     = require('./routes/auth');
const groupsRouter   = require('./routes/groups');
const expensesRouter = require('./routes/expenses');
const claimsRouter   = require('./routes/claims');
const balancesRouter = require('./routes/balances');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Middleware global ─────────────────────────────────────────────────────────

app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
  credentials: true,
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Health check ──────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Rutas ─────────────────────────────────────────────────────────────────────

app.use('/api/auth', authRouter);
app.use('/api/groups', groupsRouter);

// Gastos anidados bajo grupos
app.use('/api/groups/:groupId/expenses', expensesRouter);

// Reclamos de ítems (anidados dentro de un gasto)
app.use('/api/groups/:groupId/expenses/:expenseId/items', claimsRouter);

// Balances y pagos
app.use('/api/groups/:groupId', balancesRouter);

// ── 404 ───────────────────────────────────────────────────────────────────────

app.use((_req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada' });
});

// ── Error handler global ─────────────────────────────────────────────────────

app.use((err, _req, res, _next) => {
  console.error('[Unhandled Error]', err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

// ── Arrancar servidor ─────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[ShareSplit API] Servidor corriendo en http://localhost:${PORT}`);
  console.log(`[ShareSplit API] Entorno: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
