const { execFile } = require('node:child_process');
const { stat } = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const { removeTemporaryUpload } = require('../../shared/temporaryUpload');

const run = promisify(execFile);
// Allow uploaded video containers while excluding playlist demuxers and remote protocols.
const VIDEO_INPUT = [
  '-protocol_whitelist', 'file,pipe',
  '-format_whitelist', 'matroska,webm,mov,mp4,m4a,3gp,3g2,mj2,mpeg,mpegvideo,avi,asf,flv,mpegts',
];
const PROCESS_LIMITS = { killSignal: 'SIGKILL', maxBuffer: 256 * 1024 };
const MP4_BRAND = /^(?:iso[m2-9]|mp4[12]|avc1|dash|M4V )$/;

function videoError(code, statusCode, message) {
  return Object.assign(new Error(message), { code, statusCode });
}

async function isReusableMp4(filePath) {
  let probe;
  try {
    const { stdout, stderr } = await run(process.env.FFPROBE_PATH || 'ffprobe', [
      '-v', 'error', '-threads', '1', ...VIDEO_INPUT, '-count_frames',
      '-show_entries',
      'format=format_name:format_tags=major_brand:stream=codec_name,codec_type,pix_fmt,nb_frames,nb_read_frames:stream_disposition=attached_pic',
      '-of', 'json', filePath,
    ], { ...PROCESS_LIMITS, timeout: 15_000 });
    if (!stderr.trim()) probe = JSON.parse(stdout);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw videoError('VIDEO_INSPECTION_UNAVAILABLE', 503, 'La inspección de video no está disponible.');
    }
  }

  const streams = probe?.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  if (!video || !(Number(video.nb_read_frames) > 0) || Number(video.nb_read_frames) < Number(video.nb_frames)) {
    throw videoError('INVALID_VIDEO', 422, 'El video no se pudo leer completo.');
  }

  const audio = streams.find((stream) => stream.codec_type === 'audio');
  // AAC may report one more encoded frame than decoded frames because of priming.
  if (audio?.codec_name === 'aac' && Number(audio.nb_frames) > 1 &&
      !(Number(audio.nb_read_frames) + 1 >= Number(audio.nb_frames))) {
    throw videoError('INVALID_VIDEO', 422, 'El video no se pudo leer completo.');
  }

  return Boolean(
    probe.format?.format_name?.split(',').includes('mp4') &&
    MP4_BRAND.test(probe.format?.tags?.major_brand ?? '') &&
    video.codec_name === 'h264' && video.pix_fmt === 'yuv420p' &&
    streams.length === (audio ? 2 : 1) &&
    (!audio || (audio.codec_name === 'aac' && Number(audio.nb_read_frames) > 0)),
  );
}

async function withCompatibleVideo(file, send, { inspectMp4 = false } = {}) {
  const parsedName = path.parse(file.originalname || 'video');
  if (file.mimetype === 'video/mp4' && parsedName.ext.toLowerCase() === '.mp4' &&
      (!inspectMp4 || await isReusableMp4(file.path))) {
    return send(file);
  }

  const outputPath = `${file.path}-converted.mp4`;
  try {
    try {
      await run(process.env.FFMPEG_PATH || 'ffmpeg', [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-xerror', '-y',
        ...VIDEO_INPUT, '-i', file.path, '-map', '0:V:0', '-map', '0:a:0?',
        '-c:v', 'libx264', '-preset', 'veryfast', '-movflags', '+faststart',
        '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-pix_fmt', 'yuv420p', '-profile:v', 'baseline', '-level', '3.0',
        '-c:a', 'aac', '-b:a', '128k', outputPath,
      ], { ...PROCESS_LIMITS, timeout: 60_000 });
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw videoError('VIDEO_CONVERSION_UNAVAILABLE', 503, 'La conversión de video no está disponible.');
      }
      throw videoError('VIDEO_CONVERSION_FAILED', 422, 'No se pudo convertir el video a MP4 compatible.');
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
