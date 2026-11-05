// Test end-to-end contra un replica set de MongoDB en memoria (no necesita Mongo instalado).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { generarIban, ibanValido } from '../src/iban.js';

let base = '';
let stop: () => Promise<void>;

before(async () => {
  const rs = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGODB_URI = rs.getUri('banco_test');
  const { client, crearIndices } = await import('../src/db.js');
  const { app } = await import('../src/app.js');
  await client.connect();
  await crearIndices();
  const server = app.listen(0);
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  stop = async () => { server.close(); await client.close(); await rs.stop(); };
});
after(() => stop());

async function api(method: string, path: string, body?: unknown) {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

test('IBAN mod 97', () => {
  assert.ok(ibanValido('ES7620770024003102575766'));
  assert.ok(ibanValido('ES9121000418450200051332'));
  assert.ok(!ibanValido('ES0000000000000000000000'));
  for (let i = 0; i < 1000; i++) assert.ok(ibanValido(generarIban()));
});

test('flujo completo', async () => {
  // Clientes
  const ana = await api('POST', '/clientes', { nombre: 'Ana García', email: 'ANA@correo.com', dni: '12345678Z' });
  assert.equal(ana.status, 201);
  assert.equal(ana.body.email, 'ana@correo.com');
  assert.equal(typeof ana.body._id, 'string');
  assert.equal((await api('POST', '/clientes', { nombre: 'X', email: 'ana@correo.com', dni: '11111111A' })).status, 409);
  assert.equal((await api('POST', '/clientes', { nombre: 'X', email: 'x@correo.com', dni: '12345678Z' })).status, 409);
  assert.equal((await api('POST', '/clientes', { nombre: 'X', email: 'mal', dni: '1A' })).status, 400);
  assert.equal((await api('GET', '/clientes/123')).status, 400);
  assert.equal((await api('GET', '/clientes/0123456789abcdef01234567')).status, 404);
  assert.equal((await api('PATCH', `/clientes/${ana.body._id}`, { dni: '00000000T' })).status, 400);
  assert.equal((await api('PATCH', `/clientes/${ana.body._id}`, { nombre: 'Ana G.' })).body.nombre, 'Ana G.');
  const luis = (await api('POST', '/clientes', { nombre: 'Luis', email: 'luis@correo.com', dni: '87654321X' })).body;
  const lista = await api('GET', '/clientes?pagina=1&limite=1');
  assert.deepEqual([lista.body.totalElementos, lista.body.totalPaginas, lista.body.datos.length], [2, 2, 1]);

  // Cuentas
  const c1 = (await api('POST', '/cuentas', { clienteId: ana.body._id, tipo: 'corriente' })).body;
  assert.ok(ibanValido(c1.iban));
  assert.deepEqual([c1.saldo, c1.descubiertoMax, c1.estado], [0, 50000, 'activa']);
  const c2 = (await api('POST', '/cuentas', { clienteId: ana.body._id, tipo: 'ahorro' })).body;
  assert.equal(c2.descubiertoMax, 0);
  await api('POST', '/cuentas', { clienteId: ana.body._id, tipo: 'ahorro' });
  assert.equal((await api('POST', '/cuentas', { clienteId: ana.body._id, tipo: 'ahorro' })).status, 409);
  const cl = (await api('POST', '/cuentas', { clienteId: luis._id, tipo: 'corriente' })).body;
  assert.equal((await api('GET', `/cuentas/${c1._id}`)).body.titular.email, 'ana@correo.com');

  // Ingresos y retiradas
  assert.equal((await api('POST', `/cuentas/${c1._id}/ingresos`, { importe: 12.5, concepto: 'x' })).status, 400);
  const ing = await api('POST', `/cuentas/${c1._id}/ingresos`, { importe: 150000, concepto: 'Nómina', categoria: 'ingresos' });
  assert.equal(ing.status, 201);
  assert.equal(ing.body.saldoResultante, 150000);
  const sinSaldo = await api('POST', `/cuentas/${c1._id}/retiradas`, { importe: 900000, concepto: 'Cajero' });
  assert.equal(sinSaldo.status, 409);
  assert.match(sinSaldo.body.error, /disponible 200000/);

  // Transferencia entre clientes: comisión 125
  const t = await api('POST', '/transferencias', { ibanOrigen: c1.iban, ibanDestino: cl.iban, importe: 25000, concepto: 'Alquiler', categoria: 'vivienda' });
  assert.equal(t.status, 201);
  assert.deepEqual([t.body.comision, t.body.saldoOrigen], [125, 124875]);
  // Mismo cliente: gratis
  assert.equal((await api('POST', '/transferencias', { ibanOrigen: c1.iban, ibanDestino: c2.iban, importe: 100, concepto: 'x' })).body.comision, 0);
  assert.equal((await api('POST', '/transferencias', { ibanOrigen: c1.iban, ibanDestino: 'ES0000000000000000000000', importe: 1000, concepto: 'T' })).body.error, 'El IBAN de destino no es válido');
  assert.equal((await api('POST', '/transferencias', { ibanOrigen: c1.iban, ibanDestino: c1.iban, importe: 1000, concepto: 'T' })).status, 400);
  assert.equal((await api('POST', '/transferencias', { ibanOrigen: c1.iban, ibanDestino: 'ES9121000418450200051332', importe: 1000, concepto: 'T' })).status, 404);

  // Límite diario: ya van 25100 emitidos hoy
  assert.equal((await api('POST', `/cuentas/${c1._id}/retiradas`, { importe: 74900, concepto: 'ok' })).status, 201);
  const lim = await api('POST', `/cuentas/${c1._id}/retiradas`, { importe: 1, concepto: 'no' });
  assert.equal(lim.status, 409);
  assert.match(lim.body.error, /Límite diario/);

  // Extracto
  const ext = await api('GET', `/cuentas/${c1._id}/movimientos?tipo=transferencia_emitida,comision&limite=10`);
  assert.equal(ext.body.totalElementos, 3);
  const mov = (await api('GET', `/cuentas/${c1._id}/movimientos?orden=fecha`)).body.datos;
  assert.equal(mov[0].tipo, 'ingreso');
  assert.equal(mov.at(-1).saldoResultante, (await api('GET', `/cuentas/${c1._id}`)).body.saldo);
  assert.equal((await api('GET', `/cuentas/${c1._id}/movimientos?tipo=foo`)).status, 400);

  // Estados
  assert.equal((await api('PATCH', `/cuentas/${c1._id}/estado`, { estado: 'congelada' })).status, 400);
  const cerrar = await api('PATCH', `/cuentas/${c1._id}/estado`, { estado: 'cerrada' });
  assert.equal(cerrar.status, 409);
  assert.match(cerrar.body.error, /saldo actual/);
  assert.equal((await api('PATCH', `/cuentas/${cl._id}/estado`, { estado: 'bloqueada' })).status, 200);
  assert.equal((await api('POST', `/cuentas/${cl._id}/ingresos`, { importe: 100, concepto: 'x' })).status, 201);
  assert.equal((await api('POST', `/cuentas/${cl._id}/retiradas`, { importe: 100, concepto: 'x' })).status, 409);
  const vacia = (await api('POST', '/cuentas', { clienteId: luis._id, tipo: 'ahorro' })).body;
  assert.equal((await api('PATCH', `/cuentas/${vacia._id}/estado`, { estado: 'cerrada' })).status, 200);
  assert.equal((await api('PATCH', `/cuentas/${vacia._id}/estado`, { estado: 'activa' })).status, 409);
  assert.equal((await api('POST', `/cuentas/${vacia._id}/ingresos`, { importe: 100, concepto: 'x' })).status, 409);
});

test('retiradas concurrentes no rompen el saldo', async () => {
  const cli = (await api('POST', '/clientes', { nombre: 'C', email: 'c@c.com', dni: '22222222B' })).body;
  const c = (await api('POST', '/cuentas', { clienteId: cli._id, tipo: 'ahorro' })).body;
  await api('POST', `/cuentas/${c._id}/ingresos`, { importe: 1000, concepto: 'x' });
  const rs = await Promise.all(Array.from({ length: 10 }, () => api('POST', `/cuentas/${c._id}/retiradas`, { importe: 300, concepto: 'x' })));
  assert.equal(rs.filter((r) => r.status === 201).length, 3);
  assert.equal((await api('GET', `/cuentas/${c._id}`)).body.saldo, 100);
});
