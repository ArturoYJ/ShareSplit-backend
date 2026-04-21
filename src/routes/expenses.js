const express = require('express');
const router = express.Router({ mergeParams: true }); // hereda :groupId
const { body, param, validationResult } = require('express-validator');
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
    'SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2',
    [groupId, userId]
  );
  if (r.rows.length === 0) {
    res.status(403).json({ error: 'No tienes acceso a este grupo' });
    return null;
  }
  return r.rows[0].role;
}

// ── POST /groups/:groupId/expenses — Crear gasto ──────────────────────────────

router.post(
  '/',
  [
    body('title').trim().notEmpty().withMessage('El título es requerido'),
    body('total_amount')
      .isFloat({ gt: 0 })
      .withMessage('El monto total debe ser mayor a 0'),
    body('paid_by').isUUID().withMessage('paid_by debe ser un UUID válido'),
    body('expense_date').optional().isISO8601().toDate(),
    body('items')
      .isArray({ min: 1 })
      .withMessage('Debe haber al menos un ítem'),
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
    const { title, place, total_amount, paid_by, expense_date, notes, items } = req.body;

    const role = await requireMembership(groupId, userId, res);
    if (!role) return;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Insertar gasto
      const expResult = await client.query(
        `INSERT INTO expenses (group_id, title, place, total_amount, paid_by, expense_date, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [groupId, title, place, total_amount, paid_by, expense_date || new Date(), notes]
      );
      const expense = expResult.rows[0];

      // Insertar ítems
      const itemPromises = items.map((item) =>
        client.query(
          `INSERT INTO expense_items (expense_id, name, unit_price, quantity)
           VALUES ($1, $2, $3, $4)
           RETURNING *`,
          [expense.id, item.name, item.unit_price, item.quantity || 1]
        )
      );
      const itemResults = await Promise.all(itemPromises);
      const createdItems = itemResults.map((r) => r.rows[0]);

      await client.query('COMMIT');

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

// ── GET /groups/:groupId/expenses — Listar gastos del grupo ──────────────────

router.get('/', async (req, res) => {
  const { groupId } = req.params;
  const userId = req.user.id;

  const role = await requireMembership(groupId, userId, res);
  if (!role) return;

  try {
    const result = await pool.query(
      `SELECT e.*, u.name AS paid_by_name,
              COUNT(ei.id) AS item_count
       FROM expenses e
       JOIN users u ON u.id = e.paid_by
       LEFT JOIN expense_items ei ON ei.expense_id = e.id
       WHERE e.group_id = $1
       GROUP BY e.id, u.name
       ORDER BY e.expense_date DESC, e.created_at DESC`,
      [groupId]
    );
    res.json({ expenses: result.rows });
  } catch (err) {
    console.error('[expenses/list]', err.message);
    res.status(500).json({ error: 'Error al obtener gastos' });
  }
});

// ── GET /expenses/:expenseId — Detalle de gasto con ítems y reclamos ─────────

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
           COUNT(ic.user_id) AS claimant_count,
           CASE
             WHEN COUNT(ic.user_id) > 0
             THEN (ei.unit_price * ei.quantity) / COUNT(ic.user_id)
             ELSE 0
           END AS price_per_person
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

    res.json({ expense: expResult.rows[0], items: itemsResult.rows });
  } catch (err) {
    console.error('[expenses/get]', err.message);
    res.status(500).json({ error: 'Error al obtener el gasto' });
  }
});

// ── PATCH /expenses/:expenseId/status — Cambiar estado ───────────────────────

router.patch(
  '/:expenseId/status',
  [body('status').isIn(['draft', 'open', 'settled']).withMessage('Estado inválido')],
  async (req, res) => {
    if (handleValidationErrors(req, res)) return;

    const { groupId, expenseId } = req.params;
    const userId = req.user.id;
    const { status } = req.body;

    const role = await requireMembership(groupId, userId, res);
    if (!role) return;

    try {
      const result = await pool.query(
        `UPDATE expenses SET status = $1
         WHERE id = $2 AND group_id = $3
         RETURNING *`,
        [status, expenseId, groupId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Gasto no encontrado' });
      }

      res.json({ expense: result.rows[0] });
    } catch (err) {
      console.error('[expenses/status]', err.message);
      res.status(500).json({ error: 'Error al actualizar estado' });
    }
  }
);

module.exports = router;
