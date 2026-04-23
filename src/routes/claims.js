const express = require('express');
const router = express.Router({ mergeParams: true });
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

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

async function requireExpenseAccess(groupId, expenseId, userId, role, res) {
  const expenseResult = await pool.query(
    `SELECT id, status, paid_by
     FROM expenses
     WHERE id = $1 AND group_id = $2`,
    [expenseId, groupId]
  );

  if (expenseResult.rows.length === 0) {
    res.status(404).json({ error: 'Gasto no encontrado' });
    return null;
  }

  const expense = expenseResult.rows[0];

  if (expense.status === 'draft' && role !== 'owner' && expense.paid_by !== userId) {
    res.status(403).json({ error: 'No tienes acceso a este borrador' });
    return null;
  }

  return expense;
}

router.put('/:itemId/claim', async (req, res) => {
  const { groupId, expenseId, itemId } = req.params;
  const userId = req.user.id;

  const role = await requireMembership(groupId, userId, res);
  if (!role) return;

  try {
    const expense = await requireExpenseAccess(groupId, expenseId, userId, role, res);
    if (!expense) return;

    if (expense.status !== 'open') {
      return res.status(409).json({ error: 'Solo se pueden reclamar ítems en gastos abiertos' });
    }

    const itemCheck = await pool.query(
      `SELECT ei.id FROM expense_items ei
       JOIN expenses e ON e.id = ei.expense_id
       WHERE ei.id = $1 AND e.id = $2 AND e.group_id = $3`,
      [itemId, expenseId, groupId]
    );

    if (itemCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Ítem no encontrado en este gasto' });
    }

    const existing = await pool.query(
      'SELECT 1 FROM item_claims WHERE item_id = $1 AND user_id = $2',
      [itemId, userId]
    );

    let claimed;
    if (existing.rows.length > 0) {
      await pool.query(
        'DELETE FROM item_claims WHERE item_id = $1 AND user_id = $2',
        [itemId, userId]
      );
      claimed = false;
    } else {
      await pool.query(
        'INSERT INTO item_claims (item_id, user_id) VALUES ($1, $2)',
        [itemId, userId]
      );
      claimed = true;
    }

    const updatedItem = await pool.query(
      `SELECT
         ei.id,
         ei.name,
         ei.unit_price,
         ei.quantity,
         (ei.unit_price * ei.quantity) AS total_price,
         COUNT(ic.user_id) AS claimant_count,
         BOOL_OR(ic.user_id = $2) AS is_claimed_by_me
       FROM expense_items ei
       LEFT JOIN item_claims ic ON ic.item_id = ei.id
       WHERE ei.id = $1
       GROUP BY ei.id`,
      [itemId, userId]
    );

    res.json({ claimed, item: updatedItem.rows[0] });
  } catch (err) {
    console.error('[claims/toggle]', err.message);
    res.status(500).json({ error: 'Error al actualizar el reclamo' });
  }
});

router.get('/my-claims', async (req, res) => {
  const { groupId, expenseId } = req.params;
  const userId = req.user.id;

  const role = await requireMembership(groupId, userId, res);
  if (!role) return;

  try {
    const expense = await requireExpenseAccess(groupId, expenseId, userId, role, res);
    if (!expense) return;

    const result = await pool.query(
      `SELECT ic.item_id
       FROM item_claims ic
       JOIN expense_items ei ON ei.id = ic.item_id
       WHERE ei.expense_id = $1 AND ic.user_id = $2`,
      [expenseId, userId]
    );

    res.json({ claimed_item_ids: result.rows.map((r) => r.item_id) });
  } catch (err) {
    console.error('[claims/my-claims]', err.message);
    res.status(500).json({ error: 'Error al obtener reclamos' });
  }
});

module.exports = router;
