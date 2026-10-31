import { createProblemDetails, ProblemDetailsV1 } from '../errors/problemDetails';
import { StandardErrorCode } from '../errors/codes';

const mockCorrelationId = 'corr_test_error_fixture_001';
const mockInstance = '/api/v1/conversations/conv_001/takeover';

export const problemDetailsFixtures: Record<StandardErrorCode, ProblemDetailsV1> = {
  [StandardErrorCode.UNAUTHORIZED]: createProblemDetails({
    code: StandardErrorCode.UNAUTHORIZED,
    detail: 'Token JWT expirado o claims de tenant ausentes.',
    instance: mockInstance,
    correlationId: mockCorrelationId,
  }),
  [StandardErrorCode.POLICY_DENIED]: createProblemDetails({
    code: StandardErrorCode.POLICY_DENIED,
    detail: 'El usuario no posee permisos para ejecutar handoff humano en este tenant.',
    instance: mockInstance,
    correlationId: mockCorrelationId,
  }),
  [StandardErrorCode.APPROVAL_REQUIRED]: createProblemDetails({
    code: StandardErrorCode.APPROVAL_REQUIRED,
    detail: 'La acción solicitada requiere aprobación previa de un supervisor.',
    instance: mockInstance,
    correlationId: mockCorrelationId,
    metadata: { approvalId: 'appr_req_discount_001', risk: 'medium' },
  }),
  [StandardErrorCode.NOT_FOUND]: createProblemDetails({
    code: StandardErrorCode.NOT_FOUND,
    detail: 'Conversación conv_001 no encontrada en este tenant.',
    instance: mockInstance,
    correlationId: mockCorrelationId,
  }),
  [StandardErrorCode.CONFLICT]: createProblemDetails({
    code: StandardErrorCode.CONFLICT,
    detail: 'Versión de estado obsoleta: esperado 3, actual 4. Recargue el recurso antes de reintentar.',
    instance: mockInstance,
    correlationId: mockCorrelationId,
  }),
  [StandardErrorCode.VALIDATION_ERROR]: createProblemDetails({
    code: StandardErrorCode.VALIDATION_ERROR,
    detail: 'Cuerpo de la petición contiene campos inválidos.',
    instance: mockInstance,
    correlationId: mockCorrelationId,
    invalidParams: [
      { name: 'expectedVersion', reason: 'expectedVersion must be a non-negative integer' },
      { name: 'userId', reason: 'userId is required' },
    ],
  }),
  [StandardErrorCode.RATE_LIMITED]: createProblemDetails({
    code: StandardErrorCode.RATE_LIMITED,
    detail: 'Límite de envíos por segundo excedido para este canal. Reintente en 5 segundos.',
    instance: mockInstance,
    correlationId: mockCorrelationId,
    metadata: { retryAfterSeconds: 5 },
  }),
  [StandardErrorCode.UNKNOWN_DELIVERY]: createProblemDetails({
    code: StandardErrorCode.UNKNOWN_DELIVERY,
    detail: 'El proveedor externo no confirmó ni rechazó el mensaje en la ventana esperada.',
    instance: mockInstance,
    correlationId: mockCorrelationId,
  }),
  [StandardErrorCode.RETRYABLE]: createProblemDetails({
    code: StandardErrorCode.RETRYABLE,
    detail: 'Fallo transitorio de conexión con la base de datos o worker. Seguro para reintentar.',
    instance: mockInstance,
    correlationId: mockCorrelationId,
  }),
  [StandardErrorCode.INTERNAL_ERROR]: createProblemDetails({
    code: StandardErrorCode.INTERNAL_ERROR,
    detail: 'Error interno no controlado. El incidente ha sido registrado con correlationId.',
    instance: mockInstance,
    correlationId: mockCorrelationId,
  }),
};
