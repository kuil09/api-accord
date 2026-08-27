import { randomUUID } from 'node:crypto';

const VALID_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/u;

export function correlationIdFromHeader(
  value: string | readonly string[] | undefined
): string {
  const candidate = Array.isArray(value) ? value[0] : value;

  if (candidate !== undefined && VALID_CORRELATION_ID.test(candidate)) {
    return candidate;
  }

  return randomUUID();
}
