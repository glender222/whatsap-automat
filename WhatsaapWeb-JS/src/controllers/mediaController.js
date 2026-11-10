const { asyncHandler } = require('../middleware/errorHandler');
const fs = require('fs');
const path = require('path');
const { legacyHumanSend, withTemporaryUpload } = require('../middleware/legacyHumanSend');
const { withCompatibleVideo } = require('../services/whatsapp/VideoTranscode');

function getWhatsappCompanyId(req) {
  const user = req?.user || {};
  const companyId = Number(
    req?.whatsappCompanyId ||
    user.companyId ||
    user.company_id ||
    user.tenantId
  );
  if (Number.isInteger(companyId) && companyId > 0) {
    return companyId;
  }
  throw new Error('TENANT_CLAIM_REQUIRED: Se requiere un token con claim de empresa valido');
}

function sendMediaError(res, err) {
  const statusCode = err.statusCode || err.status || 404;
  return res.status(statusCode).json({
    success: false,
    error: err.code || 'MEDIA_DOWNLOAD_FAILED',
    message: err.message || 'No se pudo descargar el archivo',
    userMessage: err.userMessage || 'No se pudo descargar el archivo',
    action: err.action,
    providerStatusCode: err.providerStatusCode,
    details: process.env.NODE_ENV === 'development' ? err.meta || err.stack : undefined,
  });
}

class MediaController {
  constructor(whatsappService) {
    this.whatsappService = whatsappService;
    this.sendMessage = legacyHumanSend(whatsappService, this.sendMessage);
    this.sendMedia = withTemporaryUpload(this.sendMedia);
    this.sendDocument = withTemporaryUpload(this.sendDocument);
  }

  /**
   * POST /api/media/send-media
   * Solo para imágenes y videos (envía como media, nunca como documento)
   */
  sendMedia = async (req, res) => {
    const { chatId, message } = req.body;
    const file = req.file || null;

    if (!chatId) {
      return res.status(400).json({ success: false, error: 'chatId requerido' });
    }
    if (!file) {
      return res.status(400).json({ success: false, error: 'Archivo requerido' });
    }
    // Solo aceptar imagen o video
    const mimetype = file.mimetype || '';
    if (!mimetype.startsWith('image/') && !mimetype.startsWith('video/')) {
      return res.status(400).json({ success: false, error: 'Solo se permiten imágenes o videos en este endpoint' });
    }

    const options = { forceDocument: false, companyId: getWhatsappCompanyId(req) };
    const send = (attachment) => this.whatsappService.sendMessage(chatId, message, attachment, options);
    // Meta Cloud normalizes video in the shared provider path used by every upload route.
    const sent = mimetype.startsWith('video/') && this.whatsappService.provider !== 'meta-cloud'
      ? await withCompatibleVideo(file, send)
      : await send(file);
    return res.json({
      success: true,
      data: {
        id: sent.id?._serialized || sent.id || null,
        timestamp: sent.timestamp || Math.floor(Date.now()/1000),
      }
    });
  };

  /**
   * POST /api/media/send-document
   * Solo para documentos (no imagen/video/audio)
   */
  sendDocument = async (req, res) => {
    const { chatId, message } = req.body;
    const file = req.file || null;

    if (!chatId) {
      return res.status(400).json({ success: false, error: 'chatId requerido' });
    }
    if (!file) {
      return res.status(400).json({ success: false, error: 'Archivo requerido' });
    }
    // Solo aceptar documentos (no imagen/video/audio)
    const mimetype = file.mimetype || '';
    if (mimetype.startsWith('image/') || mimetype.startsWith('video/') || mimetype.startsWith('audio/')) {
      return res.status(400).json({ success: false, error: 'No se permiten imágenes, videos ni audios en este endpoint' });
    }
    // Forzar como documento
    const options = { forceDocument: true, companyId: getWhatsappCompanyId(req) };
    const sent = await this.whatsappService.sendMessage(chatId, message, file, options);
    return res.json({
      success: true,
      data: {
        id: sent.id?._serialized || sent.id || null,
        timestamp: sent.timestamp || Math.floor(Date.now()/1000),
      }
    });
  };


// controllers/MediaController.js
// Controlador robusto de media para WhatsApp Web JS

  /**
   * ============================================================
   * GET /api/messages/:chatId
   * Lista mensajes (texto + media metadata) de un chat
   * soporta paginado con ?limit=50&before=timestamp
   * ============================================================
   */
  getChatMessages = asyncHandler(async (req, res) => {
    const { chatId } = req.params;
    const { limit, before } = req.query;

    if (!chatId) {
      return res.status(400).json({ success: false, error: 'chatId requerido' });
    }

    const msgs = await this.whatsappService.getChatMessages(
      chatId,
      limit ? parseInt(limit, 10) : 50,
      before ? parseInt(before, 10) : 0,
      getWhatsappCompanyId(req)
    );

    return res.json({
      success: true,
      data: msgs,
    });
  });

  /**
   * ============================================================
   * POST /api/send
   * Envía mensaje con o sin media
   * Campos esperados (multipart/form-data):
   *  - chatId (string, obligatorio)
   *  - message (string opcional -> caption/texto)
   *  - file (archivo opcional)
   *  - forceDocument=true|false (opcional) -> forzar enviar como documento
   *  - ptt=true -> enviar audio como nota de voz (push-to-talk)
   *  - asSticker=true -> enviar imagen/GIF como sticker
   * ============================================================
   */
  sendMessage = async (req, res) => {
    const { chatId, message, forceDocument, ptt, asSticker } = req.body || {};
    const file = req.file || null; // multer debe haberse aplicado en la ruta

    if (!chatId) {
      return res.status(400).json({ success: false, error: 'chatId requerido' });
    }

    const options = {
      forceDocument: forceDocument === 'true',
      ptt: ptt === 'true',
      asSticker: asSticker === 'true',
      companyId: getWhatsappCompanyId(req),
    };

    // whatsappService debe implementar esta lógica fina:
    // - detectar mimetype
    // - si asSticker => client.sendMessage(chatId, media, { sendMediaAsSticker:true })
    // - si ptt && audio => client.sendMessage(chatId, media, { sendAudioAsVoice:true })
    // - si video => NO mandarlo como documento salvo que forceDocument=true
    // - fallback automático a documento si WhatsApp rechaza inline video
    const sent = await this.whatsappService.sendMessage(chatId, message, file, options);

    return res.json({
      success: true,
      data: {
        id: sent.id?._serialized || sent.id || null,
        timestamp: sent.timestamp || Math.floor(Date.now()/1000),
      }
    });
  };

  /**
   * ============================================================
   * GET /api/media/:messageId
   * Descarga/stream del media asociado a un mensaje
   * - Soporta Range para video/audio
   * - Sirve inline para image/video/audio
   * - Sirve attachment para documentos
   * ============================================================
   */
  downloadMedia = asyncHandler(async (req, res) => {
    const { messageId } = req.params;

    if (!messageId) {
      return res.status(400).json({
        success: false,
        error: "messageId es requerido"
      });
    }

    // whatsappService.downloadMedia debe:
    // 1. Buscar en cache local (uploads/<messageId>.*)
    // 2. Si no existe, llamar message.downloadMedia() de whatsapp-web.js
    // 3. Guardar en disco
    // 4. Devolver { localPath, mimetype, filename, data? }
    let media;
    try {
      media = await this.whatsappService.downloadMedia(messageId, getWhatsappCompanyId(req));
    } catch (err) {
      return sendMediaError(res, err);
    }

    // CORS básico para que tu front pueda hacer fetch(blob)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Accept-Ranges', 'bytes');

    // Si tenemos archivo local físico
    if (media.localPath && fs.existsSync(media.localPath)) {
      const stat = fs.statSync(media.localPath);
      const total = stat.size;
      const range = req.headers.range;
      const mimetype = media.mimetype || 'application/octet-stream';
      const filename = media.filename || path.basename(media.localPath);

      // ¿Lo servimos inline o attachment?
      const isDocument = !(mimetype.startsWith('image/') || mimetype.startsWith('video/') || mimetype.startsWith('audio/'));

      res.setHeader('Content-Type', mimetype);
      res.setHeader(
        'Content-Disposition',
        isDocument
          ? `attachment; filename="${filename}"`
          : `inline; filename="${filename}"`
      );

      if (range) {
        // streaming parcial (video/audio largo en <video> HTML)
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : total - 1;

        if (isNaN(start) || isNaN(end) || start > end || start < 0 || end > total - 1) {
          res.status(416).setHeader('Content-Range', `bytes */${total}`);
          return res.end();
        }

        const chunkSize = end - start + 1;
        const stream = fs.createReadStream(media.localPath, { start, end });

        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
        res.setHeader('Content-Length', chunkSize);

        return stream.pipe(res);
      }

      // descarga completa
      res.setHeader('Content-Length', total);
      const streamFull = fs.createReadStream(media.localPath);
      return streamFull.pipe(res);
    }

    // fallback: buffer en base64 (raro pero posible si aún no guardaste en disco)
    if (media.data) {
      const buffer = Buffer.from(media.data, 'base64');
      const total = buffer.length;
      const range = req.headers.range;
      const mimetype = media.mimetype || 'application/octet-stream';

      const isInline =
        mimetype.startsWith('image/') ||
        mimetype.startsWith('video/') ||
        mimetype.startsWith('audio/');

      res.setHeader('Content-Type', mimetype);
      res.setHeader(
        'Content-Disposition',
        isInline
          ? `inline; filename="${media.filename || 'file'}"`
          : `attachment; filename="${media.filename || 'file'}"`
      );

      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : total - 1;

        if (isNaN(start) || isNaN(end) || start > end || start < 0 || end > total - 1) {
          res.status(416).setHeader('Content-Range', `bytes */${total}`);
          return res.end();
        }

        const chunk = buffer.slice(start, end + 1);
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
        res.setHeader('Content-Length', chunk.length);
        return res.send(chunk);
      }

      res.setHeader('Content-Length', total);
      return res.send(buffer);
    }

    return res.status(404).json({
      success: false,
      error: "No se pudo servir el archivo (ni local ni buffer)"
    });
  });

  /**
   * ============================================================
   * GET /api/media/:messageId/info
   * Devuelve solo metadata del media SIN descargar el binario
   * (para que tu front sepa si es video, size, filename...)
   * ============================================================
   */
  getMediaInfo = asyncHandler(async (req, res) => {
    const { messageId } = req.params;

    if (!messageId) {
      return res.status(400).json({
        success: false,
        error: "messageId es requerido"
      });
    }

    const info = await this.whatsappService.getMediaInfo(messageId, getWhatsappCompanyId(req));
    // Implementar en whatsappService:
    // - Buscar mensaje por ID
    // - Devolver { hasMedia, mimetype, filename, fileSize, duration?, isGif?, width?, height? }
    //   usando msg._data u otros campos de whatsapp-web.js
    if (!info) {
      return res.status(404).json({ success: false, error: 'No encontrado' });
    }

    return res.json({
      success: true,
      data: info
    });
  });

  /**
   * ============================================================
   * GET /api/media/:messageId/thumbnail
   * Devuelve miniatura/preview en base64 (ej. para videos pesados)
   * ============================================================
   */
  getMediaThumbnail = asyncHandler(async (req, res) => {
    const { messageId } = req.params;

    const thumb = await this.whatsappService.getMediaThumbnail(messageId, getWhatsappCompanyId(req));
    // Implementar:
    // - msg.body para stickers?
    // - msg._data.previewE2E / msg._data.thumbnail if available
    //   O generar preview y cachearla como .jpg pequeña

    if (!thumb) {
      return res.status(404).json({ success: false, error: 'Sin thumbnail' });
    }

    // thumb = { mimetype: 'image/jpeg', base64: '....' }
    const buffer = Buffer.from(thumb.base64, 'base64');
    res.setHeader('Content-Type', thumb.mimetype || 'image/jpeg');
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.send(buffer);
  });

  /**
   * ============================================================
   * GET /api/profile-photo/:chatId
   * Obtiene/descarga y sirve la foto de perfil (contacto o grupo)
   * Cachea en disco.
   * ============================================================
   */
  getProfilePhoto = asyncHandler(async (req, res) => {
    const { chatId } = req.params;
    if (!chatId) {
      return res.status(400).json({ success: false, error: 'chatId requerido' });
    }

    try {
      const photoPath = await this.whatsappService.getProfilePhoto(chatId, getWhatsappCompanyId(req));
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'image/jpeg');
      return res.sendFile(photoPath, (err) => {
        if (err && !res.headersSent) {
          res.status(404).json({
            success: false,
            error: 'No hay foto de perfil disponible'
          });
        }
      });
    } catch (e) {
      return res.status(404).json({
        success: false,
        error: 'No hay foto de perfil disponible'
      });
    }
  });

  /**
   * ============================================================
   * POST /api/mark-read/:chatId
   * Marca el chat como leído (quita unreadCount en tu lista local)
   * Útil cuando el front abre el chat o descarga media
   * ============================================================
   */
  markChatAsRead = asyncHandler(async (req, res) => {
    const { chatId } = req.params;

    if (!chatId) {
      return res.status(400).json({ success: false, error: 'chatId requerido' });
    }

    const companyId = getWhatsappCompanyId(req);
    await this.whatsappService.markAsRead(chatId, companyId);

    return res.json({
      success: true,
      data: { chatId }
    });
  });

  /**
   * ============================================================
   * GET /api/chats
   * Devuelve la lista de chats ordenados por actividad
   * con preview, unreadCount, lastMessageTimestamp, etc.
   * Esto te sirve para la vista "sidebar de conversaciones".
   * ============================================================
   */
  getChatsList = asyncHandler(async (req, res) => {
    const companyId = getWhatsappCompanyId(req);
    const chats = await this.whatsappService.getChatsList(companyId);
    // Debe venir ya curado: id, name, unreadCount, lastMessageTimestamp,
    // lastMessagePreview, isGroup, etc.
    return res.json({
      success: true,
      data: chats
    });
  });
}

module.exports = MediaController;
