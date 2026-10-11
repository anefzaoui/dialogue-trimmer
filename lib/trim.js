// Where to cut one clip: voice activity finds the first and last spoken word; asymmetric padding keeps the breath
// before and the decay after; each cut is then snapped to the quietest moment nearby, never into the speech.
import { probe, abortError } from './ffmpeg.js';
import { audioEnvelope, quietestPoint } from './envelope.js';

export const TRIM_DEFAULTS = Object.freeze({
  engine: 'silero',     // or 'webrtc'
  threshold: 0.5,       // voice probability
  padBefore: 0.08,      // seconds kept before the first detected voice
  padAfter: 0.15,       // seconds kept after the last one (speech decays slower than it starts)
  snapWindow: 0.08,     // search ± this around each padded cut for the quietest frame; 0 disables snapping
  frameMs: 20,          // envelope resolution used by the snap
});

/**
 * Pure boundary math (exported for reuse and tests).
 * activity: [{startTime, endTime}] active-speech spans; envelope: from audioEnvelope, or null to skip snapping.
 */
export function planTrim({ activity, duration, envelope = null }, opts = {}) {
  const o = { ...TRIM_DEFAULTS, ...opts };
  if (!activity?.length) throw new Error('no voice detected');
  const speechStart = Number(activity[0].startTime);
  const speechEnd = Number(activity.at(-1).endTime);
  let trimStart = Math.max(0, speechStart - o.padBefore);
  let trimEnd = Math.min(duration, speechEnd + o.padAfter);
  const padded = { trimStart, trimEnd };
  if (envelope && o.snapWindow > 0) {
    const s = quietestPoint(envelope, trimStart - o.snapWindow, trimStart + o.snapWindow);
    const e = quietestPoint(envelope, trimEnd - o.snapWindow, trimEnd + o.snapWindow);
    // a snap may move a cut outward or inward, but never past the speech itself
    if (s !== null) trimStart = Math.max(0, Math.min(speechStart, s));
    if (e !== null) trimEnd = Math.min(duration, Math.max(speechEnd, e));
  }
  return {
    speechStart, speechEnd, trimStart, trimEnd,
    paddedStart: padded.trimStart, paddedEnd: padded.trimEnd,
    leadingRemoved: trimStart, trailingRemoved: duration - trimEnd, trimmedDuration: trimEnd - trimStart,
    wholeClipIsSpeech: activity.length === 1 && speechStart <= 0.05 && speechEnd >= duration - 0.05,
  };
}

/**
 * Detect the dialogue in one clip and plan its trim.
 * @returns {Promise<{source, voiceActivity, speechStart, speechEnd, trimStart, trimEnd, ...}>}
 */
export async function detectDialogue(file, opts = {}, { signal } = {}) {
  const o = { ...TRIM_DEFAULTS, ...opts };
  if (signal?.aborted) throw abortError();
  const source = await probe(file, { signal });
  // imported lazily: Echogarden is heavy and the pure helpers above must load without it
  const { detectVoiceActivity } = await import('echogarden');
  const vad = await detectVoiceActivity(file, {
    engine: o.engine, activityThreshold: o.threshold,
    silero: { frameDuration: 90 }, webrtc: { frameDuration: 30, mode: 1 },
  }, { logLevel: 'silent' });
  if (signal?.aborted) throw abortError();
  // keep only active-speech segments; current engines emit nothing else, but the boundary math must not depend on it
  const voiceActivity = vad.timeline.filter(({ text }) => text === 'active')
    .map(({ type, text, startTime, endTime }) => ({ type, text, startTime, endTime }));
  if (!voiceActivity.length) throw new Error(`no voice detected in ${file}`);
  const envelope = o.snapWindow > 0 ? await audioEnvelope(file, { frameMs: o.frameMs, duration: source.duration, signal }) : null;
  return { input: file, source, voiceActivity, ...planTrim({ activity: voiceActivity, duration: source.duration, envelope }, o) };
}
