import { gunzipSync } from 'node:zlib';
import { extensionManifestSchema, validateMarketplacePermissions } from '@whatsap-automat/contracts';
import { loadVerifiedArchive, PackageVerificationError } from './packageProof';

const blockSize = 512;
const expandedLimit = 64 * 1024 * 1024;
const fileLimit = 32 * 1024 * 1024;
const manifestLimit = 64 * 1024;
const entryLimit = 4096;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const windowsDevice = /^(con|prn|aux|nul|conin\$|conout\$|(?:com|lpt)[1-9¹²³])(?:\.|$)/iu;

function fail(code: string, message: string): never {
  throw new PackageVerificationError(code, message);
}

function isZero(data: Buffer): boolean {
  return data.every((byte) => byte === 0);
}

function decodeHeaderPath(field: Buffer): string {
  const end = field.indexOf(0);
  if (end !== -1 && !isZero(field.subarray(end))) {
    fail('ARCHIVE_FORMAT_INVALID', 'Tar path contains data after its terminator.');
  }
  try {
    return decoder.decode(field.subarray(0, end === -1 ? field.length : end));
  } catch {
    return fail('ARCHIVE_FORMAT_INVALID', 'Tar path is not valid UTF-8.');
  }
}

function pathSegments(name: string): string[] {
  const segments = name.split('/');
  if (name !== name.normalize('NFC') || segments.length > 32 ||
    segments.some((part) => !part || part === '.' || part === '..' ||
      /[\x00-\x1f\x7f-\x9f<>:"\\|?*\p{Cf}]/u.test(part) ||
      /[. ]$/.test(part) || windowsDevice.test(part))) {
    fail('ARCHIVE_PATH_INVALID', 'Expected a safe relative package path.');
  }
  return segments;
}

function octal(field: Buffer): number {
  const value = /^[ ]*([0-7]+)[ \0]*$/.exec(field.toString('latin1'));
  if (!value) fail('ARCHIVE_FORMAT_INVALID', 'Tar header contains an invalid numeric field.');
  return Number.parseInt(value[1]!, 8);
}

function readEntry(header: Buffer): { name: string; size: number } {
  if (header.toString('latin1', 257, 265) !== 'ustar\x0000') {
    fail('ARCHIVE_FORMAT_INVALID', 'Expected POSIX USTAR headers.');
  }
  let checksum = 0;
  for (const byte of header.subarray(0, 148)) checksum += byte;
  checksum += 8 * 0x20;
  for (const byte of header.subarray(156)) checksum += byte;
  if (checksum !== octal(header.subarray(148, 156))) {
    fail('ARCHIVE_FORMAT_INVALID', 'Tar header checksum is invalid.');
  }
  if ((header[156] !== 0x30 && header[156] !== 0) || !isZero(header.subarray(157, 257))) {
    fail('ARCHIVE_ENTRY_UNSUPPORTED', 'Only regular USTAR file entries are supported.');
  }
  const prefix = decodeHeaderPath(header.subarray(345, 500));
  const name = decodeHeaderPath(header.subarray(0, 100));
  const size = octal(header.subarray(124, 136));
  return { name: prefix ? `${prefix}/${name}` : name, size };
}

function recordPath(
  paths: Map<string, { name: string; file: boolean }>,
  name: string,
): void {
  const segments = pathSegments(name);
  let parent = '';
  for (const [index, segment] of segments.entries()) {
    parent += parent ? `/${segment}` : segment;
    const key = parent.toUpperCase().normalize('NFC');
    const file = index === segments.length - 1;
    const previous = paths.get(key);
    if (previous && (previous.name !== parent || previous.file || file)) {
      fail('ARCHIVE_PATH_COLLISION', 'Tar entries contain duplicate or conflicting paths.');
    }
    paths.set(key, { name: parent, file });
  }
}

function readTar(archive: Buffer) {
  let decompressed: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    // The info option exposes the compressed byte count consumed by zlib.
    decompressed = gunzipSync(archive, { maxOutputLength: expandedLimit, info: true }) as unknown as typeof decompressed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
      return fail('ARCHIVE_EXPANSION_LIMIT', 'Expanded tar exceeds the 64 MiB limit.');
    }
    return fail('ARCHIVE_FORMAT_INVALID', 'Expected a valid gzip archive.');
  }
  if (decompressed.engine.bytesWritten !== archive.length) {
    fail('ARCHIVE_FORMAT_INVALID', 'Gzip data is followed by unconsumed bytes.');
  }
  const tar = decompressed.buffer;
  if (tar.length % blockSize !== 0) fail('ARCHIVE_FORMAT_INVALID', 'Tar is not block aligned.');

  const paths = new Map<string, { name: string; file: boolean }>();
  const files = new Set<string>();
  let manifest: Buffer | undefined;
  let offset = 0;
  while (offset + blockSize <= tar.length) {
    const header = tar.subarray(offset, offset + blockSize);
    if (isZero(header)) {
      if (tar.length - offset < 2 * blockSize || !isZero(tar.subarray(offset))) {
        fail('ARCHIVE_FORMAT_INVALID', 'Tar end marker is incomplete or followed by data.');
      }
      return { manifest, files, expandedBytes: tar.length };
    }

    if (files.size >= entryLimit) fail('ARCHIVE_ENTRY_LIMIT', 'Tar exceeds the 4096-entry limit.');
    const { name, size } = readEntry(header);
    recordPath(paths, name);
    if (size > fileLimit) fail('ARCHIVE_ENTRY_TOO_LARGE', 'A tar entry exceeds the 32 MiB limit.');
    files.add(name);

    const start = offset + blockSize;
    const end = start + size;
    offset = start + Math.ceil(size / blockSize) * blockSize;
    if (offset > tar.length || !isZero(tar.subarray(end, offset))) {
      fail('ARCHIVE_FORMAT_INVALID', 'Tar entry is truncated or has invalid padding.');
    }
    if (name === 'manifest.json') {
      if (size > manifestLimit) fail('MANIFEST_TOO_LARGE', 'Manifest exceeds the 64 KiB limit.');
      manifest = tar.subarray(start, end);
    }
  }
  return fail('ARCHIVE_FORMAT_INVALID', 'Tar end marker is missing.');
}

function readManifest(data: Buffer | undefined) {
  if (!data) fail('MANIFEST_MISSING', 'Tar must contain a root manifest.json.');
  let input: unknown;
  try {
    input = JSON.parse(decoder.decode(data));
  } catch {
    return fail('MANIFEST_INVALID', 'Manifest must be valid UTF-8 JSON.');
  }
  const parsed = extensionManifestSchema.safeParse(input);
  if (!parsed.success) fail('MANIFEST_INVALID', 'Manifest does not match the canonical extension schema.');
  const scopes = parsed.data.permissions.map((permission) => permission.trim().toLowerCase());
  if (!validateMarketplacePermissions(scopes).permitted) {
    fail('MANIFEST_PERMISSION_DENIED', 'Manifest requests a forbidden extension scope.');
  }
  return parsed.data;
}

function resolveEntrypoint(name: string, files: ReadonlySet<string>): string {
  const file = name.startsWith('./') ? name.slice(2) : name;
  pathSegments(file);
  if (!files.has(file)) fail('MANIFEST_ENTRYPOINT_MISSING', 'A declared entrypoint is absent from the archive.');
  return file;
}

export async function inspectLocalPackage(archivePath: string, proofPath: string, trustPath: string) {
  const { verified, bytes } = await loadVerifiedArchive(archivePath, proofPath, trustPath);
  const { manifest: data, files, expandedBytes } = readTar(bytes);
  const manifest = readManifest(data);
  if ((manifest.id ?? manifest.name) !== verified.artifact.extensionId || manifest.version !== verified.artifact.version) {
    fail('MANIFEST_RELEASE_MISMATCH', 'Manifest identity or version differs from the authorized release.');
  }
  const entrypoint = resolveEntrypoint(manifest.entrypoint, files);
  const entrypointHtml = manifest.ui?.entrypointHtml === undefined
    ? undefined : resolveEntrypoint(manifest.ui.entrypointHtml, files);
  return {
    ...verified,
    archive: { entries: files.size, expandedBytes },
    manifest: { type: manifest.type, entrypoint, entrypointHtml },
  };
}
