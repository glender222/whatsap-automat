// routes/mediaRoutes.js
const express = require('express');
const multer = require('multer');
const config = require('../config');
const MediaController = require('../controllers/mediaController');
const { requireChatTenantAccess, requireMediaTenantAccess } = require('../middleware/resourceAuth');
const { cleanRejectedUpload } = require('../middleware/legacyHumanSend');

module.exports = (whatsappService) => {
  const router = express.Router();
  const controller = new MediaController(whatsappService);
  const upload = multer({ dest: config.multer.dest, limits: { fileSize: config.multer.maxFileSize } });
  const authorizeUpload = cleanRejectedUpload(requireChatTenantAccess);

  // mensajes y chats
  router.get('/chats', controller.getChatsList);
  router.get('/messages/:chatId', requireChatTenantAccess, controller.getChatMessages);
  router.post('/mark-read/:chatId', requireChatTenantAccess, controller.markChatAsRead);

  // envío (texto / media / sticker / nota de voz / doc)
  router.post('/send', upload.single('file'), authorizeUpload, controller.sendMessage);

  // NUEVAS rutas separadas para media y documentos
  router.post('/send-media', upload.single('file'), authorizeUpload, controller.sendMedia);
  router.post('/send-document', upload.single('file'), authorizeUpload, controller.sendDocument);

  // media download / info / thumbnail
  router.get('/media/:messageId', requireMediaTenantAccess, controller.downloadMedia);
  router.get('/media/:messageId/info', requireMediaTenantAccess, controller.getMediaInfo);
  router.get('/media/:messageId/thumbnail', requireMediaTenantAccess, controller.getMediaThumbnail);

  // foto de perfil
  router.get('/profile-photo/:chatId', requireChatTenantAccess, controller.getProfilePhoto);

  return router;
};
