export interface CatalogPublicationIdentity {
  profile: 'catalog-router-v1';
  evidenceVersion: 'catalog-publication-v1';
  evidenceHash: string;
}

export function isCatalogPublicationIdentity(value: { profile?: unknown; evidenceVersion?: unknown; evidenceHash?: unknown } | null | undefined): value is CatalogPublicationIdentity {
  return value?.profile === 'catalog-router-v1' && value.evidenceVersion === 'catalog-publication-v1' &&
    typeof value.evidenceHash === 'string' && /^[a-f0-9]{64}$/.test(value.evidenceHash);
}
