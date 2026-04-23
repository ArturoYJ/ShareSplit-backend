const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // In production, enable SSL with a verified certificate:
  // ssl: { rejectUnauthorized: true }
  // Never use rejectUnauthorized: false in production — it disables certificate validation.
});

pool.on('error', (err) => {
  console.error('[DB] Error inesperado en cliente idle:', err.message);
  process.exit(-1);
});

module.exports = pool;
