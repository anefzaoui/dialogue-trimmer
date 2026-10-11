// Speech-band loudness envelope and quiet-point search (ported from shot-cutter's stale mode).
// Used to snap each trim to the quietest moment next to it, so a cut never lands on a breath or the first/last
// syllable. Voice activity decides WHERE the dialogue is; this decides exactly where to cut around it.
import { run, FFMPEG, probe } from './ffmpeg.js';

const SR = 16000;

/**
 * RMS level in dBFS per frame, measured in the speech band (150 Hz–4 kHz) so rumble and creaks don't count.
 * Streams 16 kHz mono PCM from ffmpeg in constant memory. Returns { frameSec, db: Float32Array, duration }.
 */
export async function audioEnvelope(file, { frameMs = 20, speechBand = true, duration, signal } = {}) {
  const frame = Math.round((SR * frameMs) / 1000);
  const dur = duration ?? (await probe(file, { signal })).duration;
  const out = [];
  let acc = 0, n = 0, carry = null;
  const af = speechBand ? ['-af', 'highpass=f=150,lowpass=f=4000'] : [];
  await run(FFMPEG, ['-hide_banner', '-nostats', '-loglevel', 'error', '-i', file, '-vn', ...af, '-ac', '1', '-ar', String(SR), '-f', 's16le', '-'], {
    signal,
    onData: (buf) => {
      if (carry) { buf = Buffer.concat([carry, buf]); carry = null; }
      const even = buf.length & ~1;
      if (even < buf.length) carry = buf.subarray(even);
      for (let i = 0; i < even; i += 2) {
        const v = buf.readInt16LE(i) / 32768;
        acc += v * v;
        if (++n === frame) { out.push(10 * Math.log10(acc / n + 1e-12)); acc = 0; n = 0; }
      }
    },
  });
  if (n) out.push(10 * Math.log10(acc / n + 1e-12));
  return { frameSec: frameMs / 1000, db: Float32Array.from(out), duration: dur };
}

/** Time (s) of the centre of the quietest frame in [from, to]; null when the window has no frames. */
export function quietestPoint(env, from, to) {
  const a = Math.max(0, Math.floor(from / env.frameSec));
  const b = Math.min(env.db.length - 1, Math.ceil(to / env.frameSec));
  if (b < a) return null;
  let best = a, min = Infinity;
  for (let i = a; i <= b; i++) if (env.db[i] < min) { min = env.db[i]; best = i; }
  return (best + 0.5) * env.frameSec;
}
