const express = require('express');
const multer = require('multer');
const ChatController = require('../controllers/chatController');
const config = require('../config');

function createChatRoutes(whatsappService, conversationCore = null) {
  const router = express.Router();
  const chatController = new ChatController(whatsappService, conversationCore);
  
  // Configurar multer para uploads
  const upload = multer({ 
    dest: config.multer.dest,
    limits: {
      fileSize: config.multer.maxFileSize
    },
    fileFilter: (req, file, cb) => {
      // Aceptar solo videos (puedes ampliar a image/audio si quieres)
      if (file.mimetype && file.mimetype.startsWith('video/')) {
        cb(null, true);
      } else {
        cb(new Error('Solo se permiten archivos de video'), false);
      }
    }
  });

  router.get('/', chatController.getChats);
  router.get('/:chatId/messages', chatController.getMessages);
  router.post('/:chatId/messages', upload.single("file"), chatController.sendMessage);
  router.put('/:chatId/read', chatController.markAsRead);

  return router;
}

module.exports = createChatRoutes;