// ffmpeg/ffprobe process helpers shared by the library and the CLI (ported from shot-cutter).
// - Programs are spawned without a shell, so paths with spaces work on every OS
// - Only the stderr tail is kept for error messages (bounded memory)
// - AbortSignal support; progress from `-progress pipe:1`; raw stdout streaming for PCM
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';

export const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
export const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const TAIL = 16 * 1024;

/** Throws when ffmpeg or ffprobe cannot be started. */
export function checkTools() {
  for (const bin of [FFMPEG, FFPROBE]) {
    try { execFileSync(bin, ['-version'], { stdio: 'ignore' }); }
    catch { throw new Error(`${bin} not found. Install FFmpeg or set FFMPEG_PATH/FFPROBE_PATH`); }
  }
}

/**
 * Run a binary. Options:
 *  onProgress(sec)   fed from `-progress pipe:1` out_time_us
 *  onData(buf)       stream raw stdout (e.g. PCM) without accumulating it
 *  capture           resolve with stdout as a Buffer
 *  signal            AbortSignal → kills the process, rejects with AbortError
 */
export function run(bin, args, { onProgress, onData, capture = false, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    const chunks = [];
    let tail = '', progressBuf = '';
    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stderr.on('data', (d) => { tail = (tail + d.toString()).slice(-TAIL); });
    child.stdout.on('data', (d) => {
      if (capture) chunks.push(d);
      onData?.(d);
      if (!onProgress) return;
      progressBuf += d.toString();
      let i;
      while ((i = progressBuf.indexOf('\n')) >= 0) {
        const line = progressBuf.slice(0, i); progressBuf = progressBuf.slice(i + 1);
        const m = /^out_time_us=(\d+)/.exec(line);
        if (m) onProgress(Number(m[1]) / 1e6);
      }
    });
    child.on('error', (e) => reject(new Error(`${path.basename(bin)}: ${e.message}`)));
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(abortError());
      if (code === 0) resolve({ stdout: Buffer.concat(chunks) });
      else reject(new Error(`${path.basename(bin)} exited ${code}: ${tail.split('\n').filter(Boolean).slice(-5).join(' | ')}`));
    });
  });
}

export const abortError = () => Object.assign(new Error('Aborted'), { name: 'AbortError' });

/** Probe a clip. It must carry both video and audio (voice activity needs the audio). */
export async function probe(file, { signal } = {}) {
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { capture: true, signal });
  const data = JSON.parse(stdout.toString());
  const video = (data.streams || []).find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const audio = (data.streams || []).find((s) => s.codec_type === 'audio');
  if (!video) throw new Error(`no video stream in ${file}`);
  if (!audio) throw new Error(`no audio stream in ${file}; voice activity cannot be detected`);
  const duration = Number(data.format?.duration) || Number(video.duration) || Number(audio.duration) || 0;
  if (!(duration > 0)) throw new Error(`invalid duration for ${file}`);
  return {
    duration, width: Number(video.width), height: Number(video.height),
    fps: String(video.r_frame_rate || video.avg_frame_rate || '24/1'),
    videoCodec: video.codec_name, audioCodec: audio.codec_name,
    sampleRate: Number(audio.sample_rate) || null, channels: Number(audio.channels) || null,
    sizeBytes: Number(data.format?.size) || null,
  };
}
