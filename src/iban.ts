import { randomInt } from 'node:crypto';

// Letras -> números (A=10 … Z=35)
const aDigitos = (s: string) => s.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));

// mod 97 dígito a dígito: el número completo excede Number
function mod97(digitos: string): number {
  let r = 0;
  for (const d of digitos) r = (r * 10 + Number(d)) % 97;
  return r;
}

export const normalizarIban = (v: unknown) =>
  typeof v === 'string' ? v.replace(/\s+/g, '').toUpperCase() : '';

export function ibanValido(iban: string): boolean {
  return /^ES\d{22}$/.test(iban) && mod97(aDigitos(iban.slice(4) + iban.slice(0, 4))) === 1;
}

export function generarIban(): string {
  let bban = '';
  for (let i = 0; i < 20; i++) bban += randomInt(10);
  const control = 98 - mod97(aDigitos(bban + 'ES00'));
  return 'ES' + String(control).padStart(2, '0') + bban;
}
