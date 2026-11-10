# @whatsap-automat/cli

Developer CLI tool for scaffolding, validating, packaging, and diagnosing Whatsap-Automat extensions.

## Usage

```bash
# Display help
automat --help

# Initialize a new extension
automat init my-channel --type=channel
automat init my-tool --type=tool
automat init my-ui --type=ui

# Validate manifest schema and permissions (SEC-009)
automat validate manifest.json

# Pack extension into .tgz archive with sha256 checksum
automat pack .

# Verify a signed archive against a separately obtained administrator authorization
automat verify extension.tgz --proof extension.proof.json --trust release-trust.json --json

# Inspect the contents of the same signed archive before staging
automat inspect extension.tgz --proof extension.proof.json --trust release-trust.json --json

# System environment diagnostics
automat doctor
```

`automat pack` expects a source directory under the developer's control. It accepts regular
files and directories in the included tree. Symbolic links and special files cause packing
to fail before the archive is written.

## Offline package verification

The verifier checks the exact archive bytes, registry, publisher tenant, listing, extension identity, and version. It reads a detached proof from the publisher and a separate local release authorization obtained through a trusted administrator channel. Treat the authorization file as a trust root and keep it under local administrative control. Use a fresh authorization to reflect publisher key revocation or listing withdrawal. Offline verification uses the supplied authorization and the local clock.

Both JSON documents contain an `artifact` object with these fields in the following signing order.

| Field | Meaning |
| --- | --- |
| `registryId` | Administrator-selected identifier of the catalog |
| `publisherTenantId` | Catalog-authenticated publisher identity as a string |
| `listingId` | Stable `ext_` listing identifier |
| `extensionId` | Canonical extension identifier from the catalog |
| `version` | Exact catalog version |
| `sha256` | Lowercase hex digest of the archive bytes pinned for that version |
| `sizeBytes` | Exact archive length as a positive JSON integer |

The proof has `format` equal to `automat-extension-proof-v1`, the `artifact` object, `keyId`, and `signature`. `keyId` is the lowercase SHA-256 hex digest of the Ed25519 public key in SPKI DER. `signature` is standard padded base64 of the 64-byte Ed25519 signature over these bytes.

```js
Buffer.from('automat-extension-proof-v1\n' + JSON.stringify([
  artifact.registryId, artifact.publisherTenantId, artifact.listingId,
  artifact.extensionId, artifact.version, artifact.sha256, artifact.sizeBytes,
  keyId,
]), 'utf8');
```

The release authorization has `format` equal to `automat-extension-trust-v1`, the `artifact` object, `expiresAt` as a UTC ISO timestamp, and `keys`. Each key contains `keyId`, `publicKeySpki` as standard padded base64 of the Ed25519 SPKI DER, and `status` set to `active` or `revoked`. The administrator verifies ownership and pins the release before distributing this authorization. Keep publisher private keys outside the package and the authorization file.

Use regular local files. Verification reads at most 64 MiB for the archive, 8 KiB for the proof, and 64 KiB for the authorization, with up to 32 keys. A successful check exits with code `0`. Failures exit with code `1` and provide a stable error code. `--json` returns the release identity and authorized key fingerprint on success.

## Signed package inspection

`automat inspect` verifies the release with the same proof and authorization as `automat verify`.
It inspects a snapshot of the bytes that passed verification and reports the extension type,
entrypoints, number of files, and expanded size. With `--json`, success returns
`inspected: true` and the signed release identity. Failure exits with code `1` and reports
`inspected: false` with a stable error code.

The inspection accepts gzip-compressed POSIX USTAR with regular files and implicit
directories, as emitted by `automat pack`. It checks tar headers and archive termination.
Paths must use safe relative UTF-8 names in NFC with at most 32 components. Duplicate paths,
case collisions, file/directory collisions, symlinks, hard links, and special tar records
are rejected. The tar may expand to at most 64 MiB, contain up to 4,096 files, and hold
individual files of at most 32 MiB.

The archive needs a root `manifest.json` of at most 64 KiB. The manifest must match the
canonical schema and signed extension ID and version, pass the existing forbidden-scope
checks, and name entrypoints included in the archive. Build the extension before packing
if the manifest points to generated files.

Inspection is an offline format and identity check. It keeps the archive inert and creates
no staging files. Installation permissions and executable isolation remain separate gates.
A future staging workflow must consume the same verified snapshot because the local path can
change after inspection.
