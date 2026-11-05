import { ObjectId, type Collection, type Document, type Filter, type Sort } from 'mongodb';

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function oid(v: unknown, campo = 'id'): ObjectId {
  if (typeof v !== 'string' || !/^[0-9a-fA-F]{24}$/.test(v)) {
    throw new HttpError(400, `El ${campo} no es un ObjectId válido`);
  }
  return new ObjectId(v);
}

export function texto(v: unknown, campo: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `El campo ${campo} es obligatorio`);
  return v.trim();
}

// Dinero siempre en céntimos enteros
export function importe(v: unknown): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) {
    throw new HttpError(400, 'El importe debe ser un número entero de céntimos mayor que 0');
  }
  return v;
}

function enteroPositivo(v: unknown, campo: string): number {
  if (typeof v !== 'string' || !/^[1-9]\d*$/.test(v)) {
    throw new HttpError(400, `El parámetro ${campo} debe ser un entero mayor que 0`);
  }
  return Number(v);
}

export async function paginar<T extends Document>(
  col: Collection<T>,
  filtro: Filter<T>,
  query: Record<string, unknown>,
  orden: Sort,
) {
  const pagina = enteroPositivo(query.pagina ?? '1', 'pagina');
  const limite = Math.min(enteroPositivo(query.limite ?? '20', 'limite'), 100);
  const [datos, totalElementos] = await Promise.all([
    col.find(filtro).sort(orden).skip((pagina - 1) * limite).limit(limite).toArray(),
    col.countDocuments(filtro),
  ]);
  return { datos, pagina, limite, totalElementos, totalPaginas: Math.ceil(totalElementos / limite) };
}
