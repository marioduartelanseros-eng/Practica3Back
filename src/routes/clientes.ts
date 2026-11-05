import { Router } from 'express';
import { clientes, type Cliente } from '../db.js';
import { HttpError, oid, paginar, texto } from '../util.js';

const r = Router();
export default r;

function email(v: unknown): string {
  const e = texto(v, 'email').toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new HttpError(400, 'El email no tiene un formato válido');
  return e;
}

r.post('/', async (req, res) => {
  const b = req.body ?? {};
  const dni = texto(b.dni, 'dni').toUpperCase();
  if (!/^\d{8}[A-Z]$/.test(dni)) throw new HttpError(400, 'El dni debe tener 8 dígitos y una letra');
  const doc: Cliente = { nombre: texto(b.nombre, 'nombre'), email: email(b.email), dni, creadoEn: new Date() };
  const { insertedId } = await clientes.insertOne(doc); // email/dni duplicados -> índice único -> 409
  res.status(201).json({ _id: insertedId, ...doc });
});

r.get('/', async (req, res) => {
  res.json(await paginar(clientes, {}, req.query, { _id: 1 }));
});

r.get('/:id', async (req, res) => {
  const c = await clientes.findOne({ _id: oid(req.params.id) });
  if (!c) throw new HttpError(404, 'Cliente no encontrado');
  res.json(c);
});

r.patch('/:id', async (req, res) => {
  const _id = oid(req.params.id);
  const b = req.body ?? {};
  if ('dni' in b) throw new HttpError(400, 'El dni no se puede modificar');
  const set: Partial<Cliente> = {};
  if (b.nombre !== undefined) set.nombre = texto(b.nombre, 'nombre');
  if (b.email !== undefined) set.email = email(b.email);
  if (!Object.keys(set).length) throw new HttpError(400, 'Indica nombre o email a modificar');
  const c = await clientes.findOneAndUpdate({ _id }, { $set: set }, { returnDocument: 'after' });
  if (!c) throw new HttpError(404, 'Cliente no encontrado');
  res.json(c);
});
