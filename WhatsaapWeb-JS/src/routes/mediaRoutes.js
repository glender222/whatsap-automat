// routes/mediaRoutes.js
const express = require('express');
const multer = require('multer');
const upload = multer({ dest: 'tmp_uploads/' }); // carpeta temporal
const MediaController = require('../controllers/mediaController');

module.exports = (whatsappService) => {
  const router = express.Router();
  const controller = new MediaController(whatsappService);

  // mensajes y chats
  router.get('/chats', controller.getChatsList);
  router.get('/messages/:chatId', controller.getChatMessages);
  router.post('/mark-read/:chatId', controller.markChatAsRead);

  // envío (texto / media / sticker / nota de voz / doc)
  router.post('/send', upload.single('file'), controller.sendMessage);

  // NUEVAS rutas separadas para media y documentos
  router.post('/send-media', upload.single('file'), controller.sendMedia);
  router.post('/send-document', upload.single('file'), controller.sendDocument);

  // media download / info / thumbnail
  router.get('/media/:messageId', controller.downloadMedia);
  router.get('/media/:messageId/info', controller.getMediaInfo);
  router.get('/media/:messageId/thumbnail', controller.getMediaThumbnail);

  // foto de perfil
  router.get('/profile-photo/:chatId', controller.getProfilePhoto);

  return router;
};
