export function resolveCompanyId(explicitCompanyId?: number): number {
  return explicitCompanyId ?? (parseInt(process.env.DEFAULT_COMPANY_ID || '1', 10) || 1);
}

export function requireCompanyId(explicitCompanyId?: number): number {
  const id = resolveCompanyId(explicitCompanyId);
  if (!id || Number.isNaN(id)) {
    throw new Error('company_id is required and must be a valid number');
  }
  return id;
}
