/**
 * Whatsap-Automat Phase F8 SRE Diagnostic Doctor Engine
 *
 * Implements comprehensive battery of health, security, database, and runtime checks.
 * Enforces secret redaction on all diagnostic evidence.
 */

import { Pool, PoolClient } from 'pg';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import pool from '../../config/database';

export type DiagnosticStatus = 'PASS' | 'WARN' | 'FAIL';

export type DiagnosticCategory =
  | 'database'
  | 'security'
  | 'cache'
  | 'disk'
  | 'runtime'
  | 'sandbox'
  | 'network';

export interface DiagnosticCheckResult {
  code: string;
  name: string;
  category: DiagnosticCategory;
  status: DiagnosticStatus;
  latencyMs: number;
  details: string;
  remediationGuide?: string;
}

export interface DiagnosticReport {
  timestamp: string;
  total: number;
  passed: number;
  warnings: number;
  failed: number;
  overallStatus: DiagnosticStatus;
  executionDurationMs: number;
  checks: DiagnosticCheckResult[];
}

export interface DiagnosticDoctorOptions {
  pool?: Pool;
  skipDatabase?: boolean;
  skipNetwork?: boolean;
  migrationsDir?: string;
  tempDir?: string;
  secretRedactor?: (input: string) => string;
}

/**
 * Universal secret redaction scrubber for SRE diagnostic outputs.
 * Scrubs passwords, bearer tokens, JWTs, master keys, and DB connection strings.
 */
export function redactDiagnosticSecrets(input: string): string {
  if (!input) return '';
  let sanitized = String(input);

  // Mask database connection URLs with passwords: postgresql://user:pass@host:port/db
  sanitized = sanitized.replace(/(postgres(?:ql)?:\/\/[^:]+:)([^@]+)(@)/gi, '$1[REDACTED]$3');

  // Mask JWT tokens: eyJ...
  sanitized = sanitized.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED_JWT]');

  // Mask Bearer tokens: Bearer xxx
  sanitized = sanitized.replace(/(Bearer\s+)[A-Za-z0-9_\-\.]{8,}/gi, '$1[REDACTED]');

  // Mask sensitive key-value pairs: password=xxx, secret=xxx, apiKey=xxx, token=xxx
  sanitized = sanitized.replace(
    /(["']?(?:password|secret|apiKey|token|masterKey|encryptionKey)["']?\s*[:=]\s*["']?)([^"',\s\}]{4,})(["']?)/gi,
    '$1[REDACTED]$3'
  );

  return sanitized;
}

export class DiagnosticDoctor {
  private readonly pool?: Pool;
  private readonly skipDatabase: boolean;
  private readonly skipNetwork: boolean;
  private readonly migrationsDir: string;
  private readonly tempDir: string;
  private readonly customRedactor?: (input: string) => string;

  constructor(options: DiagnosticDoctorOptions = {}) {
    this.pool = options.pool ?? pool;
    this.skipDatabase = Boolean(options.skipDatabase);
    this.skipNetwork = Boolean(options.skipNetwork);
    this.migrationsDir = options.migrationsDir ?? path.join(__dirname, '../../db/migrations');
    this.tempDir = options.tempDir ?? os.tmpdir();
    this.customRedactor = options.secretRedactor;
  }

  public redact(text: string): string {
    const base = redactDiagnosticSecrets(text);
    return this.customRedactor ? this.customRedactor(base) : base;
  }

  /**
   * DB-PG-001: PostgreSQL Connection Pool Liveness & Latency
   */
  async checkDatabaseLiveness(poolInstance?: Pool): Promise<DiagnosticCheckResult> {
    const start = Date.now();
    const activePool = poolInstance ?? this.pool;

    if (!activePool) {
      return {
        code: 'DB-PG-001',
        name: 'PostgreSQL Pool Connection & Latency',
        category: 'database',
        status: 'FAIL',
        latencyMs: 0,
        details: 'No database connection pool configured',
        remediationGuide: 'Configure PostgreSQL connection settings in .env.',
      };
    }

    try {
      const client: PoolClient = await activePool.connect();
      try {
        const res = await client.query(`
          SELECT 
            1 AS alive, 
            NOW() AS server_time, 
            current_database() AS db_name,
            current_user AS db_user,
            version() AS pg_version
        `);
        const latencyMs = Date.now() - start;
        const row = res.rows[0] || {};
        return {
          code: 'DB-PG-001',
          name: 'PostgreSQL Pool Connection & Latency',
          category: 'database',
          status: latencyMs > 2000 ? 'WARN' : 'PASS',
          latencyMs,
          details: `Connected to database "${this.redact(String(row.db_name))}" as user "${this.redact(String(row.db_user))}" (${latencyMs}ms)`,
          remediationGuide:
            latencyMs > 2000
              ? 'Database ping latency is elevated (>2000ms). Review connection pool sizing and network latency.'
              : undefined,
        };
      } finally {
        client.release();
      }
    } catch (err: any) {
      const latencyMs = Date.now() - start;
      return {
        code: 'DB-PG-001',
        name: 'PostgreSQL Pool Connection & Latency',
        category: 'database',
        status: 'FAIL',
        latencyMs,
        details: this.redact(`Database connection failed: ${err.message || String(err)} [code: ${err.code || 'UNKNOWN'}]`),
        remediationGuide: 'Verify PostgreSQL service is active and DB_HOST, DB_PORT, DB_USER, DB_PASSWORD in .env are correct.',
      };
    }
  }

  /**
   * DB-MIG-001: Database Migration Status Check
   */
  async checkMigrationStatus(poolInstance?: Pool, customMigrationsDir?: string): Promise<DiagnosticCheckResult> {
    const start = Date.now();
    const activePool = poolInstance ?? this.pool;
    const targetDir = customMigrationsDir ?? this.migrationsDir;

    if (!activePool) {
      return {
        code: 'DB-MIG-001',
        name: 'Database Migration Status',
        category: 'database',
        status: 'FAIL',
        latencyMs: 0,
        details: 'Database pool unavailable for migration inspection',
        remediationGuide: 'Ensure database is connected.',
      };
    }

    try {
      // Check if schema_migrations table exists
      const tableCheck = await activePool.query(`
        SELECT to_regclass('schema_migrations') AS exists
      `);
      if (!tableCheck.rows[0]?.exists) {
        return {
          code: 'DB-MIG-001',
          name: 'Database Migration Status',
          category: 'database',
          status: 'FAIL',
          latencyMs: Date.now() - start,
          details: 'schema_migrations tracking table does not exist',
          remediationGuide: 'Run "npm run db:migrate" to initialize migrations tracking table and apply migrations.',
        };
      }

      const { rows } = await activePool.query<{ version: string }>(
        'SELECT version FROM schema_migrations ORDER BY version ASC'
      );
      const appliedVersions = new Set(rows.map((r) => r.version));

      if (!fs.existsSync(targetDir)) {
        return {
          code: 'DB-MIG-001',
          name: 'Database Migration Status',
          category: 'database',
          status: 'WARN',
          latencyMs: Date.now() - start,
          details: `Migrations directory "${targetDir}" not found on disk`,
          remediationGuide: 'Ensure migrations directory is present in distribution.',
        };
      }

      const diskFiles = fs
        .readdirSync(targetDir)
        .filter((f) => f.endsWith('.sql'))
        .sort();
      const unapplied = diskFiles.filter((f) => !appliedVersions.has(path.basename(f, '.sql')));
      const latencyMs = Date.now() - start;

      if (unapplied.length > 0) {
        return {
          code: 'DB-MIG-001',
          name: 'Database Migration Status',
          category: 'database',
          status: 'FAIL',
          latencyMs,
          details: `${unapplied.length} pending migration(s): ${unapplied.slice(0, 3).join(', ')}${
            unapplied.length > 3 ? '...' : ''
          } (applied: ${appliedVersions.size}/${diskFiles.length})`,
          remediationGuide: 'Execute "npm run db:migrate" to apply pending migrations.',
        };
      }

      return {
        code: 'DB-MIG-001',
        name: 'Database Migration Status',
        category: 'database',
        status: 'PASS',
        latencyMs,
        details: `All ${diskFiles.length} migrations applied cleanly (latest: ${
          diskFiles[diskFiles.length - 1] || 'none'
        })`,
      };
    } catch (err: any) {
      return {
        code: 'DB-MIG-001',
        name: 'Database Migration Status',
        category: 'database',
        status: 'FAIL',
        latencyMs: Date.now() - start,
        details: this.redact(`Failed checking migrations: ${err.message}`),
        remediationGuide: 'Check database connectivity and permissions on schema_migrations table.',
      };
    }
  }

  /**
   * SEC-ENC-001: MASTER_ENCRYPTION_KEY & AES-256-GCM Cipher Readiness
   */
  async checkMasterEncryptionKey(): Promise<DiagnosticCheckResult> {
    const start = Date.now();
    const rawKey = process.env.MASTER_ENCRYPTION_KEY || process.env.META_TOKEN_ENCRYPTION_KEY;

    if (!rawKey) {
      return {
        code: 'SEC-ENC-001',
        name: 'Master Encryption Key & Cipher Readiness',
        category: 'security',
        status: 'FAIL',
        latencyMs: Date.now() - start,
        details: 'MASTER_ENCRYPTION_KEY environment variable is not defined',
        remediationGuide:
          'Set MASTER_ENCRYPTION_KEY in .env with a secure 32-byte string or 64-character hex key.',
      };
    }

    const trimmed = rawKey.trim();
    let keyBuffer: Buffer;

    if (trimmed.length === 64 && /^[0-9a-fA-F]+$/.test(trimmed)) {
      keyBuffer = Buffer.from(trimmed, 'hex');
    } else if (trimmed.length === 44 && /^[A-Za-z0-9+/=]+$/.test(trimmed)) {
      keyBuffer = Buffer.from(trimmed, 'base64');
    } else if (trimmed.length >= 32) {
      keyBuffer = crypto.createHash('sha256').update(trimmed).digest();
    } else {
      return {
        code: 'SEC-ENC-001',
        name: 'Master Encryption Key & Cipher Readiness',
        category: 'security',
        status: 'FAIL',
        latencyMs: Date.now() - start,
        details: `MASTER_ENCRYPTION_KEY is too short (${trimmed.length} chars, minimum 32 chars required)`,
        remediationGuide: 'Generate a 32-byte key: "openssl rand -hex 32" and set MASTER_ENCRYPTION_KEY in .env.',
      };
    }

    if (keyBuffer.length !== 32) {
      return {
        code: 'SEC-ENC-001',
        name: 'Master Encryption Key & Cipher Readiness',
        category: 'security',
        status: 'FAIL',
        latencyMs: Date.now() - start,
        details: `Derived key length is ${keyBuffer.length} bytes (32 bytes required for AES-256-GCM)`,
        remediationGuide: 'Provide a valid 32-byte key.',
      };
    }

    // Roundtrip canary verification
    try {
      const canary = 'sre_diagnostic_canary_' + Date.now();
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', keyBuffer, iv);
      const ciphertext = Buffer.concat([cipher.update(canary, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();

      const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuffer, iv);
      decipher.setAuthTag(tag);
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');

      if (decrypted !== canary) {
        throw new Error('Canary decrypted plaintext did not match original');
      }

      return {
        code: 'SEC-ENC-001',
        name: 'Master Encryption Key & Cipher Readiness',
        category: 'security',
        status: 'PASS',
        latencyMs: Date.now() - start,
        details: `Key configured [32-byte AES-256-GCM operational, format: ${
          trimmed.length === 64 ? 'hex' : trimmed.length === 44 ? 'base64' : 'passphrase'
        }]`,
      };
    } catch (err: any) {
      return {
        code: 'SEC-ENC-001',
        name: 'Master Encryption Key & Cipher Readiness',
        category: 'security',
        status: 'FAIL',
        latencyMs: Date.now() - start,
        details: this.redact(`Cipher readiness test failed: ${err.message}`),
        remediationGuide: 'Check Node crypto provider and MASTER_ENCRYPTION_KEY format.',
      };
    }
  }

  /**
   * SEC-JWT-001: JWT_SECRET Strength & Entropy
   */
  async checkJwtSecret(): Promise<DiagnosticCheckResult> {
    const start = Date.now();
    const secret = process.env.JWT_SECRET || '';
    const trimmed = secret.trim();

    if (!trimmed) {
      return {
        code: 'SEC-JWT-001',
        name: 'JWT Secret Strength & Entropy',
        category: 'security',
        status: 'FAIL',
        latencyMs: Date.now() - start,
        details: 'JWT_SECRET environment variable is unset',
        remediationGuide: 'Configure JWT_SECRET in .env with at least 32 high-entropy characters.',
      };
    }

    if (trimmed.length < 32) {
      return {
        code: 'SEC-JWT-001',
        name: 'JWT Secret Strength & Entropy',
        category: 'security',
        status: 'FAIL',
        latencyMs: Date.now() - start,
        details: `JWT_SECRET length is ${trimmed.length} characters (< 32 required)`,
        remediationGuide: 'Expand JWT_SECRET to at least 32 characters to prevent HMAC brute-force attacks.',
      };
    }

    const weakDefaults = [
      'test-only-database-password',
      'secret',
      'changeme',
      'password',
      '12345678901234567890123456789012',
    ];
    const isWeak = weakDefaults.includes(trimmed.toLowerCase());
    const isProduction = (process.env.NODE_ENV || 'development') === 'production';

    if (isWeak && isProduction) {
      return {
        code: 'SEC-JWT-001',
        name: 'JWT Secret Strength & Entropy',
        category: 'security',
        status: 'FAIL',
        latencyMs: Date.now() - start,
        details: 'JWT_SECRET matches a known insecure default value in production',
        remediationGuide: 'Generate a fresh random secret with "openssl rand -base64 32".',
      };
    }

    return {
      code: 'SEC-JWT-001',
      name: 'JWT Secret Strength & Entropy',
      category: 'security',
      status: isWeak ? 'WARN' : 'PASS',
      latencyMs: Date.now() - start,
      details: `JWT_SECRET is valid [configured, ${trimmed.length} characters]${
        isWeak ? ' (warning: default development secret in use)' : ''
      }`,
      remediationGuide: isWeak ? 'Replace default secret before deploying to staging/production.' : undefined,
    };
  }

  /**
   * REDIS-001 / CACHE-001: Cache & State Store Availability
   */
  async checkCacheAvailability(): Promise<DiagnosticCheckResult> {
    const start = Date.now();
    const redisUrl = process.env.REDIS_URL || process.env.CACHE_URL;

    if (!redisUrl) {
      return {
        code: 'CACHE-001',
        name: 'Cache & State Store Availability',
        category: 'cache',
        status: 'PASS',
        latencyMs: Date.now() - start,
        details: 'REDIS_URL not configured; using local in-memory state store (single-node mode)',
        remediationGuide: 'If deploying multi-instance horizontally scaled nodes, set REDIS_URL.',
      };
    }

    try {
      const url = new URL(redisUrl);
      const host = url.hostname;
      const port = parseInt(url.port || '6379', 10);

      await new Promise<boolean>((resolve, reject) => {
        const net = require('node:net');
        const socket = new net.Socket();
        socket.setTimeout(2000);
        socket.on('connect', () => {
          socket.destroy();
          resolve(true);
        });
        socket.on('timeout', () => {
          socket.destroy();
          reject(new Error('Redis connection timed out after 2000ms'));
        });
        socket.on('error', (err: any) => {
          socket.destroy();
          reject(err);
        });
        socket.connect(port, host);
      });

      return {
        code: 'REDIS-001',
        name: 'Redis Cache & State Store Ping',
        category: 'cache',
        status: 'PASS',
        latencyMs: Date.now() - start,
        details: `Connected to Redis at ${this.redact(host)}:${port} (${Date.now() - start}ms)`,
      };
    } catch (err: any) {
      return {
        code: 'REDIS-001',
        name: 'Redis Cache & State Store Ping',
        category: 'cache',
        status: 'WARN',
        latencyMs: Date.now() - start,
        details: this.redact(`Redis unreachable: ${err.message}`),
        remediationGuide: 'Verify Redis service status or unset REDIS_URL to fallback to in-memory cache.',
      };
    }
  }

  /**
   * DISK-001: Workspace Disk Space & Write Capability
   */
  async checkDiskWritableAndSpace(targetDir: string = this.tempDir): Promise<DiagnosticCheckResult> {
    const start = Date.now();
    const probeFile = path.join(
      targetDir,
      `.diag_disk_probe_${Date.now()}_${Math.random().toString(36).substring(7)}`
    );

    try {
      const payload = Buffer.from('sre_diag_probe');
      fs.writeFileSync(probeFile, payload);
      const readBack = fs.readFileSync(probeFile);
      fs.unlinkSync(probeFile);

      if (!readBack.equals(payload)) {
        throw new Error('Data read back did not match written probe payload');
      }

      let freeMb = -1;
      let totalMb = -1;
      if (typeof (fs as any).statfsSync === 'function') {
        try {
          const stats = (fs as any).statfsSync(targetDir);
          freeMb = Math.round((Number(stats.bavail) * Number(stats.bsize)) / (1024 * 1024));
          totalMb = Math.round((Number(stats.blocks) * Number(stats.bsize)) / (1024 * 1024));
        } catch {
          // ignore statfs failure in virtual environments
        }
      }

      const latencyMs = Date.now() - start;
      if (freeMb >= 0 && freeMb < 100) {
        return {
          code: 'DISK-001',
          name: 'Workspace Disk Space & Write Capability',
          category: 'disk',
          status: 'FAIL',
          latencyMs,
          details: `Disk space critically low: ${freeMb} MB free of ${totalMb} MB (minimum 100 MB required)`,
          remediationGuide: 'Free up disk space on workspace volume immediately.',
        };
      }

      if (freeMb >= 0 && freeMb < 1024) {
        return {
          code: 'DISK-001',
          name: 'Workspace Disk Space & Write Capability',
          category: 'disk',
          status: 'WARN',
          latencyMs,
          details: `Disk space is low: ${freeMb} MB free of ${totalMb} MB`,
          remediationGuide: 'Consider expanding disk volume or pruning old logs and build artifacts.',
        };
      }

      return {
        code: 'DISK-001',
        name: 'Workspace Disk Space & Write Capability',
        category: 'disk',
        status: 'PASS',
        latencyMs,
        details: `Filesystem read/write verified${freeMb >= 0 ? ` (${freeMb} MB free of ${totalMb} MB)` : ''}`,
      };
    } catch (err: any) {
      try {
        if (fs.existsSync(probeFile)) fs.unlinkSync(probeFile);
      } catch {
        // ignore
      }
      return {
        code: 'DISK-001',
        name: 'Workspace Disk Space & Write Capability',
        category: 'disk',
        status: 'FAIL',
        latencyMs: Date.now() - start,
        details: this.redact(`Disk write failed: ${err.message}`),
        remediationGuide: 'Ensure directory permissions allow write access and volume is not mounted read-only.',
      };
    }
  }

  /**
   * NODE-001: Node.js Runtime Version & Memory Utilization
   */
  async checkNodeRuntime(): Promise<DiagnosticCheckResult> {
    const start = Date.now();
    const version = process.version;
    const major = parseInt(version.replace(/^v/, '').split('.')[0] || '0', 10);
    const mem = process.memoryUsage();
    const heapUsedMb = Math.round(mem.heapUsed / (1024 * 1024));
    const heapTotalMb = Math.round(mem.heapTotal / (1024 * 1024));
    const rssMb = Math.round(mem.rss / (1024 * 1024));

    if (major < 20) {
      return {
        code: 'NODE-001',
        name: 'Node.js Runtime & Memory Utilization',
        category: 'runtime',
        status: 'FAIL',
        latencyMs: Date.now() - start,
        details: `Current Node.js version is ${version} (< v20.0.0 required for native crypto and test runner)`,
        remediationGuide: 'Upgrade Node.js to v20 or v22 LTS.',
      };
    }

    const heapRatio = mem.heapTotal > 0 ? mem.heapUsed / mem.heapTotal : 0;
    const status: DiagnosticStatus = heapRatio > 0.92 ? 'WARN' : 'PASS';

    return {
      code: 'NODE-001',
      name: 'Node.js Runtime & Memory Utilization',
      category: 'runtime',
      status,
      latencyMs: Date.now() - start,
      details: `Node.js ${version} (Heap: ${heapUsedMb}MB / ${heapTotalMb}MB, RSS: ${rssMb}MB)`,
      remediationGuide:
        status === 'WARN'
          ? 'High heap utilization (>92%). Check for memory leaks or increase max-old-space-size.'
          : undefined,
    };
  }

  /**
   * SANDBOX-001: Child Process Execution & Memory Isolation Readiness
   */
  async checkChildProcessSandbox(): Promise<DiagnosticCheckResult> {
    const start = Date.now();
    try {
      const result = spawnSync(
        process.execPath,
        ['--max-old-space-size=64', '-e', 'process.stdout.write("sandbox_ok")'],
        {
          timeout: 3000,
          env: { PATH: process.env.PATH, NODE_ENV: 'production' },
        }
      );

      const latencyMs = Date.now() - start;
      if (result.error) {
        throw result.error;
      }

      if (result.status !== 0 || result.stdout?.toString() !== 'sandbox_ok') {
        throw new Error(`Child process exited with status ${result.status}: ${result.stderr?.toString() || 'unknown'}`);
      }

      return {
        code: 'SANDBOX-001',
        name: 'Child Process Sandbox & Memory Isolation',
        category: 'sandbox',
        status: 'PASS',
        latencyMs,
        details: 'Child process execution with memory limits (--max-old-space-size) verified',
      };
    } catch (err: any) {
      return {
        code: 'SANDBOX-001',
        name: 'Child Process Sandbox & Memory Isolation',
        category: 'sandbox',
        status: 'WARN',
        latencyMs: Date.now() - start,
        details: this.redact(`Child process isolation check failed: ${err.message}`),
        remediationGuide: 'Ensure host environment allows child process spawning and execution.',
      };
    }
  }

  /**
   * NET-DNS-001: External Network DNS Resolution Readiness
   */
  async checkNetworkDns(): Promise<DiagnosticCheckResult> {
    const start = Date.now();
    if (this.skipNetwork) {
      return {
        code: 'NET-DNS-001',
        name: 'External Network DNS Resolution',
        category: 'network',
        status: 'PASS',
        latencyMs: 0,
        details: 'Network checks skipped by configuration (--skip-network)',
      };
    }

    try {
      const dns = require('node:dns').promises;
      const host = 'graph.facebook.com';
      await dns.lookup(host);
      return {
        code: 'NET-DNS-001',
        name: 'External Network DNS Resolution',
        category: 'network',
        status: 'PASS',
        latencyMs: Date.now() - start,
        details: `Resolved DNS for "${host}" (${Date.now() - start}ms)`,
      };
    } catch (err: any) {
      return {
        code: 'NET-DNS-001',
        name: 'External Network DNS Resolution',
        category: 'network',
        status: 'WARN',
        latencyMs: Date.now() - start,
        details: this.redact(`DNS resolution failed: ${err.message}`),
        remediationGuide: 'Verify internet connectivity or DNS resolver configuration for outbound webhooks.',
      };
    }
  }

  /**
   * Executes the full battery of diagnostic checks and returns the aggregated DiagnosticReport.
   */
  async runAll(): Promise<DiagnosticReport> {
    const startTime = Date.now();
    const checks: DiagnosticCheckResult[] = [];

    // 1. Runtime
    checks.push(await this.checkNodeRuntime());

    // 2. Sandbox
    checks.push(await this.checkChildProcessSandbox());

    // 3. Disk
    checks.push(await this.checkDiskWritableAndSpace());

    // 4. Security
    checks.push(await this.checkMasterEncryptionKey());
    checks.push(await this.checkJwtSecret());

    // 5. Cache
    checks.push(await this.checkCacheAvailability());

    // 6. Network
    checks.push(await this.checkNetworkDns());

    // 7. Database (if not skipped)
    if (!this.skipDatabase && this.pool) {
      checks.push(await this.checkDatabaseLiveness(this.pool));
      checks.push(await this.checkMigrationStatus(this.pool, this.migrationsDir));
    }

    const total = checks.length;
    const passed = checks.filter((c) => c.status === 'PASS').length;
    const warnings = checks.filter((c) => c.status === 'WARN').length;
    const failed = checks.filter((c) => c.status === 'FAIL').length;
    const overallStatus: DiagnosticStatus = failed > 0 ? 'FAIL' : warnings > 0 ? 'WARN' : 'PASS';

    return {
      timestamp: new Date().toISOString(),
      total,
      passed,
      warnings,
      failed,
      overallStatus,
      executionDurationMs: Date.now() - startTime,
      checks,
    };
  }
}

export default DiagnosticDoctor;
