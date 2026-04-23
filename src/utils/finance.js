function toCents(value) {
  return Math.round(Number(value) * 100);
}

function toMoney(cents) {
  return Number((cents / 100).toFixed(2));
}

function simplifyDebtsFromCents(balanceRows) {
  const debts = [];

  const debtors = balanceRows
    .filter((b) => b.net_balance_cents < 0)
    .map((b) => ({ ...b, amount: Math.abs(b.net_balance_cents) }))
    .sort((a, b) => b.amount - a.amount);

  const creditors = balanceRows
    .filter((b) => b.net_balance_cents > 0)
    .map((b) => ({ ...b, amount: b.net_balance_cents }))
    .sort((a, b) => b.amount - a.amount);

  let i = 0;
  let j = 0;

  while (i < debtors.length && j < creditors.length) {
    const debtor = debtors[i];
    const creditor = creditors[j];
    const amount = Math.min(debtor.amount, creditor.amount);

    if (amount > 0) {
      debts.push({
        from_user_id: debtor.user_id,
        from_name: debtor.name,
        to_user_id: creditor.user_id,
        to_name: creditor.name,
        amount: toMoney(amount),
        amount_cents: amount,
      });
    }

    debtor.amount -= amount;
    creditor.amount -= amount;

    if (debtor.amount === 0) i += 1;
    if (creditor.amount === 0) j += 1;
  }

  return debts;
}

async function computeBalancesAndDebts(db, groupId) {
  const membersResult = await db.query(
    `SELECT u.id, u.name, u.email, u.avatar_url
     FROM users u
     JOIN group_members gm ON gm.user_id = u.id
     WHERE gm.group_id = $1`,
    [groupId]
  );

  const expensesResult = await db.query(
    `SELECT id, paid_by, total_amount
     FROM expenses
     WHERE group_id = $1 AND status IN ('open', 'settled')`,
    [groupId]
  );

  const itemsResult = await db.query(
    `SELECT ei.id, ei.expense_id, ei.unit_price, ei.quantity
     FROM expense_items ei
     JOIN expenses e ON e.id = ei.expense_id
     WHERE e.group_id = $1 AND e.status IN ('open', 'settled')`,
    [groupId]
  );

  const claimsResult = await db.query(
    `SELECT ic.item_id, ic.user_id
     FROM item_claims ic
     JOIN expense_items ei ON ei.id = ic.item_id
     JOIN expenses e ON e.id = ei.expense_id
     WHERE e.group_id = $1 AND e.status IN ('open', 'settled')`,
    [groupId]
  );

  const paymentsResult = await db.query(
    `SELECT from_user_id, to_user_id, SUM(amount) AS total
     FROM payments
     WHERE group_id = $1
     GROUP BY from_user_id, to_user_id`,
    [groupId]
  );

  const balancesMap = {};

  for (const member of membersResult.rows) {
    balancesMap[member.id] = {
      user_id: member.id,
      name: member.name,
      email: member.email,
      avatar_url: member.avatar_url,
      total_paid_cents: 0,
      total_owed_cents: 0,
      payments_sent_cents: 0,
      payments_received_cents: 0,
      net_balance_cents: 0,
    };
  }

  const expenseById = {};
  for (const expense of expensesResult.rows) {
    expenseById[expense.id] = expense;
    if (balancesMap[expense.paid_by]) {
      balancesMap[expense.paid_by].total_paid_cents += toCents(expense.total_amount);
    }
  }

  const claimsByItemId = {};
  for (const claim of claimsResult.rows) {
    if (!claimsByItemId[claim.item_id]) {
      claimsByItemId[claim.item_id] = [];
    }
    claimsByItemId[claim.item_id].push(claim.user_id);
  }

  for (const item of itemsResult.rows) {
    const claimants = claimsByItemId[item.id] || [];
    if (claimants.length === 0) continue;

    const totalItemCents = toCents(Number(item.unit_price) * Number(item.quantity));
    const baseShare = Math.floor(totalItemCents / claimants.length);
    const remainder = totalItemCents - (baseShare * claimants.length);

    for (const claimantId of claimants) {
      if (balancesMap[claimantId]) {
        balancesMap[claimantId].total_owed_cents += baseShare;
      }
    }

    const payerId = expenseById[item.expense_id]?.paid_by;
    if (payerId && balancesMap[payerId]) {
      balancesMap[payerId].total_owed_cents += remainder;
    }
  }

  for (const payment of paymentsResult.rows) {
    const cents = toCents(payment.total);
    if (balancesMap[payment.from_user_id]) {
      balancesMap[payment.from_user_id].payments_sent_cents += cents;
    }
    if (balancesMap[payment.to_user_id]) {
      balancesMap[payment.to_user_id].payments_received_cents += cents;
    }
  }

  const balancesWithCents = Object.values(balancesMap).map((b) => {
    const net =
      b.total_paid_cents -
      b.total_owed_cents -
      b.payments_sent_cents +
      b.payments_received_cents;

    return {
      ...b,
      net_balance_cents: net,
    };
  });

  const balances = balancesWithCents.map((b) => ({
    user_id: b.user_id,
    name: b.name,
    email: b.email,
    avatar_url: b.avatar_url,
    total_paid: toMoney(b.total_paid_cents),
    total_owed: toMoney(b.total_owed_cents),
    payments_sent: toMoney(b.payments_sent_cents),
    payments_received: toMoney(b.payments_received_cents),
    net_balance: toMoney(b.net_balance_cents),
  }));

  const debts = simplifyDebtsFromCents(balancesWithCents);

  return {
    balances,
    debts,
    debtsByPair: new Map(debts.map((d) => [`${d.from_user_id}:${d.to_user_id}`, d.amount_cents])),
  };
}

module.exports = {
  toCents,
  toMoney,
  computeBalancesAndDebts,
};
