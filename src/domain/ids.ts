export type IdPrefix =
  | 'prj'
  | 'scn'
  | 'src'
  | 'ver'
  | 'ast'
  | 'img'
  | 'aud'
  | 'rnd'
  | 'note'
  | 'nar'
  | 'edit'
  | 'plan';

let fallbackCounter = 0;

function randomId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  fallbackCounter += 1;
  return `${Date.now().toString(36)}-${fallbackCounter.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

/** Stable, prefixed identifiers. Duplication paths always mint new ids. */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomId()}`;
}
