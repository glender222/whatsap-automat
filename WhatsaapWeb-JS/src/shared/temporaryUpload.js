const { unlink } = require('node:fs/promises');

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

module.exports = { removeTemporaryUpload };
