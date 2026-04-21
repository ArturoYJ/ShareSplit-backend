const express = require('express');
const router = express.Router({ mergeParams: true }); // hereda :groupId
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

// ── GET /groups/:groupId/balances — Calcular saldos netos ────────────────────
//
// Lógica:
//   saldo(user) = Σ gastos pagados por user - Σ consumo asignado a user
//
// Consumo asignado = para cada ítem reclamado:
//   (unit_price * quantity) / número de personas que reclamaron ese ítem
//
// Un saldo positivo significa que los demás le deben al usuario.
// Un saldo negativo significa que el usuario le debe a los demás.

router.get('/', async (req, res) => {
  const { groupId } = req.params;
  const userId = req.user.id;

  const isMember = await requireMembership(groupId, userId, res);
  if (!isMember) return;

  try {
    // 1. Lo que cada usuario pagó (en gastos open o settled)
    const paidResult = await pool.query(
      `SELECT
         e.paid_by AS user_id,
         SUM(e.total_amount) AS total_paid
       FROM expenses e
       WHERE e.group_id = $1
         AND e.status IN ('open', 'settled')
       GROUP BY e.paid_by`,
      [groupId]
    );

    // 2. Lo que cada usuario debe (suma de su parte en cada ítem reclamado)
    const owedResult = await pool.query(
      `SELECT
         ic.user_id,
         SUM(
           (ei.unit_price * ei.quantity) /
           NULLIF(claimant_counts.cnt, 0)
         ) AS total_owed
       FROM item_claims ic
       JOIN expense_items ei ON ei.id = ic.item_id
       JOIN expenses e ON e.id = ei.expense_id
       JOIN (
         SELECT item_id, COUNT(*) AS cnt
         FROM item_claims
         GROUP BY item_id
       ) claimant_counts ON claimant_counts.item_id = ic.item_id
       WHERE e.group_id = $1
         AND e.status IN ('open', 'settled')
       GROUP BY ic.user_id`,
      [groupId]
    );

    // 3. Pagos realizados (reembolsos)
    const paymentsResult = await pool.query(
      `SELECT from_user_id, to_user_id, SUM(amount) AS total
       FROM payments
       WHERE group_id = $1
       GROUP BY from_user_id, to_user_id`,
      [groupId]
    );

    // 4. Obtener todos los miembros del grupo
    const membersResult = await pool.query(
      `SELECT u.id, u.name, u.email, u.avatar_url
       FROM users u
       JOIN group_members gm ON gm.user_id = u.id
       WHERE gm.group_id = $1`,
      [groupId]
    );

    // 5. Construir mapa de saldos
    const balanceMap = {};
    membersResult.rows.forEach((m) => {
      balanceMap[m.id] = {
        user_id: m.id,
        name: m.name,
        email: m.email,
        avatar_url: m.avatar_url,
        total_paid: 0,
        total_owed: 0,
        payments_sent: 0,
        payments_received: 0,
        net_balance: 0, // positivo = te deben, negativo = debes
      };
    });

    paidResult.rows.forEach((r) => {
      if (balanceMap[r.user_id]) {
        balanceMap[r.user_id].total_paid = parseFloat(r.total_paid);
      }
    });

    owedResult.rows.forEach((r) => {
      if (balanceMap[r.user_id]) {
        balanceMap[r.user_id].total_owed = parseFloat(r.total_owed);
      }
    });

    paymentsResult.rows.forEach((p) => {
      if (balanceMap[p.from_user_id]) {
        balanceMap[p.from_user_id].payments_sent += parseFloat(p.total);
      }
      if (balanceMap[p.to_user_id]) {
        balanceMap[p.to_user_id].payments_received += parseFloat(p.total);
      }
    });

    // net_balance = pagué - me asignaron - lo que envié + lo que recibí
    const balances = Object.values(balanceMap).map((b) => ({
      ...b,
      net_balance: parseFloat(
        (
          b.total_paid -
          b.total_owed -
          b.payments_sent +
          b.payments_received
        ).toFixed(2)
      ),
    }));

    // 6. Calcular deudas simplificadas (quién le paga a quién)
    const debts = simplifyDebts(balances);

    res.json({ balances, debts });
  } catch (err) {
    console.error('[balances/get]', err.message);
    res.status(500).json({ error: 'Error al calcular balances' });
  }
});

/**
 * Algoritmo greedy para simplificar deudas:
 * Devuelve un array de { from_user_id, from_name, to_user_id, to_name, amount }
 */
function simplifyDebts(balances) {
  const debts = [];

  // Separar deudores (net < 0) y acreedores (net > 0)
  const debtors = balances
    .filter((b) => b.net_balance < -0.01)
    .map((b) => ({ ...b, amount: Math.abs(b.net_balance) }))
    .sort((a, b) => b.amount - a.amount);

  const creditors = balances
    .filter((b) => b.net_balance > 0.01)
    .map((b) => ({ ...b, amount: b.net_balance }))
    .sort((a, b) => b.amount - a.amount);

  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const debtor = debtors[i];
    const creditor = creditors[j];
    const amount = Math.min(debtor.amount, creditor.amount);

    if (amount > 0.01) {
      debts.push({
        from_user_id: debtor.user_id,
        from_name: debtor.name,
        to_user_id: creditor.user_id,
        to_name: creditor.name,
        amount: parseFloat(amount.toFixed(2)),
      });
    }

    debtor.amount -= amount;
    creditor.amount -= amount;

    if (debtor.amount < 0.01) i++;
    if (creditor.amount < 0.01) j++;
  }

  return debts;
}

// ── POST /groups/:groupId/payments — Registrar pago ──────────────────────────

router.post(
  '/payments',
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
      return res.status(400).json({ error: 'No puedes pagarte a ti mismo' });
    }

    const isMember = await requireMembership(groupId, fromUserId, res);
    if (!isMember) return;

    try {
      // Verificar que el destinatario también sea miembro
      const toMember = await pool.query(
        'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
        [groupId, to_user_id]
      );
      if (toMember.rows.length === 0) {
        return res.status(400).json({ error: 'El destinatario no es miembro del grupo' });
      }

      const result = await pool.query(
        `INSERT INTO payments (group_id, from_user_id, to_user_id, amount, note)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [groupId, fromUserId, to_user_id, amount, note]
      );

      res.status(201).json({ payment: result.rows[0] });
    } catch (err) {
      console.error('[balances/payment]', err.message);
      res.status(500).json({ error: 'Error al registrar el pago' });
    }
  }
);

// ── GET /groups/:groupId/payments — Historial de pagos ───────────────────────

router.get('/payments', async (req, res) => {
  const { groupId } = req.params;
  const userId = req.user.id;

  const isMember = await requireMembership(groupId, userId, res);
  if (!isMember) return;

  try {
    const result = await pool.query(
      `SELECT
         p.*,
         uf.name AS from_name,
         ut.name AS to_name
       FROM payments p
       JOIN users uf ON uf.id = p.from_user_id
       JOIN users ut ON ut.id = p.to_user_id
       WHERE p.group_id = $1
       ORDER BY p.paid_at DESC`,
      [groupId]
    );

    res.json({ payments: result.rows });
  } catch (err) {
    console.error('[balances/payments-list]', err.message);
    res.status(500).json({ error: 'Error al obtener historial de pagos' });
  }
});

module.exports = router;
