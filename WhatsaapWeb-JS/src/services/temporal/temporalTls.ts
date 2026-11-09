import { readFileSync } from 'node:fs';
import type { TLSConfig } from '@temporalio/client';

export function temporalTlsFromEnvironment(env: NodeJS.ProcessEnv = process.env): boolean | TLSConfig | undefined {
  const caFile = env.TEMPORAL_TLS_CA_FILE;
  const certFile = env.TEMPORAL_TLS_CERT_FILE;
  const keyFile = env.TEMPORAL_TLS_KEY_FILE;
  const serverNameOverride = env.TEMPORAL_TLS_SERVER_NAME;
  const hasSettings = Boolean(caFile || certFile || keyFile || serverNameOverride);
  if (env.TEMPORAL_TLS !== 'true') {
    if (hasSettings) throw new Error('Set TEMPORAL_TLS=true to use Temporal TLS credentials');
    return undefined;
  }
  if (Boolean(certFile) !== Boolean(keyFile)) {
    throw new Error('Configure both TEMPORAL_TLS_CERT_FILE and TEMPORAL_TLS_KEY_FILE for mutual TLS');
  }
  if (!hasSettings) return true;

  try {
    return {
      ...(caFile && { serverRootCACertificate: readFileSync(caFile) }),
      ...(certFile && keyFile && { clientCertPair: { crt: readFileSync(certFile), key: readFileSync(keyFile) } }),
      ...(serverNameOverride && { serverNameOverride }),
    };
  } catch {
    throw new Error('Temporal TLS credentials could not be read');
  }
}
