# dialogue-trimmer

Cross-platform CLI **and importable library** that cuts the dead air before the
first spoken line and after the last one in a video clip. Pass it one clip and you get that clip back,
trimmed. Pass it several and each one is trimmed on its own, then they are
joined into a single video in the order you listed them.

I built it for AI-generated microdrama clips, which often have good acting and
dialogue surrounded by half a second or more of useless lead-in or tail. Every
pause inside the conversation is preserved; only the two outer edges change.

## Why voice activity instead of `silencedetect`?

Generated videos commonly have music, rain, room tone, or crowd ambience during
the unwanted edge time. A volume-based silence detector hears that sound and
refuses to trim it. `dialogue-trimmer` uses Silero voice activity detection through
Echogarden, so it finds people speaking even when the soundtrack is not digitally
silent.

## How each cut is placed

1. **Voice activity** (Silero) finds the first and last spoken word.
2. **Asymmetric padding** keeps a little before the first word (`--pad-before`,
   0.08 s) and a little more after the last (`--pad-after`, 0.15 s), because
   speech fades out slower than it starts.
3. **Snap to quiet.** A speech-band loudness envelope (150 Hz–4 kHz, 20 ms frames)
   is measured, and each padded cut moves to the quietest moment within
   `--snap-window` (0.08 s). A cut can move outward or inward, but never into the
   speech itself, so it does not land on a breath or a syllable.
4. **Render once.** All kept ranges are joined in one ffmpeg pass, written to a
   partial file, probed, and only then moved into place. If the measured
   duration drifts from the plan by more than 0.25 s, you get a warning and the
   report records it.

The padding and snapping come from
[shot-cutter](https://github.com/anefzaoui/shot-cutter)'s stale mode.

## Requirements

- Node.js 20 or newer
- `ffmpeg` and `ffprobe` on PATH, or set `FFMPEG_PATH` / `FFPROBE_PATH`
- `npm install` once inside this directory

It works on macOS, Linux, and Windows. Paths use `node:path`; FFmpeg is launched
directly without shell commands; no Unix-only utilities are used.

On the very first run, Echogarden downloads the Silero VAD model (about 1.7 MB)
into a per-user cache and every later run works offline. The cache lives at
`~/Library/Application Support/echogarden/packages` on macOS,
`~/.local/share/echogarden` on Linux, and `%APPDATA%\echogarden` on Windows.
Air-gapped machines need that one package placed in the cache manually.

About the two engines: `silero` (the default) is a small neural network that
recognizes the sound of human speech and gives precise segment boundaries.
`webrtc` is a much simpler detector and tends to mark entire clips as speech
when music or ambience is present, which means no trimming; the tool warns when
that happens. Stay on silero unless you have a specific reason not to.

## Install

```bash
npm install
npm link
```

Or use it without linking:

```bash
node dialogue-trimmer.js input.mp4 --out output.mp4
```

## Usage

Trim one clip:

```bash
dialogue-trimmer scene-01.mp4 --out scene-01-trimmed.mp4
```

Trim and assemble an ordered episode:

```bash
dialogue-trimmer scene-01.mp4 scene-02.mp4 scene-03.mp4 \
  --out episode.mp4
```

The output is rendered once. Each input is trimmed from its first detected voice
minus the safety pad through its last detected voice plus the safety pad, then the
kept regions are concatenated in argument order.

Sources are never modified. Existing outputs are rejected unless `--force` is
provided.

## Options

| Flag | Default | Meaning |
|---|---:|---|
| `--out <file>` | `<clip>-dialogue-trimmed.mp4` | Output MP4 |
| `--report <file>` | Beside output | JSON audit report |
| `--pad <seconds>` | | Sets both `--pad-before` and `--pad-after` |
| `--pad-before <s>` | `0.08` | Kept before the first detected voice |
| `--pad-after <s>` | `0.15` | Kept after the last detected voice |
| `--snap-window <s>` | `0.08` | Snap each cut to the quietest moment within ± this; `0` turns snapping off |
| `--threshold <0..1>` | `0.5` | Voice probability threshold |
| `--engine <name>` | `silero` | `silero` or `webrtc` VAD |
| `--crf <n>` | `18` | H.264 quality; lower is higher quality |
| `--preset <name>` | `medium` | H.264 encoding preset |
| `--audio-bitrate <n>` | `192k` | AAC output bitrate |
| `--dry-run` | off | Detect and report without rendering |
| `--force` | off | Replace existing output/report |
| `--json` | off | Print the full report to stdout |
| `--quiet`, `--no-color` | off | Terminal behavior |

## Audit report

Every run writes `<output-name>.trim-report.json`. It records:

- the exact input order and media probe for every clip;
- every detected voice interval;
- first and last detected speech;
- padded boundaries (`paddedStart`/`paddedEnd`) and the final snapped trim
  (`trimStart`/`trimEnd`);
- padding and snap settings;
- opening, ending, and total seconds removed;
- source, planned, and measured output durations, plus `durationDrift` and
  `durationDriftWarning`;
- all quality and detector settings.

This makes the edit reproducible and lets an automated pipeline reject clips with
no detected speech instead of guessing.

## What it does not do

- It does not remove pauses between lines.
- It does not change playback speed.
- It does not overwrite source clips.
- It does not treat music or ambience as dialogue.
- It fails when a clip contains no detected voice, on purpose: whether a
  dialogue-free shot should be kept is a decision for you, not the trimmer.

## As a library

```js
import { detectDialogue, renderClips, planTrim, TRIM_DEFAULTS } from 'dialogue-trimmer';

const ac = new AbortController();
const clips = [];
for (const file of ['scene-01.mp4', 'scene-02.mp4']) {
  clips.push(await detectDialogue(file, { padAfter: 0.2 }, { signal: ac.signal }));
}
const { finalDuration, drift, driftWarning } = await renderClips(clips, 'episode.mp4', {}, {
  onProgress: (f) => console.log(Math.round(f * 100) + '%'),
  signal: ac.signal,
});
```

Importing has no side effects: no CLI parsing, no `process.exit`, and Echogarden
loads only when `detectDialogue` runs. `detectDialogue` returns the source probe,
every voice interval, the speech edges, and the padded and snapped trim.
`planTrim` is the pure boundary math, so you can feed it your own voice activity.
`audioEnvelope` and `quietestPoint` are exported for your own cut points.

Install from git: `npm i github:anefzaoui/dialogue-trimmer`.

## Typical command

The defaults are what I use for microdrama clips:

```bash
dialogue-trimmer scene-*.mp4 --out episode.mp4
```

On shells that do not expand wildcards (notably some Windows terminals), list the
clips explicitly or invoke the CLI from a script with an argument array.

## Tests

```bash
npm test
```

The tests cover the boundary math, the snapping (including that it never cuts
into speech), the filter graph, the envelope on synthetic ffmpeg clips, and the
render with its drift check. One end-to-end test speaks a real line with macOS
`say`, pads it with silence, and checks that the CLI finds the speech and removes
the dead air. It is skipped where `say` is not available. That test's first run
downloads the Silero model (about 1.7 MB).

## License

MIT
