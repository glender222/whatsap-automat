/**
 * MediaHandler
 * Responsable del manejo de archivos multimedia
 */
const fs = require("fs");
const path = require("path");
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

class MediaHandler {
  constructor(whatsappClient) {
    this.whatsappClient = whatsappClient;
    this.config = require("../../config");
  }

  /**
   * Descarga el archivo multimedia de un mensaje
   * @param {string} messageId - ID del mensaje
   * @returns {Object} - Objeto Media con el contenido
   */
  async downloadMedia(messageId) {
    const uploadsDir = this.config.whatsapp.uploadDir;
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    // Buscar si ya existe el archivo guardado (por messageId o por nombre original)
    const possibleFiles = fs.readdirSync(uploadsDir).filter(f => f.startsWith(messageId + '.'));
    if (possibleFiles.length > 0) {
      // Ya existe, devolver info para servirlo
      const filePath = path.join(uploadsDir, possibleFiles[0]);
      const ext = path.extname(filePath).slice(1);
      const mimetype = this._getMimeTypeFromExt(ext); // Usar función corregida
      const filename = path.basename(filePath);
      const data = fs.readFileSync(filePath).toString('base64');
      return { data, mimetype, filename, localPath: filePath };
    }

    // Si no existe, descargar de WhatsApp
    const message = await this.whatsappClient.client.getMessageById(messageId);
    if (!message.hasMedia) {
      throw new Error("El mensaje no tiene archivo");
    }
    const media = await message.downloadMedia();
    if (!media) {
      throw new Error("No se pudo descargar el archivo");
    }

    // Intentar obtener el nombre original del archivo
    let originalFilename = undefined;
    if (message._data && message._data.filename) {
      originalFilename = message._data.filename;
    }

    // Guardar archivo en uploads/ para futuras descargas
    let ext = 'bin';
    if (media.mimetype) {
      ext = this._getExtFromMimeType(media.mimetype); // Usar función corregida
    }
    
    let filename;
    if (originalFilename) {
      filename = originalFilename;
    } else {
      // Si no hay nombre original, construimos uno con la extensión correcta
      filename = `${messageId}.${ext}`;
    }
    
    const filePath = path.join(uploadsDir, filename);
    fs.writeFileSync(filePath, Buffer.from(media.data, 'base64'));

    // Devolver la info, asegurándonos que el filename sea el correcto
    return { ...media, filename, localPath: filePath };
  }

  // Utilidad: obtener extensión desde mimetype (VERSIÓN CORREGIDA)
  _getExtFromMimeType(mimetype) {
    if (!mimetype) return 'bin';

    // Mapeo común
    const mimeMap = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'video/mp4': 'mp4',
      'video/ogg': 'ogg',
      'video/webm': 'webm',
      'audio/mpeg': 'mp3',
      'audio/ogg': 'ogg',
      'audio/wav': 'wav',
      'application/pdf': 'pdf',
      'application/zip': 'zip',
      // --- AÑADIDOS ---
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
      'application/msword': 'doc',
      'application/vnd.ms-excel': 'xls',
      'application/vnd.ms-powerpoint': 'ppt',
    };

    if (mimeMap[mimetype]) {
      return mimeMap[mimetype];
    }
    
    // Fallback para otros tipos de imagen/video/audio
    if (mimetype.startsWith('image/')) return mimetype.split('/')[1];
    if (mimetype.startsWith('video/')) return mimetype.split('/')[1];
    if (mimetype.startsWith('audio/')) return mimetype.split('/')[1];

    return 'bin';
  }

  // Utilidad: obtener mimetype desde extensión (VERSIÓN CORREGIDA)
  _getMimeTypeFromExt(ext) {
    if (!ext) return 'application/octet-stream';

    const extMap = {
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'png': 'image/png',
      'gif': 'image/gif',
      'webp': 'image/webp',
      'mp4': 'video/mp4',
      'ogg': 'video/ogg', // Nota: puede ser audio o video
      'webm': 'video/webm',
      'mp3': 'audio/mpeg',
      'wav': 'audio/wav',
      'pdf': 'application/pdf',
      'zip': 'application/zip',
      // --- AÑADIDOS ---
      'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'doc': 'application/msword',
      'xls': 'application/vnd.ms-excel',
      'ppt': 'application/vnd.ms-powerpoint',
    };

    return extMap[ext] || 'application/octet-stream';
  }

  /**
   * Obtiene la foto de perfil de un contacto o grupo
   * @param {string} chatId - ID del chat
   * @returns {string} - Ruta al archivo de la foto
   */
  async getProfilePhoto(chatId) {
    const photoPath = path.join(this.config.whatsapp.profileDir, `${chatId}-photo.jpg`);
    
    if (fs.existsSync(photoPath)) {
      return photoPath;
    }
    
    const url = await this.whatsappClient.client.getProfilePicUrl(chatId);
    if (!url) {
      throw new Error("No hay foto de perfil");
    }
    
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error("Error descargando foto");
    }
    
    const buffer = await response.arrayBuffer();
    fs.writeFileSync(photoPath, Buffer.from(buffer));
    
    return photoPath;
  }
}

module.exports = MediaHandler;