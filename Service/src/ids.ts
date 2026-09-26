import { createHash } from 'node:crypto';

// Stable id of a localization unit. Namespaces and keys may contain any character, including separators,
// so the pair is JSON-encoded (injective) before hashing.
export function unitIdOf(namespace: string, key: string): string {
  return createHash('sha256').update(JSON.stringify([namespace, key]), 'utf8').digest('hex').slice(0, 16);
}

export function textHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

// JSON with object keys sorted at every level: identical data always produces identical bytes.
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = sortKeys(source[key]);
    return out;
  }
  return value;
}

// Locale-independent ordering, so files sort the same on every machine.
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
