// Alias de compatibilidad temporal para migración gradual.
// TODO: eliminar este archivo una vez que todos los consumadores usen MessageChannelPort.
export {
  MessageChannelPort,
  SendResult,
  MediaRef,
  MediaResult,
  StatusResult,
} from './messageChannel.port';

import { MessageChannelPort } from './messageChannel.port';

/**
 * @deprecated Usar MessageChannelPort. Este alias se mantendrá temporalmente
 * para no romper imports legacy.
 */
export type WhatsAppChannelPort = MessageChannelPort;
