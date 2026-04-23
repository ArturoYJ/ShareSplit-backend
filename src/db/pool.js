const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL || '';

// SSL automático cuando el string lo pide, cuando el host es Neon, o cuando se fuerza.
// En local con Docker queda en false para no romper tu flujo de dev.
const needsSsl =
  /sslmode=require/.test(connectionString) ||
  /neon\.tech/.test(connectionString) ||
  process.env.PGSSL === '1';

const pool = new Pool({
  connectionString,
  ssl: needsSsl ? { rejectUnauthorized: true } : false,
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => {
  // Loguear y dejar que pg descarte el cliente. NO matar el proceso:
  // el autosuspend de Neon emite este evento y no debe tirar Render abajo.
  console.error('[DB] Error en cliente idle (se descartará):', err.message);
});

module.exports = pool;