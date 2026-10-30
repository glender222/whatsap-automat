import { Queryable } from '../../../../shared/UnitOfWorkPort';
import { ProductRepositoryPg } from '../../../inventory';
import type { AgentToolContext, ToolExecutorOutcome } from '../../domain/tool.types';

type CheckInput = {
  commercialItemId: number;
  quantity?: number;
};

export class AvailabilityToolService {
  constructor(private readonly productRepo: ProductRepositoryPg) {}

  async check(ctx: AgentToolContext, raw: CheckInput): Promise<ToolExecutorOutcome> {
    const id = Number(raw.commercialItemId);
    if (!Number.isInteger(id) || id <= 0) return { status: 'invalid_input', output: { available: false } };
    const quantity = Math.max(1, Math.trunc(Number(raw.quantity || 1)));

    const product = await this.productRepo.get(ctx.companyId, id);
    if (!product || product.status !== 'active') {
      return {
        status: 'ok',
        output: {
          commercialItemId: id,
          available: false,
          status: 'out_of_stock',
          quantityRequested: quantity,
          availableQuantity: 0,
          message: 'Producto no encontrado o inactivo.',
        },
      };
    }

    if (product.availabilityType === 'manual') {
      return {
        status: 'ok',
        output: {
          commercialItemId: id,
          available: false,
          status: 'manual_required',
          quantityRequested: quantity,
          availableQuantity: product.stockAvailable,
          message: 'Disponibilidad requiere validacion manual.',
        },
      };
    }

    if (product.requiresHumanApproval) {
      return {
        status: 'ok',
        output: {
          commercialItemId: id,
          available: false,
          status: 'approval_required',
          quantityRequested: quantity,
          availableQuantity: product.stockAvailable,
          message: 'Requiere aprobacion humana.',
        },
      };
    }

    if (product.availabilityType === 'unlimited') {
      return {
        status: 'ok',
        output: {
          commercialItemId: id,
          available: true,
          status: 'unlimited',
          quantityRequested: quantity,
          availableQuantity: null,
          message: 'Disponible sin limite.',
        },
      };
    }

    if (product.availabilityType === 'schedule') {
      return {
        status: 'ok',
        output: {
          commercialItemId: id,
          available: false,
          status: 'schedule_required',
          quantityRequested: quantity,
          availableQuantity: product.stockAvailable,
          message: 'Requiere coordinar agenda.',
        },
      };
    }

    const availableQuantity = Number(product.stockAvailable || 0);
    const available = availableQuantity >= quantity;
    return {
      status: 'ok',
      output: {
        commercialItemId: id,
        available,
        status: available ? 'available' : 'out_of_stock',
        quantityRequested: quantity,
        availableQuantity,
        message: available ? 'Disponible' : 'Sin stock suficiente.',
      },
    };
  }
}

let instance: AvailabilityToolService | null = null;

export function getAvailabilityToolService(pool: Queryable): AvailabilityToolService {
  if (!instance) instance = new AvailabilityToolService(new ProductRepositoryPg(pool));
  return instance;
}
