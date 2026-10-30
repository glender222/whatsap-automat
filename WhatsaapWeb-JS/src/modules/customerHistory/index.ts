export * from './domain/customerHistory.types';
export { CustomerHistoryService, CustomerHistoryNotFoundError } from './application/CustomerHistoryService';
export { CustomerHistoryRepositoryPg } from './infra/db/CustomerHistoryRepositoryPg';
