const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');

// Todas las rutas requieren JWT
router.use(authenticate);

function handleValidationErrors(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(422).json({ errors: errors.array() });
    return true;
  }
  return false;
}

/** Genera un código de invitación de 8 caracteres alfanumérico en mayúsculas */
function generateInviteCode() {
  return uuidv4().replace(/-/g, '').substring(0, 8).toUpperCase();
}

// ── POST /groups — Crear grupo ────────────────────────────────────────────────

router.post(
  '/',
  [body('name').trim().notEmpty().withMessage('El nombre del grupo es requerido')],
  async (req, res) => {
    if (handleValidationErrors(req, res)) return;

    const { name } = req.body;
    const userId = req.user.id;

    // Generar código único (reintenta si colisiona)
    let invite_code;
    let attempts = 0;
    do {
      invite_code = generateInviteCode();
      const exists = await pool.query(
        'SELECT id FROM groups WHERE invite_code = $1',
        [invite_code]
      );
      if (exists.rows.length === 0) break;
      attempts++;
    } while (attempts < 5);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const groupResult = await client.query(
        `INSERT INTO groups (name, invite_code, created_by)
         VALUES ($1, $2, $3)
         RETURNING id, name, invite_code, created_at`,
        [name, invite_code, userId]
      );
      const group = groupResult.rows[0];

      // El creador se une como 'owner'
      await client.query(
        `INSERT INTO group_members (group_id, user_id, role)
         VALUES ($1, $2, 'owner')`,
        [group.id, userId]
      );

      await client.query('COMMIT');
      res.status(201).json({ group });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[groups/create]', err.message);
      res.status(500).json({ error: 'Error al crear el grupo' });
    } finally {
      client.release();
    }
  }
);

// ── POST /groups/join — Unirse con código ────────────────────────────────────

router.post(
  '/join',
  [body('invite_code').trim().notEmpty().withMessage('El código de invitación es requerido')],
  async (req, res) => {
    if (handleValidationErrors(req, res)) return;

    const { invite_code } = req.body;
    const userId = req.user.id;

    try {
      const groupResult = await pool.query(
        'SELECT id, name, invite_code FROM groups WHERE invite_code = $1',
        [invite_code.toUpperCase()]
      );

      if (groupResult.rows.length === 0) {
        return res.status(404).json({ error: 'Código de invitación inválido' });
      }

      const group = groupResult.rows[0];

      // Verificar si ya es miembro
      const memberCheck = await pool.query(
        'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
        [group.id, userId]
      );

      if (memberCheck.rows.length > 0) {
        return res.status(409).json({ error: 'Ya eres miembro de este grupo' });
      }

      await pool.query(
        `INSERT INTO group_members (group_id, user_id, role)
         VALUES ($1, $2, 'member')`,
        [group.id, userId]
      );

      res.json({ message: 'Te uniste al grupo exitosamente', group });
    } catch (err) {
      console.error('[groups/join]', err.message);
      res.status(500).json({ error: 'Error al unirse al grupo' });
    }
  }
);

// ── GET /groups — Listar grupos del usuario ───────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT g.id, g.name, g.invite_code, g.created_at, gm.role,
              COUNT(DISTINCT gm2.user_id) AS member_count
       FROM groups g
       JOIN group_members gm  ON gm.group_id = g.id AND gm.user_id = $1
       JOIN group_members gm2 ON gm2.group_id = g.id
       GROUP BY g.id, g.name, g.invite_code, g.created_at, gm.role
       ORDER BY g.created_at DESC`,
      [req.user.id]
    );
    res.json({ groups: result.rows });
  } catch (err) {
    console.error('[groups/list]', err.message);
    res.status(500).json({ error: 'Error al obtener grupos' });
  }
});

// ── GET /groups/:id — Detalle de grupo ───────────────────────────────────────

router.get('/:id', async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;

  try {
    // Verificar membresía
    const memberCheck = await pool.query(
      'SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2',
      [id, userId]
    );
    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'No tienes acceso a este grupo' });
    }

    const [groupResult, membersResult] = await Promise.all([
      pool.query('SELECT id, name, invite_code, created_at FROM groups WHERE id = $1', [id]),
      pool.query(
        `SELECT u.id, u.name, u.email, u.avatar_url, gm.role, gm.joined_at
         FROM users u
         JOIN group_members gm ON gm.user_id = u.id
         WHERE gm.group_id = $1
         ORDER BY gm.joined_at ASC`,
        [id]
      ),
    ]);

    if (groupResult.rows.length === 0) {
      return res.status(404).json({ error: 'Grupo no encontrado' });
    }

    res.json({ group: groupResult.rows[0], members: membersResult.rows });
  } catch (err) {
    console.error('[groups/get]', err.message);
    res.status(500).json({ error: 'Error al obtener el grupo' });
  }
});

module.exports = router;
