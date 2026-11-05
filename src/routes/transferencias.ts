import { Router } from 'express';
import { ObjectId } from 'mongodb';
import { comprobarCargo, cuentas, datosOperacion, movimientos, tx, type Movimiento } from '../db.js';
import { ibanValido, normalizarIban } from '../iban.js';
import { HttpError } from '../util.js';

const r = Router();
export default r;

// 0,5 % redondeado hacia arriba, mínimo 100 céntimos (solo aritmética entera)
export const comision = (importe: number) => Math.max(100, Math.floor((importe * 5 + 999) / 1000));

r.post('/', async (req, res) => {
  const b = req.body ?? {};
  const ibanOrigen = normalizarIban(b.ibanOrigen);
  const ibanDestino = normalizarIban(b.ibanDestino);
  if (!ibanValido(ibanOrigen)) throw new HttpError(400, 'El IBAN de origen no es válido');
  if (!ibanValido(ibanDestino)) throw new HttpError(400, 'El IBAN de destino no es válido');
  if (ibanOrigen === ibanDestino) throw new HttpError(400, 'El IBAN de origen y el de destino deben ser distintos');
  const d = datosOperacion(b);

  const resultado = await tx(async (session) => {
    const o = await cuentas.findOne({ iban: ibanOrigen }, { session });
    if (!o) throw new HttpError(404, `No existe ninguna cuenta con el IBAN de origen ${ibanOrigen}`);
    const de = await cuentas.findOne({ iban: ibanDestino }, { session });
    if (!de) throw new HttpError(404, `No existe ninguna cuenta con el IBAN de destino ${ibanDestino}`);
    if (de.estado === 'cerrada') throw new HttpError(409, `La cuenta de destino ${ibanDestino} está cerrada`);

    const com = o.clienteId.equals(de.clienteId) ? 0 : comision(d.importe);
    await comprobarCargo(o, d.importe, d.importe + com, session);
    await cuentas.updateOne({ _id: o._id }, { $inc: { saldo: -(d.importe + com) } }, { session });
    await cuentas.updateOne({ _id: de._id }, { $inc: { saldo: d.importe } }, { session });

    const transferenciaId = new ObjectId();
    const fecha = new Date();
    const base = { concepto: d.concepto, categoria: d.categoria, transferenciaId, fecha };
    const saldoOrigen = o.saldo - d.importe - com;
    const movs: Movimiento[] = [
      { cuentaId: o._id, tipo: 'transferencia_emitida', importe: -d.importe, saldoResultante: o.saldo - d.importe, ...base },
    ];
    if (com) {
      movs.push({ cuentaId: o._id, tipo: 'comision', importe: -com, saldoResultante: saldoOrigen, ...base, categoria: 'comisiones' });
    }
    movs.push({ cuentaId: de._id, tipo: 'transferencia_recibida', importe: d.importe, saldoResultante: de.saldo + d.importe, ...base });
    await movimientos.insertMany(movs, { session });

    return { transferenciaId, ibanOrigen, ibanDestino, ...d, comision: com, saldoOrigen, fecha };
  });
  res.status(201).json(resultado);
});
