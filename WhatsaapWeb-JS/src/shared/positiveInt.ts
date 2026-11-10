export function toPositiveInt(value: unknown): number | null {
  if (typeof value === 'number') return Number.isInteger(value) && value > 0 ? value : null;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const number = Number(value.trim());
    return Number.isInteger(number) && number > 0 ? number : null;
  }
  return null;
}
