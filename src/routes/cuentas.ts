import { Router } from 'express';
import { MongoServerError, type Filter } from 'mongodb';
import {
  clientes, comprobarCargo, cuentas, datosOperacion, movimientos, tx,
  type Cuenta, type Movimiento,
} from '../db.js';
import { generarIban } from '../iban.js';
import { HttpError, oid, paginar } from '../util.js';

const r = Router();
export default r;

const TRANSICIONES: Record<string, string[]> = {
  activa: ['bloqueada', 'cerrada'],
  bloqueada: ['activa', 'cerrada'],
  cerrada: [],
};
const TIPOS_MOV = ['ingreso', 'retirada', 'transferencia_emitida', 'transferencia_recibida', 'comision'];

r.post('/', async (req, res) => {
  const b = req.body ?? {};
  const clienteId = oid(b.clienteId, 'clienteId');
  if (b.tipo !== 'corriente' && b.tipo !== 'ahorro') {
    throw new HttpError(400, 'El tipo debe ser "corriente" o "ahorro"');
  }
  if (!(await clientes.findOne({ _id: clienteId }))) throw new HttpError(404, 'Cliente no encontrado');
  // ponytail: count+insert no es atómico; dos altas simultáneas podrían dejar 4 cuentas.
  // Si importa: transacción que además escriba en el documento del cliente para forzar conflicto.
  if ((await cuentas.countDocuments({ clienteId, estado: { $ne: 'cerrada' } })) >= 3) {
    throw new HttpError(409, 'El cliente ya tiene 3 cuentas no cerradas');
  }
  for (let intento = 1; ; intento++) {
    const doc: Cuenta = {
      iban: generarIban(), clienteId, tipo: b.tipo, saldo: 0,
      descubiertoMax: b.tipo === 'corriente' ? 50000 : 0, estado: 'activa', creadaEn: new Date(),
    };
    try {
      const { insertedId } = await cuentas.insertOne(doc);
      return void res.status(201).json({ _id: insertedId, ...doc });
    } catch (e) {
      // IBAN repetido: se genera otro
      if (!(e instanceof MongoServerError && e.code === 11000 && e.keyPattern?.iban && intento < 5)) throw e;
    }
  }
});

r.get('/', async (req, res) => {
  const q = req.query;
  const f: Filter<Cuenta> = {};
  if (q.clienteId !== undefined) f.clienteId = oid(q.clienteId, 'clienteId');
  if (q.tipo !== undefined) f.tipo = String(q.tipo);
  if (q.estado !== undefined) f.estado = String(q.estado);
  res.json(await paginar(cuentas, f, q, { _id: 1 }));
});

r.get('/:id', async (req, res) => {
  const c = await cuentas.findOne({ _id: oid(req.params.id) });
  if (!c) throw new HttpError(404, 'Cuenta no encontrada');
  const titular = await clientes.findOne({ _id: c.clienteId }, { projection: { _id: 0, nombre: 1, email: 1 } });
  res.json({ ...c, titular });
});

r.patch('/:id/estado', async (req, res) => {
  const _id = oid(req.params.id);
  const estado = req.body?.estado;
  if (typeof estado !== 'string' || !Object.hasOwn(TRANSICIONES, estado)) {
    throw new HttpError(400, `Estado inexistente: "${estado}". Válidos: activa, bloqueada, cerrada`);
  }
  const c = await cuentas.findOne({ _id });
  if (!c) throw new HttpError(404, 'Cuenta no encontrada');
  if (!TRANSICIONES[c.estado].includes(estado)) {
    throw new HttpError(409, `Transición no permitida: estado actual "${c.estado}", solicitado "${estado}"`);
  }
  if (estado === 'cerrada' && c.saldo !== 0) {
    throw new HttpError(409, `No se puede cerrar una cuenta con saldo distinto de 0 (saldo actual: ${c.saldo})`);
  }
  // Update condicionado: si entre medias cambió estado o saldo, no se aplica
  const filtro: Filter<Cuenta> = { _id, estado: c.estado };
  if (estado === 'cerrada') filtro.saldo = 0;
  const act = await cuentas.findOneAndUpdate(filtro, { $set: { estado } }, { returnDocument: 'after' });
  if (!act) throw new HttpError(409, 'La cuenta ha cambiado durante la operación, inténtalo de nuevo');
  res.json(act);
});

r.get('/:id/movimientos', async (req, res) => {
  const cuentaId = oid(req.params.id);
  if (!(await cuentas.findOne({ _id: cuentaId }))) throw new HttpError(404, 'Cuenta no encontrada');
  const q = req.query;
  const f: Filter<Movimiento> = { cuentaId };
  if (q.tipo !== undefined) {
    const tipos = String(q.tipo).split(',').map((t) => t.trim());
    const malo = tipos.find((t) => !TIPOS_MOV.includes(t));
    if (malo !== undefined) throw new HttpError(400, `Tipo de movimiento inexistente: "${malo}"`);
    f.tipo = { $in: tipos };
  }
  if (q.categoria !== undefined) f.categoria = String(q.categoria);
  if (q.desde !== undefined || q.hasta !== undefined) {
    const rango: { $gte?: Date; $lt?: Date } = {};
    if (q.desde !== undefined) rango.$gte = fecha(q.desde, 'desde');
    if (q.hasta !== undefined) rango.$lt = fecha(q.hasta, 'hasta', true);
    f.fecha = rango;
  }
  const orden = q.orden ?? '-fecha';
  if (orden !== 'fecha' && orden !== '-fecha') throw new HttpError(400, 'orden debe ser "fecha" o "-fecha"');
  const dir = orden === 'fecha' ? 1 : -1;
  res.json(await paginar(movimientos, f, q, { fecha: dir, _id: dir }));
});

function fecha(v: unknown, campo: string, hastaInclusivo = false): Date {
  const s = String(v);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, `El parámetro ${campo} no es una fecha válida`);
  // "hasta=2026-10-31" incluye todo ese día
  if (hastaInclusivo && /^\d{4}-\d{2}-\d{2}$/.test(s)) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

// ---- Operaciones ----

async function cuentaPorId(id: string, session: Parameters<typeof comprobarCargo>[3]) {
  const c = await cuentas.findOne({ _id: oid(id) }, { session });
  if (!c) throw new HttpError(404, 'Cuenta no encontrada');
  return c;
}

r.post('/:id/ingresos', async (req, res) => {
  oid(req.params.id);
  const d = datosOperacion(req.body);
  const mov = await tx(async (session) => {
    const c = await cuentaPorId(req.params.id, session);
    if (c.estado === 'cerrada') throw new HttpError(409, `La cuenta ${c.iban} está cerrada y no admite operaciones`);
    await cuentas.updateOne({ _id: c._id }, { $inc: { saldo: d.importe } }, { session });
    const m: Movimiento = { cuentaId: c._id, tipo: 'ingreso', ...d, saldoResultante: c.saldo + d.importe, fecha: new Date() };
    const { insertedId } = await movimientos.insertOne(m, { session });
    return { _id: insertedId, ...m };
  });
  res.status(201).json(mov);
});

r.post('/:id/retiradas', async (req, res) => {
  oid(req.params.id);
  const d = datosOperacion(req.body);
  const mov = await tx(async (session) => {
    const c = await cuentaPorId(req.params.id, session);
    await comprobarCargo(c, d.importe, d.importe, session);
    await cuentas.updateOne({ _id: c._id }, { $inc: { saldo: -d.importe } }, { session });
    const m: Movimiento = {
      cuentaId: c._id, tipo: 'retirada', ...d, importe: -d.importe,
      saldoResultante: c.saldo - d.importe, fecha: new Date(),
    };
    const { insertedId } = await movimientos.insertOne(m, { session });
    return { _id: insertedId, ...m };
  });
  res.status(201).json(mov);
});
