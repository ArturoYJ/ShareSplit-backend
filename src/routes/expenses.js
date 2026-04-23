const express = require('express');
const router = express.Router({ mergeParams: true });
const { body, validationResult } = require('express-validator');
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');
const { toCents, toMoney } = require('../utils/finance');
const { auditLog } = require('../utils/logger');

router.use(authenticate);

function handleValidationErrors(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(422).json({ errors: errors.array() });
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
    res.status(403).json({ error: 'No tienes acceso a este grupo' });
    return null;
  }
  return r.rows[0].role;
}

async function requireOwner(groupId, userId, res) {
  const role = await requireMembership(groupId, userId, res);
  if (!role) return false;
  if (role !== 'owner') {
    res.status(403).json({ error: 'Solo el owner puede realizar esta acción' });
    return false;
  }
  return true;
}

async function findUnclaimedItems(expenseId) {
  const result = await pool.query(
    `SELECT
       ei.id,
       ei.name,
       (ei.unit_price * ei.quantity) AS total_price
     FROM expense_items ei
     LEFT JOIN item_claims ic ON ic.item_id = ei.id
     WHERE ei.expense_id = $1
     GROUP BY ei.id
     HAVING COUNT(ic.user_id) = 0
     ORDER BY ei.name ASC`,
    [expenseId]
  );

  return result.rows.map((row) => ({
    item_id: row.id,
    name: row.name,
    total_price: Number(row.total_price).toFixed(2),
  }));
}

function addComputedShares(items, paidBy, currentUserId) {
  return items.map((item) => {
    const totalCents = toCents(Number(item.total_price));
    const claimantCount = Number(item.claimant_count || 0);
    const claimants = Array.isArray(item.claimants) ? item.claimants : [];
    const isClaimedByMe = claimants.some((c) => c.user_id === currentUserId);

    if (claimantCount === 0) {
      return {
        ...item,
        is_claimed_by_me: false,
        price_per_person: '0.00',
        my_share: '0.00',
      };
    }

    const baseShare = Math.floor(totalCents / claimantCount);
    const remainder = totalCents - (baseShare * claimantCount);

    const myShareCents =
      (isClaimedByMe ? baseShare : 0) +
      (paidBy === currentUserId ? remainder : 0);

    return {
      ...item,
      is_claimed_by_me: isClaimedByMe,
      price_per_person: toMoney(baseShare),
      my_share: toMoney(myShareCents),
    };
  });
}

router.post(
  '/',
  [
    body('title').trim().notEmpty().withMessage('El título es requerido'),
    body('expense_date').optional().isISO8601().toDate(),
    body('items').isArray({ min: 1 }).withMessage('Debe haber al menos un ítem'),
    body('items.*.name').trim().notEmpty().withMessage('El nombre del ítem es requerido'),
    body('items.*.unit_price')
      .isFloat({ gte: 0 })
      .withMessage('El precio unitario debe ser >= 0'),
    body('items.*.quantity')
      .optional()
      .isFloat({ gt: 0 })
      .withMessage('La cantidad debe ser > 0'),
  ],
  async (req, res) => {
    if (handleValidationErrors(req, res)) return;

    const { groupId } = req.params;
    const userId = req.user.id;
    const { title, place, expense_date, notes, items } = req.body;

    const role = await requireMembership(groupId, userId, res);
    if (!role) return;

    const normalizedItems = items.map((item) => ({
      name: item.name,
      unit_price: Number(item.unit_price),
      quantity: item.quantity ? Number(item.quantity) : 1,
    }));

    const totalCents = normalizedItems.reduce(
      (acc, item) => acc + toCents(item.unit_price * item.quantity),
      0
    );

    if (totalCents <= 0) {
      return res.status(422).json({ error: 'El monto total calculado debe ser mayor a 0' });
    }

    const totalAmount = toMoney(totalCents);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const expResult = await client.query(
        `INSERT INTO expenses (group_id, title, place, total_amount, paid_by, expense_date, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [groupId, title, place, totalAmount, userId, expense_date || new Date(), notes]
      );
      const expense = expResult.rows[0];

      const itemPromises = normalizedItems.map((item) =>
        client.query(
          `INSERT INTO expense_items (expense_id, name, unit_price, quantity)
           VALUES ($1, $2, $3, $4)
           RETURNING *`,
          [expense.id, item.name, item.unit_price, item.quantity]
        )
      );
      const itemResults = await Promise.all(itemPromises);
      const createdItems = itemResults.map((r) => r.rows[0]);

      await client.query('COMMIT');
      
      auditLog('EXPENSE_CREATED', {
        userId,
        groupId,
        expenseId: expense.id,
        amount: totalAmount,
        title
      });

      res.status(201).json({ expense: { ...expense, items: createdItems } });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[expenses/create]', err.message);
      res.status(500).json({ error: 'Error al crear el gasto' });
    } finally {
      client.release();
    }
  }
);

router.get('/', async (req, res) => {
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
        `SELECT COUNT(*) AS total
         FROM expenses e
         WHERE e.group_id = $1
           AND (
             e.status <> 'draft'
             OR $2 = 'owner'
             OR e.paid_by = $3
           )`,
        [groupId, role, userId]
      ),
      pool.query(
        `SELECT e.*, u.name AS paid_by_name,
                COUNT(ei.id) AS item_count
         FROM expenses e
         JOIN users u ON u.id = e.paid_by
         LEFT JOIN expense_items ei ON ei.expense_id = e.id
         WHERE e.group_id = $1
           AND (
             e.status <> 'draft'
             OR $2 = 'owner'
             OR e.paid_by = $3
           )
         GROUP BY e.id, u.name
         ORDER BY e.expense_date DESC, e.created_at DESC
         LIMIT $4 OFFSET $5`,
        [groupId, role, userId, limit, offset]
      ),
    ]);

    res.json({
      expenses: dataResult.rows,
      total: Number(countResult.rows[0].total),
      page,
      limit,
    });
  } catch (err) {
    console.error('[expenses/list]', err.message);
    res.status(500).json({ error: 'Error al obtener gastos' });
  }
});

router.get('/:expenseId', async (req, res) => {
  const { groupId, expenseId } = req.params;
  const userId = req.user.id;

  const role = await requireMembership(groupId, userId, res);
  if (!role) return;

  try {
    const [expResult, itemsResult] = await Promise.all([
      pool.query(
        `SELECT e.*, u.name AS paid_by_name
         FROM expenses e
         JOIN users u ON u.id = e.paid_by
         WHERE e.id = $1 AND e.group_id = $2`,
        [expenseId, groupId]
      ),
      pool.query(
        `SELECT
           ei.id,
           ei.name,
           ei.unit_price,
           ei.quantity,
           (ei.unit_price * ei.quantity) AS total_price,
           COALESCE(
             json_agg(
               json_build_object('user_id', ic.user_id, 'name', u2.name)
             ) FILTER (WHERE ic.user_id IS NOT NULL),
             '[]'
           ) AS claimants,
           COUNT(ic.user_id) AS claimant_count
         FROM expense_items ei
         LEFT JOIN item_claims ic ON ic.item_id = ei.id
         LEFT JOIN users u2 ON u2.id = ic.user_id
         WHERE ei.expense_id = $1
         GROUP BY ei.id
         ORDER BY ei.name ASC`,
        [expenseId]
      ),
    ]);

    if (expResult.rows.length === 0) {
      return res.status(404).json({ error: 'Gasto no encontrado' });
    }

    const expense = expResult.rows[0];

    if (expense.status === 'draft' && role !== 'owner' && expense.paid_by !== userId) {
      return res.status(403).json({ error: 'No tienes acceso a este borrador' });
    }

    const items = addComputedShares(itemsResult.rows, expense.paid_by, userId);

    res.json({ expense, items });
  } catch (err) {
    console.error('[expenses/get]', err.message);
    res.status(500).json({ error: 'Error al obtener el gasto' });
  }
});

router.patch(
  '/:expenseId/status',
  [body('status').isIn(['draft', 'open', 'settled']).withMessage('Estado inválido')],
  async (req, res) => {
    if (handleValidationErrors(req, res)) return;

    const { groupId, expenseId } = req.params;
    const userId = req.user.id;
    const { status } = req.body;

    const isOwner = await requireOwner(groupId, userId, res);
    if (!isOwner) return;

    try {
      const current = await pool.query(
        'SELECT id, status FROM expenses WHERE id = $1 AND group_id = $2',
        [expenseId, groupId]
      );

      if (current.rows.length === 0) {
        return res.status(404).json({ error: 'Gasto no encontrado' });
      }

      if (status === 'settled') {
        const unclaimedItems = await findUnclaimedItems(expenseId);
        if (unclaimedItems.length > 0) {
          return res.status(409).json({
            error: 'No se puede liquidar el gasto porque existen ítems sin reclamar',
            unclaimed_items: unclaimedItems,
          });
        }
      }

      const result = await pool.query(
        `UPDATE expenses SET status = $1
         WHERE id = $2 AND group_id = $3
         RETURNING *`,
        [status, expenseId, groupId]
      );

      res.json({ expense: result.rows[0] });
    } catch (err) {
      console.error('[expenses/status]', err.message);
      res.status(500).json({ error: 'Error al actualizar estado' });
    }
  }
);

router.delete('/:expenseId', async (req, res) => {
  const { groupId, expenseId } = req.params;
  const userId = req.user.id;

  const role = await requireMembership(groupId, userId, res);
  if (!role) return;

  try {
    const expCheck = await pool.query(
      'SELECT status, paid_by FROM expenses WHERE id = $1 AND group_id = $2',
      [expenseId, groupId]
    );

    if (expCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Gasto no encontrado' });
    }

    const { status, paid_by } = expCheck.rows[0];

    if (status === 'settled') {
      return res.status(409).json({ error: 'No se puede eliminar un gasto liquidado' });
    }

    const isOwner = role === 'owner';
    const isPayer = paid_by === userId;

    if (!isOwner && !isPayer) {
      return res.status(403).json({ error: 'Solo el owner o quien pagó puede eliminar el gasto' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM item_claims WHERE item_id IN (SELECT id FROM expense_items WHERE expense_id = $1)', [expenseId]);
      await client.query('DELETE FROM expense_items WHERE expense_id = $1', [expenseId]);
      await client.query('DELETE FROM expenses WHERE id = $1', [expenseId]);
      await client.query('COMMIT');

      auditLog('EXPENSE_DELETED', {
        userId,
        groupId,
        expenseId,
        severity: 'WARNING'
      });

      res.json({ message: 'Gasto eliminado' });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[expenses/delete]', err.message);
      res.status(500).json({ error: 'Error al eliminar el gasto' });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[expenses/delete]', err.message);
    res.status(500).json({ error: 'Error al eliminar el gasto' });
  }
});

module.exports = router;
