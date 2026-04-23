# ShareSplit Backend

API REST para la gestión de gastos compartidos.

## Stack

- **Runtime:** Node.js 20
- **Framework:** Express 4
- **Base de Datos:** PostgreSQL 16 (via Docker)
- **Autenticación:** JWT (jsonwebtoken + bcryptjs)

## Endpoints principales

| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/api/auth/register` | Registrar usuario |
| POST | `/api/auth/login` | Login → JWT |
| GET  | `/api/auth/me` | Perfil del usuario autenticado |
| POST | `/api/groups` | Crear grupo |
| POST | `/api/groups/join` | Unirse con invite_code |
| GET  | `/api/groups` | Listar mis grupos |
| GET  | `/api/groups/:id` | Detalle + miembros |
| POST | `/api/groups/:gId/expenses` | Crear gasto con ítems |
| GET  | `/api/groups/:gId/expenses` | Listar gastos del grupo |
| GET  | `/api/groups/:gId/expenses/:eId` | Detalle con ítems y reclamos |
| PATCH| `/api/groups/:gId/expenses/:eId/status` | Cambiar estado |
| PUT  | `/api/groups/:gId/expenses/:eId/items/:itemId/claim` | Toggle reclamo |
| GET  | `/api/groups/:gId/expenses/:eId/items/my-claims` | Mis reclamos |
| GET  | `/api/groups/:gId/balances` | Balances y deudas simplificadas |
| POST | `/api/groups/:gId/payments` | Registrar pago/reembolso |
| GET  | `/api/groups/:gId/payments` | Historial de pagos |

## Reglas financieras clave

- Los pagos validan `no sobrepago`: no se permite registrar un monto mayor a la deuda activa entre deudor y acreedor.
- `settle-all` y liquidación por gasto se bloquean si existen ítems sin reclamar.

## Pruebas de integración

```bash
npm run test:integration
```

> Requiere `DATABASE_URL` apuntando a una base con migraciones aplicadas.

## Setup local (sin Docker)

```bash
# 1. Instalar dependencias
npm install

# 2. Copiar variables de entorno
cp .env.example .env
# Edita .env con tu DATABASE_URL y JWT_SECRET

# 3. Levantar solo la BD desde infra/
cd ../infra && docker compose up -d postgres

# 4. Arrancar en modo desarrollo
npm run dev
```

Variables opcionales de hardening:

- `TRUST_PROXY`
- `RATE_LIMIT_GLOBAL_MAX`
- `RATE_LIMIT_AUTH_MAX`
- `RATE_LIMIT_PAYMENTS_MAX`

## Setup con Docker (recomendado)

```bash
cd ../infra
docker compose up -d --build
```

La API queda disponible en `http://localhost:3001`  
Health check: `GET http://localhost:3001/health`
