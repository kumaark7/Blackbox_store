export type AccountQuota = { totalBytes: number | null; usedBytes: number };

function byteCount(value: unknown) {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof number === 'number' && Number.isSafeInteger(number) && number >= 0 ? number : null;
}

export function reportedQuota(total: unknown, used: unknown): AccountQuota | null {
  const usedBytes = byteCount(used);
  return usedBytes === null ? null : { totalBytes: byteCount(total), usedBytes };
}
