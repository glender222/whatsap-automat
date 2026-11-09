const { unlink } = require('node:fs/promises');

const TEXT_SEND_ENDPOINT = '/api/v1/conversations/{id}/messages';

function explicitTemplateName(body) {
  const name = body?.templateName || body?.template;
  return typeof name === 'string' ? name.trim() || undefined : undefined;
}

async function removeTemporaryUpload(filePath) {
  if (!filePath) return;
  try {
    await unlink(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('No se pudo eliminar un archivo temporal de envío.', { code: error.code });
    }
  }
}

// These endpoints need multipart parsing before authorization to obtain the chat ID.
// After authorization succeeds, the send handler takes ownership of the upload.
function cleanRejectedUpload(authorize) {
  return async (req, res, next) => {
    let forwarded = false;
    try {
      await authorize(req, res, (error) => {
        forwarded = !error;
        next(error);
      });
    } finally {
      if (!forwarded) await removeTemporaryUpload(req.file?.path);
    }
  };
}

function withTemporaryUpload(send) {
  return async (req, res, next) => {
    try {
      return await send(req, res, next);
    } finally {
      await removeTemporaryUpload(req.file?.path);
    }
  };
}

function legacyHumanSend(whatsappService, send, { allowTemplates = false } = {}) {
  return withTemporaryUpload(async (req, res, next) => {
    if (whatsappService.provider === 'meta-cloud' && !req.file) {
      const message = req.body?.message;
      if (typeof message === 'string' && message.trim()) {
        return res.status(409).json({
          success: false,
          error: 'CANONICAL_TEXT_SEND_REQUIRED',
          message: 'El texto libre de WhatsApp Cloud se envía por la ruta canónica.',
          endpoint: TEXT_SEND_ENDPOINT,
        });
      }
      if ((message != null && message !== '') || !(allowTemplates && explicitTemplateName(req.body))) {
        return res.status(400).json({ success: false, error: 'MESSAGE_REQUIRED' });
      }
    }
    return send(req, res, next);
  });
}

module.exports = { cleanRejectedUpload, explicitTemplateName, legacyHumanSend, removeTemporaryUpload, withTemporaryUpload };
