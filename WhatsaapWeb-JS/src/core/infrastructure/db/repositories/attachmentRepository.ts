import { Queryable } from '../../../../shared/UnitOfWorkPort';
import { AttachmentRepositoryPort } from '../../../application/ports/attachmentRepository.port';
import { Attachment } from '../../../domain/attachment.entity';
import { AttachmentMapper } from '../mappers/attachment.mapper';

export class AttachmentRepository implements AttachmentRepositoryPort {
  constructor(private readonly pool: Queryable) {}

  /**
   * Inserta un adjunto de mensaje.
   * NOTA DE IDEMPOTENCIA: El schema actual no dispone de una clave única
   * externa (ej. media_external_id) ni de un constraint que impida duplicados
   * razonables. Por tanto, este método realiza un INSERT simple.
   * Si en el futuro el schema agrega un campo/constraint de unicidad,
   * debe reemplazarse por ON CONFLICT ... DO NOTHING / UPDATE.
   */
  async insert(attachment: Omit<Attachment, 'id' | 'createdAt'>): Promise<Attachment> {
    const result = await this.pool.query(
      `INSERT INTO message_attachments (message_id, filename, mime_type, size_bytes, external_url, internal_path, metadata_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        attachment.messageId,
        attachment.filename,
        attachment.mimeType,
        attachment.sizeBytes,
        attachment.externalUrl,
        attachment.internalPath,
        attachment.metadataJson ?? null,
      ]
    );
    return AttachmentMapper.toDomain(result.rows[0]);
  }

  async findByMessageId(messageId: number): Promise<Attachment[]> {
    const result = await this.pool.query(
      'SELECT * FROM message_attachments WHERE message_id = $1',
      [messageId]
    );
    return result.rows.map(AttachmentMapper.toDomain);
  }
}
