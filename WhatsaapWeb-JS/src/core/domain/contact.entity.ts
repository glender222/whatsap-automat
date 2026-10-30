export interface Contact {
  id: number;
  companyId: number;
  channel: string;
  externalContactId: string;
  name: string | null;
  phone: string | null;
  rawProfileJson: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}
