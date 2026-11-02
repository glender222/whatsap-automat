/**
 * Masks an API key for safe public UI representation and logging.
 * Returns null or masked string (e.g. 'sk-...4f2a', 'sk-ant-...98b1').
 */
export function maskApiKey(apiKey?: string | null): string | null {
  if (!apiKey) return null;
  const trimmed = apiKey.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length <= 8) return '****';

  const last4 = trimmed.slice(-4);
  let prefix = 'sk-...';
  if (trimmed.startsWith('sk-ant-')) {
    prefix = 'sk-ant-...';
  } else if (trimmed.startsWith('sk-proj-')) {
    prefix = 'sk-proj-...';
  } else if (trimmed.startsWith('sk-')) {
    prefix = 'sk-...';
  } else {
    prefix = `${trimmed.slice(0, 3)}...`;
  }

  return `${prefix}${last4}`;
}
