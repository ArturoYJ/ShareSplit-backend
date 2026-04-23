const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');
const { sendError } = require('../utils/http');

// ── Helpers ──────────────────────────────────────────────────────────────────

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, name: user.name },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

/**
 * Emite la cookie httpOnly ss_token.
 * - httpOnly: no accesible por JS en el navegador (previene XSS)
 * - secure: solo HTTPS en producción
 * - sameSite: 'lax' bloquea CSRF en navegadores modernos
 * - maxAge: igual al TTL del JWT (7 días por defecto)
 */
function setAuthCookie(res, token) {
  const isProd = process.env.NODE_ENV === 'production';
  // parseInt('7d', 10) returns NaN — strip non-numeric chars before parsing
  const expiresIn = process.env.JWT_EXPIRES_IN || '7d';
  const maxAgeDays = parseInt(expiresIn.replace(/[^0-9]/g, ''), 10) || 7;
  res.cookie('ss_token', token, {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    maxAge: maxAgeDays * 24 * 60 * 60 * 1000,
    path: '/',
  });
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
        return sendError(res, 409, 'El email ya está registrado', 'AUTH_EMAIL_EXISTS');
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

      setAuthCookie(res, token);

      res.status(201).json({
        message: 'Usuario creado exitosamente',
        token,
        user: { id: user.id, name: user.name, email: user.email },
      });
    } catch (err) {
      console.error('[auth/register]', err.message);
      sendError(res, 500, 'Error interno del servidor', 'INTERNAL_ERROR');
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
        return sendError(res, 401, 'Credenciales inválidas', 'AUTH_INVALID_CREDENTIALS');
      }

      const valid = await bcrypt.compare(password, user.password);
      if (!valid) {
        return sendError(res, 401, 'Credenciales inválidas', 'AUTH_INVALID_CREDENTIALS');
      }

      const token = signToken(user);

      setAuthCookie(res, token);

      res.json({
        token,
        user: { id: user.id, name: user.name, email: user.email },
      });
    } catch (err) {
      console.error('[auth/login]', err.message);
      sendError(res, 500, 'Error interno del servidor', 'INTERNAL_ERROR');
    }
  }
);

// ── GET /auth/me ──────────────────────────────────────────────────────────────

router.get('/me', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, email, avatar_url, created_at FROM users WHERE id = $1',
      [req.user.id]
    );
    if (!result.rows[0]) {
      return sendError(res, 404, 'Usuario no encontrado', 'AUTH_USER_NOT_FOUND');
    }
    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error('[auth/me]', err.message);
    sendError(res, 500, 'Error interno del servidor', 'INTERNAL_ERROR');
  }
});

// ── POST /auth/logout — Cierra sesión (limpia cookie) ─────────────────────────

router.post('/logout', (_req, res) => {
  const isProd = process.env.NODE_ENV === 'production';
  // Attributes must match those used in setAuthCookie; otherwise browsers ignore clearCookie
  res.clearCookie('ss_token', {
    path: '/',
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
  });
  res.json({ message: 'Sesión cerrada' });
});

// ── PATCH /auth/me — Actualizar perfil ───────────────────────────────────────

router.patch(
  '/me',
  authenticate,
  [
    body('name')
      .optional()
      .trim()
      .notEmpty()
      .withMessage('El nombre no puede estar vacío'),
    body('email')
      .optional()
      .isEmail()
      .normalizeEmail()
      .withMessage('Email inválido'),
    body('avatar_url')
      .optional({ nullable: true })
      .isURL()
      .withMessage('La URL del avatar no es válida'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({ errors: errors.array() });
    }

    const { name, email, avatar_url } = req.body;
    const userId = req.user.id;

    // Si no viene ningún campo, nada que actualizar
    if (name === undefined && email === undefined && avatar_url === undefined) {
      return sendError(res, 400, 'Debes enviar al menos un campo para actualizar', 'NO_FIELDS_PROVIDED');
    }

    try {
      // Verificar unicidad de email si se va a cambiar
      if (email) {
        const emailCheck = await pool.query(
          'SELECT id FROM users WHERE email = $1 AND id != $2',
          [email, userId]
        );
        if (emailCheck.rows.length > 0) {
          return sendError(res, 409, 'Ese email ya está en uso por otra cuenta', 'AUTH_EMAIL_EXISTS');
        }
      }

      const result = await pool.query(
        `UPDATE users
         SET
           name       = COALESCE($1, name),
           email      = COALESCE($2, email),
           avatar_url = COALESCE($3, avatar_url),
           updated_at = NOW()
         WHERE id = $4
         RETURNING id, name, email, avatar_url, created_at`,
        [name ?? null, email ?? null, avatar_url ?? null, userId]
      );

      res.json({ user: result.rows[0] });
    } catch (err) {
      console.error('[auth/patch-me]', err.message);
      sendError(res, 500, 'Error al actualizar el perfil', 'INTERNAL_ERROR');
    }
  }
);

module.exports = router;
