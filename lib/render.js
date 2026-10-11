// Render the kept ranges of one or more clips into a single video, in order, in one ffmpeg pass.
import fs from 'node:fs';
import path from 'node:path';
import { run, probe, FFMPEG } from './ffmpeg.js';

export const RENDER_DEFAULTS = Object.freeze({ crf: 18, preset: 'medium', audioBitrate: '192k', driftTolerance: 0.25 });

/**
 * Pure filter-graph builder (exported for tests). Every clip is scaled/padded to the first clip's size and frame
 * rate and its audio is normalized to the first clip's channel layout, so concat behaves the same on every ffmpeg.
 * clips: [{trimStart, trimEnd, source:{width, height, fps, channels}}]. Returns { graph, fps, fpsFallback }.
 */
export function buildFilterGraph(clips) {
  const width = Math.max(2, clips[0].source.width - (clips[0].source.width % 2));
  const height = Math.max(2, clips[0].source.height - (clips[0].source.height % 2));
  let fps = String(clips[0].source.fps);
  const [num, den] = fps.split('/').map(Number);
  const fpsFallback = !(num > 0) || (fps.includes('/') && !(den > 0));
  if (fpsFallback) fps = '24';
  const layout = (clips[0].source.channels || 2) === 1 ? 'mono' : 'stereo';
  const parts = [];
  clips.forEach((clip, i) => {
    parts.push(`[${i}:v:0]trim=start=${clip.trimStart.toFixed(6)}:end=${clip.trimEnd.toFixed(6)},`
      + `setpts=PTS-STARTPTS,fps=${fps},scale=${width}:${height}:force_original_aspect_ratio=decrease,`
      + `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v${i}]`);
    parts.push(`[${i}:a:0]atrim=start=${clip.trimStart.toFixed(6)}:end=${clip.trimEnd.toFixed(6)},`
      + `asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=${layout}[a${i}]`);
  });
  parts.push(`${clips.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${clips.length}:v=1:a=1[vout][aout]`);
  return { graph: parts.join(';'), fps, fpsFallback };
}

/**
 * Render clips (each with its input path and trim range) to `output`. Written to a partial file, probed, and only
 * then renamed into place. The measured duration is checked against the plan (drift beyond `driftTolerance` is
 * reported, not thrown). Returns { plannedDuration, finalDuration, drift, driftWarning, fpsFallback }.
 */
export async function renderClips(clips, output, opts = {}, { onProgress, signal } = {}) {
  const o = { ...RENDER_DEFAULTS, ...opts };
  const plannedDuration = clips.reduce((sum, c) => sum + (c.trimEnd - c.trimStart), 0);
  const { graph, fpsFallback } = buildFilterGraph(clips);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const partial = path.join(path.dirname(output), `.${path.basename(output, path.extname(output))}.${process.pid}.partial.mp4`);
  try {
    await run(FFMPEG, [
      '-y', '-hide_banner', '-loglevel', 'error',
      ...clips.flatMap((c) => ['-i', c.input]),
      '-filter_complex', graph, '-map', '[vout]', '-map', '[aout]',
      '-c:v', 'libx264', '-preset', o.preset, '-crf', String(o.crf),
      '-c:a', 'aac', '-b:a', o.audioBitrate, '-movflags', '+faststart',
      '-progress', 'pipe:1', partial,
    ], { signal, onProgress: onProgress && ((sec) => onProgress(plannedDuration > 0 ? Math.min(1, sec / plannedDuration) : 0)) });
    const finalDuration = (await probe(partial, { signal })).duration;
    const drift = finalDuration - plannedDuration;
    if (fs.existsSync(output)) fs.unlinkSync(output);
    fs.renameSync(partial, output);
    return { plannedDuration, finalDuration, drift, driftWarning: Math.abs(drift) > o.driftTolerance, fpsFallback };
  } catch (error) {
    if (fs.existsSync(partial)) fs.unlinkSync(partial);
    throw error;
  }
}
