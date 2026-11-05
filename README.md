# API REST Banco (Express + MongoDB + TypeScript)

API para gestionar clientes, cuentas y movimientos. Importes siempre en **céntimos enteros**.

## Requisitos

- Node.js ≥ 20.6 (usa `--env-file`, sin dotenv)
- MongoDB ≥ 6 **como replica set** (las operaciones de dinero usan transacciones). Docker o MongoDB Atlas sirven.

## Configuración (.env)

```bash
cp .env.example .env
```

| Variable      | Ejemplo                                                     |
|---------------|-------------------------------------------------------------|
| `MONGODB_URI` | `mongodb://localhost:27017/banco?directConnection=true`     |
| `PORT`        | `3000`                                                      |

El nombre de la base de datos sale de la URI (`/banco`). El `.env` no se sube al repositorio.

## Levantar MongoDB

Con Docker (replica set de un nodo):

```bash
docker run -d --name mongo-banco -p 27017:27017 mongo:7 --replSet rs0 --bind_ip_all
docker exec mongo-banco mongosh --quiet --eval "rs.initiate({_id:'rs0',members:[{_id:0,host:'localhost:27017'}]})"
```

Con MongoDB instalado localmente: `mongod --replSet rs0 --dbpath ./data` y después `mongosh --eval "rs.initiate()"`.

Con Atlas: pega la cadena de conexión `mongodb+srv://...` en `MONGODB_URI` (Atlas ya es un replica set).

## Instalar y arrancar

```bash
npm install
npm run dev          # desarrollo (recarga automática)
npm run build && npm start   # producción
npm test             # tests end-to-end (levanta un MongoDB en memoria, no necesita Docker)
```

Los índices únicos (`email`, `dni`, `iban`) se crean al arrancar.

## Endpoints

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/clientes` | Alta `{ nombre, email, dni }` |
| GET | `/clientes?pagina&limite` | Lista paginada |
| GET | `/clientes/:id` | Detalle |
| PATCH | `/clientes/:id` | Modifica `nombre` y/o `email` (el `dni` no) |
| POST | `/cuentas` | Alta `{ clienteId, tipo: "corriente" \| "ahorro" }`, IBAN generado |
| GET | `/cuentas?clienteId&tipo&estado&pagina&limite` | Lista filtrada y paginada |
| GET | `/cuentas/:id` | Detalle con `titular: { nombre, email }` |
| PATCH | `/cuentas/:id/estado` | `{ estado }` |
| GET | `/cuentas/:id/movimientos` | Extracto: `tipo` (varios con comas), `categoria`, `desde`, `hasta`, `orden=fecha\|-fecha`, `pagina`, `limite` (máx. 100) |
| POST | `/cuentas/:id/ingresos` | `{ importe, concepto, categoria? }` |
| POST | `/cuentas/:id/retiradas` | `{ importe, concepto, categoria? }` |
| POST | `/transferencias` | `{ ibanOrigen, ibanDestino, importe, concepto, categoria? }` |

Errores: `{ "error": "mensaje" }` con 400 / 404 / 409 / 500.

## Decisiones

- **Transacciones**: cada operación de dinero (lectura de saldo, comprobaciones, actualización y movimientos) va en una transacción; dos operaciones simultáneas sobre la misma cuenta chocan y el driver reintenta, así que el saldo nunca se corrompe (hay un test de concurrencia).
- **IBAN**: módulo 97 implementado a mano en `src/iban.ts`, calculado dígito a dígito para no desbordar `Number`.
- **Comisión**: `max(100, ceil(importe · 0,5 %))` con aritmética entera.
- **Límite diario** (100 000 céntimos): suma retiradas **y** transferencias emitidas del día natural (UTC). La comisión no cuenta para el límite, sí para el saldo.
- **Duplicados**: se apoyan en los índices únicos (error 11000 → 409).

## Estructura

```
src/
  index.ts          arranque (conexión, índices, listen)
  app.ts            express, logging y manejador global de errores
  db.ts             colecciones, transacciones y reglas de cargo
  iban.ts           generación y validación de IBAN
  util.ts           validaciones, ObjectId, paginación
  routes/           clientes, cuentas (+ ingresos/retiradas/extracto), transferencias
test/api.test.ts    test end-to-end
```
