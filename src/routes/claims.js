const express = require('express');
const router = express.Router({ mergeParams: true }); // hereda :groupId y :expenseId
const { body, validationResult } = require('express-validator');
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

function handleValidationErrors(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(422).json({ errors: errors.array() });
    return true;
  }
  return false;
}

/** Verifica que el usuario sea miembro del grupo */
async function requireMembership(groupId, userId, res) {
  const r = await pool.query(
    'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
    [groupId, userId]
  );
  if (r.rows.length === 0) {
    res.status(403).json({ error: 'No tienes acceso a este grupo' });
    return false;
  }
  return true;
}

// ── PUT /groups/:groupId/expenses/:expenseId/items/:itemId/claim ──────────────
// Agrega o elimina el reclamo del usuario autenticado sobre un ítem.
// Funciona como toggle: si ya lo reclamó, lo quita; si no, lo agrega.

router.put('/:itemId/claim', async (req, res) => {
  const { groupId, expenseId, itemId } = req.params;
  const userId = req.user.id;

  const isMember = await requireMembership(groupId, userId, res);
  if (!isMember) return;

  try {
    // Verificar que el ítem pertenece al gasto del grupo
    const itemCheck = await pool.query(
      `SELECT ei.id FROM expense_items ei
       JOIN expenses e ON e.id = ei.expense_id
       WHERE ei.id = $1 AND e.id = $2 AND e.group_id = $3`,
      [itemId, expenseId, groupId]
    );

    if (itemCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Ítem no encontrado en este gasto' });
    }

    // Verificar que el gasto no esté cerrado
    const expCheck = await pool.query(
      "SELECT status FROM expenses WHERE id = $1",
      [expenseId]
    );
    if (expCheck.rows[0]?.status === 'settled') {
      return res.status(409).json({ error: 'No se puede modificar un gasto liquidado' });
    }

    // Toggle del reclamo
    const existing = await pool.query(
      'SELECT 1 FROM item_claims WHERE item_id = $1 AND user_id = $2',
      [itemId, userId]
    );

    let claimed;
    if (existing.rows.length > 0) {
      // Eliminar reclamo
      await pool.query(
        'DELETE FROM item_claims WHERE item_id = $1 AND user_id = $2',
        [itemId, userId]
      );
      claimed = false;
    } else {
      // Agregar reclamo
      await pool.query(
        'INSERT INTO item_claims (item_id, user_id) VALUES ($1, $2)',
        [itemId, userId]
      );
      claimed = true;
    }

    // Devolver estado actualizado del ítem
    const updatedItem = await pool.query(
      `SELECT
         ei.id,
         ei.name,
         ei.unit_price,
         ei.quantity,
         (ei.unit_price * ei.quantity) AS total_price,
         COUNT(ic.user_id) AS claimant_count,
         CASE
           WHEN COUNT(ic.user_id) > 0
           THEN (ei.unit_price * ei.quantity) / COUNT(ic.user_id)
           ELSE 0
         END AS price_per_person,
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

// ── GET /groups/:groupId/expenses/:expenseId/items/my-claims ─────────────────
// Devuelve los item_ids que el usuario autenticado ha reclamado en este gasto.

router.get('/my-claims', async (req, res) => {
  const { groupId, expenseId } = req.params;
  const userId = req.user.id;

  const isMember = await requireMembership(groupId, userId, res);
  if (!isMember) return;

  try {
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
