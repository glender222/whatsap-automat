import {
  ExtensionManifest,
  MarketplaceListing,
  ExtensionRating,
  MarketplaceSearchQuery,
} from '@whatsap-automat/contracts';

export interface RegisterExtensionOptions {
  readonly manifest: ExtensionManifest;
  readonly tarballBuffer?: Buffer;
  readonly expectedSha256?: string;
  readonly tarballUrl?: string;
  readonly displayName?: string;
  readonly longDescription?: string;
  readonly categories?: string[];
  readonly tags?: string[];
  readonly verified?: boolean;
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
