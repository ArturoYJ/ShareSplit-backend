const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // En producción usa SSL:
  // ssl: { rejectUnauthorized: false }
});

pool.on('error', (err) => {
  console.error('[DB] Error inesperado en cliente idle:', err.message);
  process.exit(-1);
});

module.exports = pool;
