import express, { type ErrorRequestHandler } from 'express';
import { MongoServerError } from 'mongodb';
import clientes from './routes/clientes.js';
import cuentas from './routes/cuentas.js';
import transferencias from './routes/transferencias.js';
import { HttpError } from './util.js';

export const app = express();
app.use(express.json());

// Logging
app.use((req, res, next) => {
  const t = Date.now();
  res.on('finish', () => console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - t}ms`));
  next();
});

app.use('/clientes', clientes);
app.use('/cuentas', cuentas);
app.use('/transferencias', transferencias);
app.use((_req, res) => void res.status(404).json({ error: 'Ruta no encontrada' }));

const manejarError: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) return void res.status(err.status).json({ error: err.message });
  if (err?.type === 'entity.parse.failed') return void res.status(400).json({ error: 'El body no es JSON válido' });
  if (err instanceof MongoServerError && err.code === 11000) {
    const campo = Object.keys(err.keyPattern ?? {})[0] ?? 'clave';
    return void res.status(409).json({ error: `Ya existe un registro con ese ${campo}` });
  }
  console.error(err);
  res.status(500).json({ error: 'Error inesperado del servidor' });
};
app.use(manejarError);
