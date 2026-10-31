// routes/mediaRoutes.js
const express = require('express');
const multer = require('multer');
const upload = multer({ dest: 'tmp_uploads/' }); // carpeta temporal
const MediaController = require('../controllers/mediaController');
const { requireChatTenantAccess, requireMediaTenantAccess } = require('../middleware/resourceAuth');

module.exports = (whatsappService) => {
  const router = express.Router();
  const controller = new MediaController(whatsappService);

  // mensajes y chats
  router.get('/chats', controller.getChatsList);
  router.get('/messages/:chatId', requireChatTenantAccess, controller.getChatMessages);
  router.post('/mark-read/:chatId', requireChatTenantAccess, controller.markChatAsRead);

  // envío (texto / media / sticker / nota de voz / doc)
  router.post('/send', requireChatTenantAccess, upload.single('file'), controller.sendMessage);

  // NUEVAS rutas separadas para media y documentos
  router.post('/send-media', requireChatTenantAccess, upload.single('file'), controller.sendMedia);
  router.post('/send-document', requireChatTenantAccess, upload.single('file'), controller.sendDocument);

  // media download / info / thumbnail
  router.get('/media/:messageId', requireMediaTenantAccess, controller.downloadMedia);
  router.get('/media/:messageId/info', requireMediaTenantAccess, controller.getMediaInfo);
  router.get('/media/:messageId/thumbnail', requireMediaTenantAccess, controller.getMediaThumbnail);

  // foto de perfil
  router.get('/profile-photo/:chatId', requireChatTenantAccess, controller.getProfilePhoto);

  return router;
};
