const pathPattern = '[A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*)*';
const predicate = new RegExp(`^(${pathPattern})(?:\\s*(===|==|!=|>|<)\\s*("[^"\\r\\n]*"|'[^'\\r\\n]*'|[-+]?\\d+(?:\\.\\d+)?|true|false|null))?$`);

export function isWorkflowCondition(expression: unknown): expression is string {
  return typeof expression === 'string' && expression.length <= 256 && predicate.test(expression.trim());
}

export function evaluateCondition(expression: string, variables: Record<string, unknown>): boolean {
  const parsed = predicate.exec(expression.trim());
  if (!parsed) throw new Error('Invalid workflow condition.');
  const [, path, operator, operand] = parsed;
  let value: unknown = variables;
  for (const key of path.split('.')) {
    if (value === null || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, key)) {
      value = undefined;
      break;
    }
    value = (value as Record<string, unknown>)[key];
  }
  if (!operator) return Boolean(value);

  const expected: unknown = operand.startsWith('"') || operand.startsWith("'")
    ? operand.slice(1, -1)
    : operand === 'null' ? null
      : operand === 'true' ? true
        : operand === 'false' ? false : Number(operand);
  if (operator === '===' || operator === '==') return value === expected;
  if (operator === '!=') return value !== expected;
  if (typeof value !== 'number' || typeof expected !== 'number') return false;
  return operator === '>' ? value > expected : value < expected;
}
