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

export class MarketplaceError extends Error {
  constructor(readonly statusCode: number, message: string, readonly errors?: string[]) {
    super(message);
  }
}

export interface MarketplacePublication {
  id: string;
  extensionId: string;
  displayName: string;
  version: string;
  type: 'channel' | 'tool' | 'ui';
  state: 'published' | 'withdrawn';
  publishedAt: string;
  withdrawnAt: string | null;
}
