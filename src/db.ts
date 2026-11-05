import { MongoClient, type ClientSession, type ObjectId, type WithId } from 'mongodb';
import { HttpError, importe as importeOk, texto as textoOk } from './util.js';

export interface Cliente { nombre: string; email: string; dni: string; creadoEn: Date }
export interface Cuenta {
  iban: string; clienteId: ObjectId; tipo: string; saldo: number;
  descubiertoMax: number; estado: string; creadaEn: Date;
}
export interface Movimiento {
  cuentaId: ObjectId; tipo: string; importe: number; saldoResultante: number;
  concepto: string; categoria: string; transferenciaId?: ObjectId; fecha: Date;
}

export const client = new MongoClient(process.env.MONGODB_URI ?? 'mongodb://localhost:27017/banco');
const db = client.db();
export const clientes = db.collection<Cliente>('clientes');
export const cuentas = db.collection<Cuenta>('cuentas');
export const movimientos = db.collection<Movimiento>('movimientos');

export async function crearIndices() {
  await clientes.createIndex({ email: 1 }, { unique: true });
  await clientes.createIndex({ dni: 1 }, { unique: true });
  await cuentas.createIndex({ iban: 1 }, { unique: true });
  await cuentas.createIndex({ clienteId: 1 });
  await movimientos.createIndex({ cuentaId: 1, fecha: -1 });
}

// Todas las operaciones de dinero van en transacción: dos escrituras concurrentes
// sobre la misma cuenta chocan (WriteConflict) y withTransaction las reintenta.
export const tx = <T>(fn: (s: ClientSession) => Promise<T>) =>
  client.withSession((s) => s.withTransaction(() => fn(s)));

export const LIMITE_DIARIO = 100000;

// Reglas comunes a retiradas y transferencias emitidas.
// ponytail: "día natural" en UTC; usar zona Europe/Madrid si el banco lo exige.
export async function comprobarCargo(c: WithId<Cuenta>, importe: number, total: number, session: ClientSession) {
  if (c.estado === 'cerrada') throw new HttpError(409, `La cuenta ${c.iban} está cerrada y no admite operaciones`);
  if (c.estado !== 'activa') {
    throw new HttpError(409, `La cuenta ${c.iban} está ${c.estado}: no admite retiradas ni transferencias emitidas`);
  }
  const disponible = c.saldo + c.descubiertoMax;
  if (total > disponible) {
    throw new HttpError(409, `Saldo insuficiente: disponible ${disponible} céntimos (incluido descubierto), solicitado ${total}`);
  }
  const hoy = new Date();
  hoy.setUTCHours(0, 0, 0, 0);
  const [agg] = await movimientos
    .aggregate<{ total: number }>([
      { $match: { cuentaId: c._id, tipo: { $in: ['retirada', 'transferencia_emitida'] }, fecha: { $gte: hoy } } },
      { $group: { _id: null, total: { $sum: '$importe' } } },
    ], { session })
    .toArray();
  const usado = -(agg?.total ?? 0);
  if (usado + importe > LIMITE_DIARIO) {
    throw new HttpError(409, `Límite diario superado: hoy ya se han retirado ${usado} céntimos, solicitado ${importe}, límite ${LIMITE_DIARIO}`);
  }
}

export function datosOperacion(b: any) {
  return {
    importe: importeOk(b?.importe),
    concepto: textoOk(b?.concepto, 'concepto'),
    categoria: b?.categoria === undefined ? 'otros' : textoOk(b.categoria, 'categoria'),
  };
}
