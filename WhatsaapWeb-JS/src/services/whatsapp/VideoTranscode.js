const { execFile } = require('node:child_process');
const { stat } = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const { removeTemporaryUpload } = require('../../shared/temporaryUpload');

// Allow uploaded video containers while excluding playlist demuxers and remote protocols.
const run = promisify(execFile);
const VIDEO_DEMUXERS = 'matroska,webm,mov,mp4,m4a,3gp,3g2,mj2,mpeg,mpegvideo,avi,asf,flv,mpegts';

async function withCompatibleVideo(file, send) {
  const parsedName = path.parse(file.originalname || 'video');
  if (file.mimetype === 'video/mp4' && parsedName.ext.toLowerCase() === '.mp4') {
    return send(file);
  }

  const outputPath = `${file.path}-converted.mp4`;
  try {
    try {
      await run(process.env.FFMPEG_PATH || 'ffmpeg', [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
        '-protocol_whitelist', 'file,pipe', '-format_whitelist', VIDEO_DEMUXERS, '-i', file.path,
        '-map', '0:v:0', '-map', '0:a:0?',
        '-c:v', 'libx264', '-preset', 'veryfast', '-movflags', '+faststart',
        '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-pix_fmt', 'yuv420p', '-profile:v', 'baseline', '-level', '3.0',
        '-c:a', 'aac', '-b:a', '128k', outputPath,
      ], { timeout: 60_000, killSignal: 'SIGKILL', maxBuffer: 256 * 1024 });
    } catch (error) {
      const unavailable = error.code === 'ENOENT';
      throw Object.assign(new Error(unavailable
        ? 'La conversión de video no está disponible.'
        : 'No se pudo convertir el video a MP4 compatible.'), {
        code: unavailable ? 'VIDEO_CONVERSION_UNAVAILABLE' : 'VIDEO_CONVERSION_FAILED',
        statusCode: unavailable ? 503 : 422,
      });
    }

    const { size } = await stat(outputPath);
    return await send({
      ...file, path: outputPath, originalname: `${parsedName.name}.mp4`, mimetype: 'video/mp4', size,
    });
  } finally {
    await removeTemporaryUpload(outputPath);
  }
}

module.exports = { withCompatibleVideo };
