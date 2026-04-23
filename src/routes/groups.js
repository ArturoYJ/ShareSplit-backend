const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');
const { computeBalancesAndDebts } = require('../utils/finance');
const { sendError } = require('../utils/http');

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
      sendError(res, 500, 'Error al crear el grupo', 'GROUP_CREATE_ERROR');
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
        return sendError(res, 404, 'Código de invitación inválido', 'GROUP_NOT_FOUND');
      }

      const group = groupResult.rows[0];

      // Verificar si ya es miembro
      const memberCheck = await pool.query(
        'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
        [group.id, userId]
      );

      if (memberCheck.rows.length > 0) {
        return sendError(res, 409, 'Ya eres miembro de este grupo', 'GROUP_ALREADY_MEMBER');
      }

      await pool.query(
        `INSERT INTO group_members (group_id, user_id, role)
         VALUES ($1, $2, 'member')`,
        [group.id, userId]
      );

      res.json({ message: 'Te uniste al grupo exitosamente', group });
    } catch (err) {
      console.error('[groups/join]', err.message);
      sendError(res, 500, 'Error al unirse al grupo', 'GROUP_JOIN_ERROR');
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
    sendError(res, 500, 'Error al obtener grupos', 'GROUP_LIST_ERROR');
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
      return sendError(res, 403, 'No tienes acceso a este grupo', 'GROUP_FORBIDDEN');
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
      return sendError(res, 404, 'Grupo no encontrado', 'GROUP_NOT_FOUND');
    }

    res.json({ group: groupResult.rows[0], members: membersResult.rows });
  } catch (err) {
    console.error('[groups/get]', err.message);
    sendError(res, 500, 'Error al obtener el grupo', 'GROUP_GET_ERROR');
  }
});

// ── DELETE /groups/:id — Eliminar grupo ───────────────────────────────────────

router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;

  try {
    const memberCheck = await pool.query(
      'SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2',
      [id, userId]
    );

    if (memberCheck.rows.length === 0) {
      return sendError(res, 403, 'No tienes acceso a este grupo', 'GROUP_FORBIDDEN');
    }

    if (memberCheck.rows[0].role !== 'owner') {
      return sendError(res, 403, 'Solo el owner puede eliminar el grupo', 'GROUP_FORBIDDEN');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM item_claims WHERE item_id IN (SELECT ei.id FROM expense_items ei JOIN expenses e ON e.id = ei.expense_id WHERE e.group_id = $1)', [id]);
      await client.query('DELETE FROM expense_items WHERE expense_id IN (SELECT id FROM expenses WHERE group_id = $1)', [id]);
      await client.query('DELETE FROM expenses WHERE group_id = $1', [id]);
      await client.query('DELETE FROM payments WHERE group_id = $1', [id]);
      await client.query('DELETE FROM group_members WHERE group_id = $1', [id]);
      await client.query('DELETE FROM groups WHERE id = $1', [id]);
      await client.query('COMMIT');

      res.json({ message: 'Grupo eliminado' });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[groups/delete]', err.message);
      sendError(res, 500, 'Error al eliminar el grupo', 'GROUP_DELETE_ERROR');
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[groups/delete]', err.message);
    sendError(res, 500, 'Error al eliminar el grupo', 'GROUP_DELETE_ERROR');
  }
});

// ── DELETE /groups/:id/members/:userId — Expulsar miembro ───────────────────────

router.delete('/:id/members/:userId', async (req, res) => {
  const { id, userId } = req.params;
  const currentUserId = req.user.id;

  try {
    const currentMember = await pool.query(
      'SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2',
      [id, currentUserId]
    );

    if (currentMember.rows.length === 0) {
      return sendError(res, 403, 'No tienes acceso a este grupo', 'GROUP_FORBIDDEN');
    }

    if (currentMember.rows[0].role !== 'owner') {
      return sendError(res, 403, 'Solo el owner puede expulsar miembros', 'GROUP_FORBIDDEN');
    }

    const targetMember = await pool.query(
      'SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2',
      [id, userId]
    );

    if (targetMember.rows.length === 0) {
      return sendError(res, 404, 'Miembro no encontrado', 'GROUP_MEMBER_NOT_FOUND');
    }

    if (targetMember.rows[0].role === 'owner') {
      return sendError(res, 400, 'No puedes expulsar al owner del grupo', 'GROUP_CANNOT_REMOVE_OWNER');
    }

    await pool.query(
      'DELETE FROM group_members WHERE group_id = $1 AND user_id = $2',
      [id, userId]
    );

    res.json({ message: 'Miembro expulsado' });
  } catch (err) {
    console.error('[groups/remove-member]', err.message);
    sendError(res, 500, 'Error al expulsar miembro', 'GROUP_REMOVE_MEMBER_ERROR');
  }
});

// ── DELETE /groups/:id/members/:userId/leave — Abandonar grupo ────────────��───

router.delete('/:id/members/:userId/leave', async (req, res) => {
  const { id, userId } = req.params;
  const currentUserId = req.user.id;

  if (currentUserId !== userId) {
    return sendError(res, 403, 'No puedes abandonar el grupo en nombre de otro usuario', 'GROUP_FORBIDDEN');
  }

  try {
    const memberCheck = await pool.query(
      'SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2',
      [id, userId]
    );

    if (memberCheck.rows.length === 0) {
      return sendError(res, 404, 'No eres miembro de este grupo', 'GROUP_MEMBER_NOT_FOUND');
    }

    if (memberCheck.rows[0].role === 'owner') {
      return sendError(res, 400, 'El owner no puede abandonar el grupo. Transfiere ownership o elimina el grupo.', 'GROUP_OWNER_CANNOT_LEAVE');
    }

    const { balances } = await computeBalancesAndDebts(pool, id);
    const myBalance = balances.find((b) => b.user_id === userId);
    if (myBalance && Math.abs(myBalance.net_balance) > 0.009) {
      return res.status(409).json({
        error: 'No puedes abandonar el grupo con saldo pendiente. Liquida primero tus deudas.',
        code: 'CANNOT_LEAVE_WITH_PENDING_BALANCE',
        details: { net_balance: myBalance.net_balance },
      });
    }

    await pool.query(
      'DELETE FROM group_members WHERE group_id = $1 AND user_id = $2',
      [id, userId]
    );

    res.json({ message: 'Has abandonado el grupo' });
  } catch (err) {
    console.error('[groups/leave]', err.message);
    sendError(res, 500, 'Error al abandonar el grupo', 'GROUP_LEAVE_ERROR');
  }
});

// ── PATCH /groups/:id/transfer-owner — Transferir ownership ─────────────────────

router.patch(
  '/:id/transfer-owner',
  [body('new_owner_id').isUUID().withMessage('new_owner_id debe ser un UUID válido')],
  async (req, res) => {
    if (handleValidationErrors(req, res)) return;

    const { id } = req.params;
    const currentUserId = req.user.id;
    const { new_owner_id } = req.body;

    try {
      const currentMember = await pool.query(
        'SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2',
        [id, currentUserId]
      );

      if (currentMember.rows.length === 0) {
        return sendError(res, 403, 'No tienes acceso a este grupo', 'GROUP_FORBIDDEN');
      }

      if (currentMember.rows[0].role !== 'owner') {
        return sendError(res, 403, 'Solo el owner puede transferir ownership', 'GROUP_FORBIDDEN');
      }

      const targetMember = await pool.query(
        'SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2',
        [id, new_owner_id]
      );

      if (targetMember.rows.length === 0) {
        return sendError(res, 404, 'El nuevo owner no es miembro del grupo', 'GROUP_MEMBER_NOT_FOUND');
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        await client.query(
          `UPDATE group_members SET role = 'member' WHERE group_id = $1 AND user_id = $2`,
          [id, currentUserId]
        );

        await client.query(
          `UPDATE group_members SET role = 'owner' WHERE group_id = $1 AND user_id = $2`,
          [id, new_owner_id]
        );

        await client.query('COMMIT');
      } catch (txErr) {
        await client.query('ROLLBACK');
        throw txErr;
      } finally {
        client.release();
      }

      res.json({ message: 'Ownership transferido exitosamente' });
    } catch (err) {
      console.error('[groups/transfer-owner]', err.message);
      sendError(res, 500, 'Error al transferir ownership', 'GROUP_TRANSFER_ERROR');
    }
  }
);

module.exports = router;
