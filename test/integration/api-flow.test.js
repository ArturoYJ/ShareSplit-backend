const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../../src/index');
const pool = require('../../src/db/pool');

async function resetDatabase() {
  await pool.query('DELETE FROM payments');
  await pool.query('DELETE FROM item_claims');
  await pool.query('DELETE FROM expense_items');
  await pool.query('DELETE FROM expenses');
  await pool.query('DELETE FROM group_members');
  await pool.query('DELETE FROM groups');
  await pool.query('DELETE FROM users');
}

function randomEmail(prefix) {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}@test.local`;
}

test.before(async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL es requerido para ejecutar test:integration');
  }
  await resetDatabase();
});

test.after(async () => {
  await resetDatabase();
  await pool.end();
});

test('flujo crítico completo: auth, grupo, gasto, claims, balances y pagos con bloqueo de sobrepago', async () => {
  const userA = {
    name: 'Ana Owner',
    email: randomEmail('ana'),
    password: 'secret123',
  };

  const userB = {
    name: 'Beto Member',
    email: randomEmail('beto'),
    password: 'secret123',
  };

  const registerA = await request(app).post('/api/auth/register').send(userA);
  assert.equal(registerA.status, 201);

  const registerB = await request(app).post('/api/auth/register').send(userB);
  assert.equal(registerB.status, 201);

  const tokenA = registerA.body.token;
  const tokenB = registerB.body.token;
  const userAId = registerA.body.user.id;
  const userBId = registerB.body.user.id;

  const createGroup = await request(app)
    .post('/api/groups')
    .set('Authorization', `Bearer ${tokenA}`)
    .send({ name: 'Grupo Test Integración' });
  assert.equal(createGroup.status, 201);

  const groupId = createGroup.body.group.id;
  const inviteCode = createGroup.body.group.invite_code;

  const joinGroup = await request(app)
    .post('/api/groups/join')
    .set('Authorization', `Bearer ${tokenB}`)
    .send({ invite_code: inviteCode });
  assert.equal(joinGroup.status, 200);

  const createExpense = await request(app)
    .post(`/api/groups/${groupId}/expenses`)
    .set('Authorization', `Bearer ${tokenA}`)
    .send({
      title: 'Cena test',
      items: [
        { name: 'Pizza', unit_price: 100, quantity: 1 },
        { name: 'Refresco', unit_price: 50, quantity: 1 },
      ],
    });

  assert.equal(createExpense.status, 201);
  const expenseId = createExpense.body.expense.id;

  const publishExpense = await request(app)
    .patch(`/api/groups/${groupId}/expenses/${expenseId}/status`)
    .set('Authorization', `Bearer ${tokenA}`)
    .send({ status: 'open' });

  assert.equal(publishExpense.status, 200);

  const detailExpense = await request(app)
    .get(`/api/groups/${groupId}/expenses/${expenseId}`)
    .set('Authorization', `Bearer ${tokenB}`);
  assert.equal(detailExpense.status, 200);

  const pizza = detailExpense.body.items.find((item) => item.name === 'Pizza');
  const soda = detailExpense.body.items.find((item) => item.name === 'Refresco');

  const claimPizzaByA = await request(app)
    .put(`/api/groups/${groupId}/expenses/${expenseId}/items/${pizza.id}/claim`)
    .set('Authorization', `Bearer ${tokenA}`);
  assert.equal(claimPizzaByA.status, 200);

  const claimPizzaByB = await request(app)
    .put(`/api/groups/${groupId}/expenses/${expenseId}/items/${pizza.id}/claim`)
    .set('Authorization', `Bearer ${tokenB}`);
  assert.equal(claimPizzaByB.status, 200);

  const claimSodaByB = await request(app)
    .put(`/api/groups/${groupId}/expenses/${expenseId}/items/${soda.id}/claim`)
    .set('Authorization', `Bearer ${tokenB}`);
  assert.equal(claimSodaByB.status, 200);

  const settleExpense = await request(app)
    .patch(`/api/groups/${groupId}/expenses/${expenseId}/status`)
    .set('Authorization', `Bearer ${tokenA}`)
    .send({ status: 'settled' });
  assert.equal(settleExpense.status, 200);

  const balances = await request(app)
    .get(`/api/groups/${groupId}/balances`)
    .set('Authorization', `Bearer ${tokenB}`);

  assert.equal(balances.status, 200);
  assert.ok(Array.isArray(balances.body.debts));

  const debtFromBToA = balances.body.debts.find(
    (debt) => debt.from_user_id === userBId && debt.to_user_id === userAId
  );
  assert.ok(debtFromBToA, 'Debe existir deuda de Beto hacia Ana');

  const overpay = await request(app)
    .post(`/api/groups/${groupId}/payments`)
    .set('Authorization', `Bearer ${tokenB}`)
    .send({
      to_user_id: userAId,
      amount: Number(debtFromBToA.amount) + 10,
      note: 'Intento sobrepago',
    });

  assert.equal(overpay.status, 409);
  assert.equal(overpay.body.code, 'OVERPAYMENT_NOT_ALLOWED');

  const validPay = await request(app)
    .post(`/api/groups/${groupId}/payments`)
    .set('Authorization', `Bearer ${tokenB}`)
    .send({
      to_user_id: userAId,
      amount: Number(debtFromBToA.amount),
      note: 'Pago exacto',
    });

  assert.equal(validPay.status, 201);

  const balancesAfterPay = await request(app)
    .get(`/api/groups/${groupId}/balances`)
    .set('Authorization', `Bearer ${tokenB}`);

  assert.equal(balancesAfterPay.status, 200);

  const paymentsHistory = await request(app)
    .get(`/api/groups/${groupId}/payments`)
    .set('Authorization', `Bearer ${tokenB}`);

  assert.equal(paymentsHistory.status, 200);
  const registeredPayment = paymentsHistory.body.payments.find(
    (payment) => payment.from_user_id === userBId && payment.to_user_id === userAId
  );
  assert.ok(registeredPayment, 'El pago registrado debe aparecer en historial');
});

test('settle-all bloquea liquidación cuando hay ítems sin reclamar', async () => {
  const owner = {
    name: 'Owner Two',
    email: randomEmail('owner2'),
    password: 'secret123',
  };

  const registerOwner = await request(app).post('/api/auth/register').send(owner);
  assert.equal(registerOwner.status, 201);

  const token = registerOwner.body.token;

  const createGroup = await request(app)
    .post('/api/groups')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Grupo settle all' });

  const groupId = createGroup.body.group.id;

  const createExpense = await request(app)
    .post(`/api/groups/${groupId}/expenses`)
    .set('Authorization', `Bearer ${token}`)
    .send({
      title: 'Cuenta con item sin claim',
      items: [
        { name: 'Entrada', unit_price: 30, quantity: 1 },
        { name: 'Postre', unit_price: 20, quantity: 1 },
      ],
    });

  const expenseId = createExpense.body.expense.id;

  await request(app)
    .patch(`/api/groups/${groupId}/expenses/${expenseId}/status`)
    .set('Authorization', `Bearer ${token}`)
    .send({ status: 'open' });

  const expenseDetail = await request(app)
    .get(`/api/groups/${groupId}/expenses/${expenseId}`)
    .set('Authorization', `Bearer ${token}`);

  const entrada = expenseDetail.body.items.find((item) => item.name === 'Entrada');

  await request(app)
    .put(`/api/groups/${groupId}/expenses/${expenseId}/items/${entrada.id}/claim`)
    .set('Authorization', `Bearer ${token}`);

  const settleAll = await request(app)
    .post(`/api/groups/${groupId}/settle-all`)
    .set('Authorization', `Bearer ${token}`)
    .send();

  assert.equal(settleAll.status, 409);
  assert.equal(settleAll.body.code, 'UNCLAIMED_ITEMS_BLOCK_SETTLEMENT');
  assert.ok(Array.isArray(settleAll.body.details?.unclaimed_items));
  assert.ok(settleAll.body.details.unclaimed_items.length >= 1);
});
