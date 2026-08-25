# dialogue-trimmer

Cross-platform CLI that cuts the dead air before the first spoken line and after
the last one in a video clip. Pass it one clip and you get that clip back,
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
| `--pad <seconds>` | `0.08` | Speech safety padding on each outer edge |
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
- trim boundaries and safety padding;
- opening, ending, and total seconds removed;
- source, planned, and measured output durations;
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

## Typical command

The defaults are what I use for microdrama clips:

```bash
dialogue-trimmer scene-*.mp4 --out episode.mp4 --pad 0.08
```

On shells that do not expand wildcards (notably some Windows terminals), list the
clips explicitly or invoke the CLI from a script with an argument array.

## License

MIT
