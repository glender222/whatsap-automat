import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import * as crypto from 'node:crypto';

export interface PackedResult {
  gzBuffer: Buffer;
  includedFiles: string[];
}

export function shouldExclude(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/');
  const parts = normalized.split('/');
  for (const part of parts) {
    if (part === 'node_modules' || part === '.git' || part === 'coverage' || part === '.agents') {
      return true;
    }
    if (part === '.env' || part.startsWith('.env.')) {
      return true;
    }
  }
  if (normalized.endsWith('.tgz') || normalized.endsWith('.sha256') || normalized.endsWith('.tar.gz')) {
    return true;
  }
  return false;
}

export function createUStarHeader(
  name: string,
  size: number,
  mode = 0o644,
  mtime = Math.floor(Date.now() / 1000)
): Buffer {
  const buf = Buffer.alloc(512);

  let prefix = '';
  let shortName = name;
  if (name.length > 100) {
    const idx = name.indexOf('/');
    if (idx !== -1 && idx <= 155) {
      prefix = name.substring(0, idx);
      shortName = name.substring(idx + 1);
    }
  }

  buf.write(shortName, 0, 100, 'utf8');
  buf.write(mode.toString(8).padStart(6, '0') + ' \0', 100, 8, 'ascii');
  buf.write('000000 \0', 108, 8, 'ascii'); // uid
  buf.write('000000 \0', 116, 8, 'ascii'); // gid
  buf.write(size.toString(8).padStart(11, '0') + ' ', 124, 12, 'ascii');
  buf.write(mtime.toString(8).padStart(11, '0') + ' ', 136, 12, 'ascii');
  buf.fill(0x20, 148, 156); // 8 spaces for checksum calculation
  buf[156] = 0x30; // regular file
  buf.write('ustar', 257, 5, 'ascii');
  buf.write('00', 263, 2, 'ascii');
  buf.write('automat', 265, 7, 'ascii');
  buf.write('automat', 297, 7, 'ascii');
  if (prefix) {
    buf.write(prefix, 345, 155, 'utf8');
  }

  let sum = 0;
  for (let i = 0; i < 512; i++) {
    sum += buf[i]!;
  }
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return buf;
}

export function packDirectoryToTarGz(dir: string): PackedResult {
  const includedFiles: string[] = [];
  const buffers: Buffer[] = [];

  function walk(currentDir: string, baseDir: string) {
    const items = fs.readdirSync(currentDir);
    for (const item of items) {
      const fullPath = path.join(currentDir, item);
      const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');

      if (shouldExclude(relPath)) {
        continue;
      }

      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        walk(fullPath, baseDir);
      } else if (stat.isFile()) {
        const fileContent = fs.readFileSync(fullPath);
        const header = createUStarHeader(relPath, fileContent.length, stat.mode & 0o777, Math.floor(stat.mtimeMs / 1000));
        buffers.push(header);
        buffers.push(fileContent);
        const remainder = fileContent.length % 512;
        if (remainder !== 0) {
          buffers.push(Buffer.alloc(512 - remainder));
        }
        includedFiles.push(relPath);
      }
    }
  }

  walk(dir, dir);

  // End of archive marker: 1024 zero bytes
  buffers.push(Buffer.alloc(1024));

  const tarBuffer = Buffer.concat(buffers);
  const gzBuffer = zlib.gzipSync(tarBuffer, { level: zlib.constants.Z_BEST_COMPRESSION });

  return { gzBuffer, includedFiles };
}

export function readTarGzEntries(gzBuffer: Buffer): { name: string; size: number; content: Buffer }[] {
  const tarBuf = zlib.gunzipSync(gzBuffer);
  const entries: { name: string; size: number; content: Buffer }[] = [];
  let offset = 0;

  while (offset + 512 <= tarBuf.length) {
    const header = tarBuf.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;

    let name = header.toString('utf8', 0, 100).replace(/\0.*$/, '');
    const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/, '');
    if (prefix) name = prefix + '/' + name;

    const sizeStr = header.toString('ascii', 124, 136).trim().replace(/\0.*$/, '');
    const size = parseInt(sizeStr, 8) || 0;
    offset += 512;

    const content = tarBuf.subarray(offset, offset + size);
    entries.push({ name, size, content });

    const remainder = size % 512;
    offset += size + (remainder !== 0 ? 512 - remainder : 0);
  }

  return entries;
}

export function calculateSha256(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}
