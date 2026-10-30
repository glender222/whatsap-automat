/**
 * Verificación estática/smoke para el módulo companies-core (PR2).
 * No requiere conexión a base de datos.
 */

import type { Pool } from 'pg';
import {
  Company,
  Plan,
  CompanySettings,
  CompanyLimits,
  CompanyRepositoryPort,
  GetCompanySettings,
  GetCompanyLimits,
  CompanyRepositoryPg,
} from '../src/modules/companies';

// Validación de tipos de entidad
const _companyType: Company = { id: 1, name: 'Acme', createdAt: new Date() };
const _planType: Plan = {
  id: 1,
  code: 'starter',
  name: 'Starter',
  description: null,
  maxUsers: 5,
  maxConversations: 100,
  maxMessagesPerMonth: 1000,
  createdAt: new Date(),
  updatedAt: new Date(),
};
const _settingsType: CompanySettings = {
  companyId: 1,
  planId: 1,
  timezone: 'America/Lima',
  locale: 'es-PE',
  features: {},
  createdAt: new Date(),
  updatedAt: new Date(),
};
const _limitsType: CompanyLimits = {
  companyId: 1,
  maxUsers: 5,
  maxConversations: 100,
  maxMessagesPerMonth: 1000,
};

// Validación de puerto
const mockPort: CompanyRepositoryPort = {
  findById: async () => null,
  findPlanById: async () => null,
  findSettingsByCompanyId: async () => null,
  findLimitsByCompanyId: async () => null,
};

// Validación de use cases constructibles
const _getSettings = new GetCompanySettings(mockPort);
const _getLimits = new GetCompanyLimits(mockPort);

// Validación de repo PostgreSQL constructible con mock mínimo
const mockPool = {
  query: async () => ({ rows: [] }),
} as unknown as Pool;

const _repo = new CompanyRepositoryPg(mockPool);

// Satisfacer referencias para evitar warnings de unused
void _companyType;
void _planType;
void _settingsType;
void _limitsType;
void _getSettings;
void _getLimits;
void _repo;

console.log('✅ Verificación estática de companies-core completada (sin DB)');
