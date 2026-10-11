// Tests: pure boundary math, filter graph and envelope on synthetic ffmpeg clips; one end-to-end run on real speech
// made with macOS `say` (skipped where `say` is missing). The first end-to-end run downloads Silero (about 1.7 MB).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { planTrim, quietestPoint, audioEnvelope, buildFilterGraph, renderClips, FFMPEG, TRIM_DEFAULTS } from '../index.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dialogue-trimmer-'));
const ff = (...args) => execFileSync(FFMPEG, ['-v', 'error', '-y', ...args]);
/** A clip with video and `segments` of audio: [['silence', s] | ['tone', s]]. */
function makeClip(name, segments) {
  const parts = segments.map(([kind, s], i) => (kind === 'tone'
    ? `sine=f=440:d=${s}:r=48000[s${i}]` : `anullsrc=r=48000:cl=mono,atrim=0:${s}[s${i}]`));
  const total = segments.reduce((a, [, s]) => a + s, 0);
  const file = path.join(tmp, name);
  ff('-f', 'lavfi', '-i', `color=c=gray:s=320x568:d=${total}:r=24`,
    '-filter_complex', `${parts.join(';')};${segments.map((_, i) => `[s${i}]`).join('')}concat=n=${segments.length}:v=0:a=1[a]`,
    '-map', '0:v', '-map', '[a]', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', file);
  return file;
}
/** A fake envelope: frame levels in dB, 20 ms frames. */
const env = (db) => ({ frameSec: 0.02, db: Float32Array.from(db), duration: db.length * 0.02 });

test('padding is asymmetric and clamped to the clip', () => {
  const p = planTrim({ activity: [{ startTime: 1, endTime: 2 }], duration: 3 }, { padBefore: 0.1, padAfter: 0.3, snapWindow: 0 });
  assert.equal(p.trimStart, 0.9);
  assert.equal(p.trimEnd.toFixed(3), '2.300');
  const edge = planTrim({ activity: [{ startTime: 0.02, endTime: 2.95 }], duration: 3 }, { snapWindow: 0 });
  assert.equal(edge.trimStart, 0);
  assert.equal(edge.trimEnd, 3);
});

test('defaults keep more after the speech than before it', () => {
  assert.ok(TRIM_DEFAULTS.padAfter > TRIM_DEFAULTS.padBefore);
});

test('the first and last spans bound the trim; inner pauses stay', () => {
  const p = planTrim({ activity: [{ startTime: 0.5, endTime: 1 }, { startTime: 2, endTime: 2.5 }], duration: 4 }, { padBefore: 0, padAfter: 0, snapWindow: 0 });
  assert.deepEqual([p.speechStart, p.speechEnd, p.trimStart, p.trimEnd], [0.5, 2.5, 0.5, 2.5]);
});

test('a cut snaps to the quietest nearby frame but never into the speech', () => {
  // speech 1.00–2.00 s; loud everywhere except a quiet frame at 0.94 s (frame 47) and 2.24 s (frame 112)
  const db = Array(150).fill(-20);
  db[47] = -60; db[112] = -60;
  const p = planTrim({ activity: [{ startTime: 1, endTime: 2 }], duration: 3, envelope: env(db) }, { padBefore: 0.08, padAfter: 0.2, snapWindow: 0.08 });
  assert.equal(p.trimStart.toFixed(2), '0.95'); // frame 47 centre
  assert.equal(p.trimEnd.toFixed(2), '2.25');   // frame 112 centre
  // a quiet frame INSIDE the speech is ignored: the cut stays at the speech edge
  const inside = Array(150).fill(-20); inside[52] = -70;
  const q = planTrim({ activity: [{ startTime: 1, endTime: 2 }], duration: 3, envelope: env(inside) }, { padBefore: 0, padAfter: 0, snapWindow: 0.08 });
  assert.equal(q.trimStart, 1);
});

test('no voice is an error, not a guess', () => {
  assert.throws(() => planTrim({ activity: [], duration: 3 }), /no voice/);
});

test('a single span over the whole clip is flagged', () => {
  assert.equal(planTrim({ activity: [{ startTime: 0, endTime: 3 }], duration: 3 }, { snapWindow: 0 }).wholeClipIsSpeech, true);
});

test('quietestPoint finds the quietest frame and handles an empty window', () => {
  assert.equal(quietestPoint(env([-10, -50, -10]), 0, 0.06).toFixed(2), '0.03');
  assert.equal(quietestPoint(env([-10]), 5, 6), null);
});

test('filter graph trims every clip and concatenates in order', () => {
  const source = { width: 721, height: 1281, fps: '24/1', channels: 1 };
  const { graph, fps } = buildFilterGraph([{ trimStart: 0.5, trimEnd: 2, source }, { trimStart: 0.1, trimEnd: 1, source }]);
  assert.match(graph, /\[0:v:0\]trim=start=0\.500000:end=2\.000000/);
  assert.match(graph, /\[1:a:0\]atrim=start=0\.100000:end=1\.000000/);
  assert.match(graph, /scale=720:1280/);           // even dimensions
  assert.match(graph, /channel_layouts=mono/);
  assert.match(graph, /\[v0\]\[a0\]\[v1\]\[a1\]concat=n=2/);
  assert.equal(fps, '24/1');
  assert.equal(buildFilterGraph([{ trimStart: 0, trimEnd: 1, source: { ...source, fps: '0/0' } }]).fpsFallback, true);
});

test('envelope of a real clip: tone is loud, silence is quiet', async () => {
  const file = makeClip('envelope.mp4', [['silence', 1], ['tone', 1], ['silence', 1]]);
  const e = await audioEnvelope(file);
  assert.ok(Math.abs(e.duration - 3) < 0.1);
  const quiet = quietestPoint(e, 0, 2.95);
  assert.ok(quiet < 1 || quiet > 2, `quietest point ${quiet} should be outside the tone`);
  const mid = e.db[Math.round(1.5 / e.frameSec)];
  assert.ok(mid > -30, `tone level ${mid} dB`);
});

test('render joins kept ranges and reports duration drift', async () => {
  const a = makeClip('a.mp4', [['silence', 0.5], ['tone', 1], ['silence', 0.5]]);
  const b = makeClip('b.mp4', [['tone', 1], ['silence', 1]]);
  const probeA = { width: 320, height: 568, fps: '24/1', channels: 1 };
  const out = path.join(tmp, 'joined.mp4');
  const r = await renderClips([
    { input: a, trimStart: 0.5, trimEnd: 1.5, source: probeA },
    { input: b, trimStart: 0, trimEnd: 1, source: probeA },
  ], out, { preset: 'ultrafast' });
  assert.ok(fs.existsSync(out));
  assert.ok(Math.abs(r.finalDuration - 2) < 0.25, `final ${r.finalDuration}`);
  assert.equal(r.driftWarning, false);
  // an impossible tolerance turns the same render into a drift warning
  const strict = await renderClips([{ input: a, trimStart: 0.5, trimEnd: 1.5, source: probeA }], path.join(tmp, 'strict.mp4'), { preset: 'ultrafast', driftTolerance: -1 });
  assert.equal(strict.driftWarning, true);
});

const hasSay = spawnSync('say', ['-v', '?'], { stdio: 'ignore' }).status === 0;
test('end to end: real speech is found and the dead air around it is cut', { skip: !hasSay && 'needs macOS `say`' }, async () => {
  const speech = path.join(tmp, 'speech.aiff');
  execFileSync('say', ['-o', speech, 'Water. I need water. Please.']);
  const clip = path.join(tmp, 'speech.mp4');
  // 1 s silence + speech + 1 s silence, under a gray picture
  ff('-f', 'lavfi', '-i', 'color=c=gray:s=320x568:r=24', '-i', speech,
    '-filter_complex', '[1:a]adelay=1000:all=1,apad=pad_dur=1,aresample=48000[a]', '-map', '0:v', '-map', '[a]',
    '-shortest', '-c:v', 'libx264', '-c:a', 'aac', clip);
  const out = path.join(tmp, 'speech-trimmed.mp4');
  const cli = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'dialogue-trimmer.js');
  const res = spawnSync(process.execPath, [cli, clip, '--out', out, '--json', '--quiet', '--preset', 'ultrafast'], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const report = JSON.parse(res.stdout);
  const c = report.clips[0];
  assert.ok(c.speechStart > 0.7 && c.speechStart < 1.4, `speech starts at ${c.speechStart}`);
  assert.ok(c.trimStart <= c.speechStart && c.trimEnd >= c.speechEnd);
  assert.ok(report.totalRemoved > 1.2, `removed ${report.totalRemoved}`);
  assert.equal(report.durationDriftWarning, false);
  assert.ok(fs.existsSync(out));
});
