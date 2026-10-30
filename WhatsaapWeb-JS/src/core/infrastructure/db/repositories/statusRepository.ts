import { Queryable } from '../../../../shared/UnitOfWorkPort';
import { StatusRepositoryPort } from '../../../application/ports/statusRepository.port';
import { MessageStatus } from '../../../domain/messageStatus.entity';
import { StatusMapper } from '../mappers/status.mapper';

export class StatusRepository implements StatusRepositoryPort {
  constructor(private readonly pool: Queryable) {}

  /**
   * Inserta un estado de mensaje.
   * NOTA DE IDEMPOTENCIA: El schema actual no dispone de una clave única
   * compuesta (ej. message_id + status + provider_status_id) ni de un
   * constraint que impida duplicados exactos. Por tanto, este método
   * realiza un INSERT simple. Si en el futuro el schema agrega un campo
   * o constraint de unicidad, debe reemplazarse por ON CONFLICT ... DO NOTHING / UPDATE.
   */
  async insert(status: Omit<MessageStatus, 'id' | 'createdAt'>): Promise<MessageStatus> {
    const result = await this.pool.query(
      `INSERT INTO message_statuses (message_id, status, source, occurred_at, metadata_json)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        status.messageId,
        status.status,
        status.source,
        status.occurredAt,
        status.metadataJson ?? null,
      ]
    );
    return StatusMapper.toDomain(result.rows[0]);
  }

  async findByMessageId(messageId: number): Promise<MessageStatus[]> {
    const result = await this.pool.query(
      'SELECT * FROM message_statuses WHERE message_id = $1 ORDER BY occurred_at DESC',
      [messageId]
    );
    return result.rows.map(StatusMapper.toDomain);
  }
}
