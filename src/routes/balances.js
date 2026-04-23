const express = require('express');
const router = express.Router({ mergeParams: true });
const { body, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');
const { computeBalancesAndDebts, toCents } = require('../utils/finance');
const { sendError } = require('../utils/http');

// Rate limiter exclusivo para operaciones de pago
const paymentsLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_PAYMENTS_MAX || 80),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) =>
    sendError(res, 429, 'Límite de operaciones de pago excedido', 'PAYMENT_RATE_LIMIT_EXCEEDED'),
});

router.use(authenticate);

function handleValidationErrors(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    sendError(res, 422, 'Error de validación', 'VALIDATION_ERROR', errors.array());
    return true;
  }
  return false;
}

async function requireMembership(groupId, userId, res) {
  const r = await pool.query(
    'SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2',
    [groupId, userId]
  );
  if (r.rows.length === 0) {
    sendError(res, 403, 'No tienes acceso a este grupo', 'FORBIDDEN_GROUP_ACCESS');
    return null;
  }
  return r.rows[0].role;
}

async function requireOwner(groupId, userId, res) {
  const role = await requireMembership(groupId, userId, res);
  if (!role) return false;
  if (role !== 'owner') {
    sendError(res, 403, 'Solo el owner puede realizar esta acción', 'FORBIDDEN_OWNER_ONLY');
    return false;
  }
  return true;
}

router.get('/balances', async (req, res) => {
  const { groupId } = req.params;
  const userId = req.user.id;

  const role = await requireMembership(groupId, userId, res);
  if (!role) return;

  try {
    const { balances, debts } = await computeBalancesAndDebts(pool, groupId);
    res.json({ balances, debts });
  } catch (err) {
    console.error('[balances/get]', err.message);
    sendError(res, 500, 'Error al calcular balances', 'BALANCES_CALCULATION_ERROR');
  }
});

router.post(
  '/payments',
  paymentsLimiter,
  [
    body('to_user_id').isUUID().withMessage('to_user_id debe ser un UUID válido'),
    body('amount').isFloat({ gt: 0 }).withMessage('El monto debe ser mayor a 0'),
    body('note').optional().trim(),
  ],
  async (req, res) => {
    if (handleValidationErrors(req, res)) return;

    const { groupId } = req.params;
    const fromUserId = req.user.id;
    const { to_user_id, amount, note } = req.body;

    if (fromUserId === to_user_id) {
      return sendError(res, 400, 'No puedes pagarte a ti mismo', 'INVALID_SELF_PAYMENT');
    }

    const role = await requireMembership(groupId, fromUserId, res);
    if (!role) return;

    const amountCents = toCents(amount);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        [`payment:${groupId}:${fromUserId}:${to_user_id}`]
      );

      const toMember = await client.query(
        'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
        [groupId, to_user_id]
      );
      if (toMember.rows.length === 0) {
        await client.query('ROLLBACK');
        return sendError(res, 400, 'El destinatario no es miembro del grupo', 'INVALID_PAYMENT_TARGET');
      }

      const { debtsByPair } = await computeBalancesAndDebts(client, groupId);
      const currentDebtCents = debtsByPair.get(`${fromUserId}:${to_user_id}`) || 0;

      if (currentDebtCents <= 0) {
        await client.query('ROLLBACK');
        return sendError(
          res,
          409,
          'No existe deuda pendiente entre estos usuarios',
          'NO_ACTIVE_DEBT',
          { current_debt: 0 }
        );
      }

      if (amountCents > currentDebtCents) {
        await client.query('ROLLBACK');
        return sendError(
          res,
          409,
          'El monto excede la deuda pendiente',
          'OVERPAYMENT_NOT_ALLOWED',
          {
            requested_amount: Number(amount),
            current_debt: Number((currentDebtCents / 100).toFixed(2)),
          }
        );
      }

      const result = await client.query(
        `INSERT INTO payments (group_id, from_user_id, to_user_id, amount, note)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [groupId, fromUserId, to_user_id, Number(amount).toFixed(2), note]
      );

      await client.query('COMMIT');
      res.status(201).json({ payment: result.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[balances/payment]', err.message);
      sendError(res, 500, 'Error al registrar el pago', 'PAYMENT_REGISTRATION_ERROR');
    } finally {
      client.release();
    }
  }
);

router.get('/payments', paymentsLimiter, async (req, res) => {
  const { groupId } = req.params;
  const userId = req.user.id;

  const role = await requireMembership(groupId, userId, res);
  if (!role) return;

  const page  = Math.max(1, parseInt(req.query.page)  || 1);
  const limit = Math.min(50, parseInt(req.query.limit) || 20);
  const offset = (page - 1) * limit;

  try {
    const [countResult, dataResult] = await Promise.all([
      pool.query(
        `SELECT COUNT(*) AS total FROM payments WHERE group_id = $1`,
        [groupId]
      ),
      pool.query(
        `SELECT
           p.*,
           uf.name AS from_name,
           ut.name AS to_name
         FROM payments p
         JOIN users uf ON uf.id = p.from_user_id
         JOIN users ut ON ut.id = p.to_user_id
         WHERE p.group_id = $1
         ORDER BY p.paid_at DESC
         LIMIT $2 OFFSET $3`,
        [groupId, limit, offset]
      ),
    ]);

    res.json({
      payments: dataResult.rows,
      total: Number(countResult.rows[0].total),
      page,
      limit,
    });
  } catch (err) {
    console.error('[balances/payments-list]', err.message);
    sendError(res, 500, 'Error al obtener historial de pagos', 'PAYMENTS_LIST_ERROR');
  }
});

router.post('/settle-all', async (req, res) => {
  const { groupId } = req.params;
  const userId = req.user.id;

  const isOwner = await requireOwner(groupId, userId, res);
  if (!isOwner) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const unclaimedItemsResult = await client.query(
      `SELECT
         e.id AS expense_id,
         e.title AS expense_title,
         ei.id AS item_id,
         ei.name AS item_name,
         (ei.unit_price * ei.quantity) AS total_price
       FROM expenses e
       JOIN expense_items ei ON ei.expense_id = e.id
       LEFT JOIN item_claims ic ON ic.item_id = ei.id
       WHERE e.group_id = $1
         AND e.status = 'open'
       GROUP BY e.id, e.title, ei.id
       HAVING COUNT(ic.user_id) = 0
       ORDER BY e.created_at DESC, ei.name ASC
       LIMIT 30`,
      [groupId]
    );

    if (unclaimedItemsResult.rows.length > 0) {
      await client.query('ROLLBACK');
      return sendError(
        res,
        409,
        'No se pueden liquidar los gastos: existen ítems sin reclamar',
        'UNCLAIMED_ITEMS_BLOCK_SETTLEMENT',
        {
          unclaimed_items: unclaimedItemsResult.rows.map((row) => ({
            expense_id: row.expense_id,
            expense_title: row.expense_title,
            item_id: row.item_id,
            item_name: row.item_name,
            total_price: Number(row.total_price).toFixed(2),
          })),
        }
      );
    }

    const result = await client.query(
      `UPDATE expenses SET status = 'settled'
       WHERE group_id = $1 AND status = 'open'
       RETURNING id`,
      [groupId]
    );

    await client.query('COMMIT');
    res.json({
      message: `${result.rowCount} gasto(s) liquidado(s)`,
      settled_count: result.rowCount,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[balances/settle-all]', err.message);
    sendError(res, 500, 'Error al liquidar gastos', 'SETTLE_ALL_ERROR');
  } finally {
    client.release();
  }
});

module.exports = router;
