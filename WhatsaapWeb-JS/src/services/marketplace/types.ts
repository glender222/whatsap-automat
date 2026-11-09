import {
  ExtensionManifest,
} from '@whatsap-automat/contracts';

export interface RegisterExtensionOptions {
  readonly publisherTenantId: number;
  readonly manifest: unknown;
  readonly tarballBuffer?: Buffer;
  readonly expectedSha256?: string;
  readonly tarballUrl?: string;
  readonly displayName?: string;
  readonly longDescription?: string;
  readonly categories?: string[];
  readonly tags?: string[];
}

export interface SubmitRatingOptions {
  readonly extensionId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly score: number;
  readonly review?: string;
}

export interface ExtensionValidationReport {
  readonly valid: boolean;
  readonly errors: string[];
  readonly warnings: string[];
  readonly manifest?: ExtensionManifest;
  readonly checksumVerified?: boolean;
}
