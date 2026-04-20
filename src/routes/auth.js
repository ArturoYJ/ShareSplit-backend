const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const pool = require('../db/pool');

// ── Helpers ──────────────────────────────────────────────────────────────────

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, name: user.name },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

function handleValidationErrors(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(422).json({ errors: errors.array() });
    return true;
  }
  return false;
}

// ── POST /auth/register ───────────────────────────────────────────────────────

router.post(
  '/register',
  [
    body('name').trim().notEmpty().withMessage('El nombre es requerido'),
    body('email').isEmail().normalizeEmail().withMessage('Email inválido'),
    body('password')
      .isLength({ min: 6 })
      .withMessage('La contraseña debe tener al menos 6 caracteres'),
  ],
  async (req, res) => {
    if (handleValidationErrors(req, res)) return;

    const { name, email, password } = req.body;

    try {
      // Verificar si ya existe
      const existing = await pool.query(
        'SELECT id FROM users WHERE email = $1',
        [email]
      );
      if (existing.rows.length > 0) {
        return res.status(409).json({ error: 'El email ya está registrado' });
      }

      // Hash de la contraseña
      const hash = await bcrypt.hash(password, 12);

      // Insertar usuario
      const result = await pool.query(
        `INSERT INTO users (name, email, password)
         VALUES ($1, $2, $3)
         RETURNING id, name, email, created_at`,
        [name, email, hash]
      );

      const user = result.rows[0];
      const token = signToken(user);

      res.status(201).json({
        message: 'Usuario creado exitosamente',
        token,
        user: { id: user.id, name: user.name, email: user.email },
      });
    } catch (err) {
      console.error('[auth/register]', err.message);
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  }
);

// ── POST /auth/login ──────────────────────────────────────────────────────────

router.post(
  '/login',
  [
    body('email').isEmail().normalizeEmail().withMessage('Email inválido'),
    body('password').notEmpty().withMessage('La contraseña es requerida'),
  ],
  async (req, res) => {
    if (handleValidationErrors(req, res)) return;

    const { email, password } = req.body;

    try {
      const result = await pool.query(
        'SELECT id, name, email, password FROM users WHERE email = $1',
        [email]
      );

      const user = result.rows[0];

      if (!user) {
        return res.status(401).json({ error: 'Credenciales inválidas' });
      }

      const valid = await bcrypt.compare(password, user.password);
      if (!valid) {
        return res.status(401).json({ error: 'Credenciales inválidas' });
      }

      const token = signToken(user);

      res.json({
        token,
        user: { id: user.id, name: user.name, email: user.email },
      });
    } catch (err) {
      console.error('[auth/login]', err.message);
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  }
);

// ── GET /auth/me ──────────────────────────────────────────────────────────────

const { authenticate } = require('../middleware/auth');

router.get('/me', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, email, avatar_url, created_at FROM users WHERE id = $1',
      [req.user.id]
    );
    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error('[auth/me]', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

module.exports = router;
