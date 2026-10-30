/**
 * Entidad raíz de compañía (tenant) para el Core operativo modular.
 * Mapea a la tabla existente `companies` gestionada por coreModel.ts.
 */
export interface Company {
  readonly id: number;
  readonly name: string;
  readonly createdAt: Date;
}
