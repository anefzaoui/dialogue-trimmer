// dialogue-trimmer as a library. Importing has no side effects: no CLI parsing, no process.exit, and Echogarden is
// only loaded when detectDialogue runs.
export { checkTools, probe, run, FFMPEG, FFPROBE } from './lib/ffmpeg.js';
export { audioEnvelope, quietestPoint } from './lib/envelope.js';
export { detectDialogue, planTrim, TRIM_DEFAULTS } from './lib/trim.js';
export { renderClips, buildFilterGraph, RENDER_DEFAULTS } from './lib/render.js';
export const VERSION = '1.1.0';
