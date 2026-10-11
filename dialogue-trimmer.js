#!/usr/bin/env node
/**
 * dialogue-trimmer: remove non-dialogue lead-in/tail and optionally assemble clips.
 *
 * The CLI sits on top of the library (index.js + lib/); keep them together.
 * Requirements: Node.js >= 20, ffmpeg + ffprobe, and the declared Echogarden
 * dependency. External programs are spawned without a shell for portable path
 * handling on macOS, Linux, and Windows.
 */

import fs from 'node:fs';
import path from 'node:path';
import { checkTools, detectDialogue, renderClips, TRIM_DEFAULTS, RENDER_DEFAULTS, VERSION } from './index.js';

const TOOL = 'dialogue-trimmer';

const isTTY = process.stdout.isTTY;
let useColor = isTTY && !process.env.NO_COLOR;
let quiet = false;
const paint = (code) => (value) => useColor ? `\x1b[${code}m${value}\x1b[0m` : String(value);
const c = { bold:paint('1'),dim:paint('2'),green:paint('32'),yellow:paint('33'),red:paint('31'),cyan:paint('36') };
const log = (...args) => { if (!quiet) console.log(...args); };
const die = (message,code=2) => { console.error(`${c.red('error:')} ${message}`); process.exit(code); };
const warn = (message) => { if (!quiet) console.log(`${c.yellow('warn    ')} ${message}`); };

// ANSI erase-line when colors are on; plain \r with padding otherwise, so
// consoles without VT support degrade cleanly.
let lastProgressLen = 0;
function progressLine(text) {
  if (quiet || !isTTY) return;
  if (useColor) process.stdout.write(`\r\x1b[2K${text}`);
  else process.stdout.write('\r' + text.padEnd(lastProgressLen));
  lastProgressLen = Math.max(lastProgressLen, text.length);
}
function endProgress() {
  if (quiet || !isTTY) return;
  if (useColor) process.stdout.write('\r\x1b[2K');
  else process.stdout.write('\r' + ' '.repeat(lastProgressLen) + '\r');
  lastProgressLen = 0;
}

const HELP = `
${c.bold('dialogue-trimmer')} v${VERSION} - trim outer dead air using voice activity

${c.bold('Usage:')}
  dialogue-trimmer <clip.mp4> [more-clips.mp4 ...] --out <output.mp4> [options]

One input creates one trimmed video. Multiple inputs are independently bounded by
their first and last detected voice, then assembled in the exact supplied order.
Pauses between lines remain untouched. Source files are never modified.

${c.bold('Options:')}
  --out <file>          Output MP4 (default: <clip>-dialogue-trimmed.mp4 for one input)
  --report <file>       JSON audit path (default: beside output)
  --pad <seconds>       Padding on both edges (sets --pad-before and --pad-after)
  --pad-before <s>      Kept before the first detected voice (default: 0.08)
  --pad-after <s>       Kept after the last detected voice (default: 0.15)
  --snap-window <s>     Snap each cut to the quietest moment within ± this many
                        seconds, never into the speech (default: 0.08; 0 = off)
  --threshold <0..1>    Voice probability threshold (default: 0.5)
  --engine <name>       silero or webrtc (default: silero)
  --crf <n>             H.264 output quality (default: 18)
  --preset <name>       H.264 preset (default: medium)
  --audio-bitrate <n>   AAC bitrate (default: 192k)
  --dry-run             Detect and report boundaries without rendering video
  --force               Replace an existing output/report
  --json                Print the complete report to stdout
  --quiet               Errors only
  --no-color            Disable ANSI color
  --version, --help

${c.bold('Environment:')}
  FFMPEG_PATH and FFPROBE_PATH can point to non-standard executable locations.
  NO_COLOR disables ANSI color according to the standard convention.
`;

function parseArgs(argv) {
  const opts = {
    inputs:[],out:null,report:null,pad:null,padBefore:null,padAfter:null,snapWindow:TRIM_DEFAULTS.snapWindow,
    threshold:TRIM_DEFAULTS.threshold,engine:TRIM_DEFAULTS.engine,
    crf:RENDER_DEFAULTS.crf,preset:RENDER_DEFAULTS.preset,audioBitrate:RENDER_DEFAULTS.audioBitrate,
    dryRun:false,force:false,json:false
  };
  for (let i=0;i<argv.length;i++) {
    let arg=argv[i];
    let inline=null;
    const equals=arg.indexOf('=');
    if (arg.startsWith('--') && equals>0) { inline=arg.slice(equals+1); arg=arg.slice(0,equals); }
    const value=()=>{
      if (inline!==null) return inline;
      if (i+1>=argv.length) die(`${arg} requires a value`);
      return argv[++i];
    };
    switch(arg) {
      case '--help': case '-h': console.log(HELP); process.exit(0); break;
      case '--version': case '-v': console.log(VERSION); process.exit(0); break;
      case '--out': opts.out=value(); break;
      case '--report': opts.report=value(); break;
      case '--pad': opts.pad=Number(value()); break;
      case '--pad-before': opts.padBefore=Number(value()); break;
      case '--pad-after': opts.padAfter=Number(value()); break;
      case '--snap-window': opts.snapWindow=Number(value()); break;
      case '--threshold': opts.threshold=Number(value()); break;
      case '--engine': opts.engine=value(); break;
      case '--crf': opts.crf=Number(value()); break;
      case '--preset': opts.preset=value(); break;
      case '--audio-bitrate': opts.audioBitrate=value(); break;
      case '--dry-run': opts.dryRun=true; break;
      case '--force': opts.force=true; break;
      case '--json': opts.json=true; break;
      case '--quiet': quiet=true; break;
      case '--no-color': useColor=false; break;
      default:
        if (arg.startsWith('-')) die(`unknown option ${arg}\n${HELP}`);
        opts.inputs.push(arg);
    }
  }
  if (!opts.inputs.length) { console.log(HELP); process.exit(2); }
  // --pad sets both edges; --pad-before/--pad-after win over it whatever the order
  opts.padBefore=opts.padBefore??opts.pad??TRIM_DEFAULTS.padBefore;
  opts.padAfter=opts.padAfter??opts.pad??TRIM_DEFAULTS.padAfter;
  for (const [flag,v] of [['--pad-before',opts.padBefore],['--pad-after',opts.padAfter]]) {
    if (!Number.isFinite(v) || v<0 || v>2) die(`${flag} must be between 0 and 2 seconds`);
  }
  if (!Number.isFinite(opts.snapWindow) || opts.snapWindow<0 || opts.snapWindow>1) die('--snap-window must be between 0 and 1 second');
  if (!Number.isFinite(opts.threshold) || opts.threshold<0 || opts.threshold>1) die('--threshold must be between 0 and 1');
  if (!Number.isFinite(opts.crf) || opts.crf<0 || opts.crf>51) die('--crf must be between 0 and 51');
  if (!['silero','webrtc'].includes(opts.engine)) die('--engine must be silero or webrtc');
  if (!/^[1-9][0-9]*k$/i.test(opts.audioBitrate)) die('--audio-bitrate must look like 192k');
  return opts;
}

function atomicJson(file,data) {
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const partial=`${file}.partial`;
  fs.writeFileSync(partial,`${JSON.stringify(data,null,2)}\n`);
  fs.renameSync(partial,file);
}

function seconds(value) { return Number(Number(value).toFixed(3)); }

async function main() {
  const opts=parseArgs(process.argv.slice(2));
  try { checkTools(); } catch (error) { die(error.message); }

  const inputs=opts.inputs.map((input)=>path.resolve(input));
  for (const input of inputs) if (!fs.existsSync(input)) die(`input not found: ${input}`);
  const first=inputs[0];
  const defaultOutput=inputs.length===1
    ? path.join(path.dirname(first),`${path.basename(first,path.extname(first))}-dialogue-trimmed.mp4`)
    : path.resolve('dialogue-trimmed-assembly.mp4');
  const output=path.resolve(opts.out||defaultOutput);
  const outputStem=path.basename(output,path.extname(output));
  const reportFile=path.resolve(opts.report||path.join(path.dirname(output),`${outputStem}.trim-report.json`));
  if (inputs.includes(output)) die('output must not overwrite an input file');
  for (const target of [output,reportFile]) {
    if (fs.existsSync(target) && !opts.force) die(`already exists: ${target} (use --force to replace)`);
  }

  log(`${c.bold(TOOL)} v${VERSION}`);
  log(`${c.dim('inputs  ')} ${inputs.length}`);
  log(`${c.dim('output  ')} ${output}`);

  const trimOpts={engine:opts.engine,threshold:opts.threshold,padBefore:opts.padBefore,padAfter:opts.padAfter,snapWindow:opts.snapWindow};
  const clips=[];
  for (let index=0;index<inputs.length;index++) {
    log(`${c.cyan('detect  ')} ${index+1}/${inputs.length} ${path.basename(inputs[index])}`);
    const clip=await detectDialogue(inputs[index],trimOpts);
    if (clip.wholeClipIsSpeech) {
      warn(`${path.basename(clip.input)}: detector reports one speech span covering the whole clip; nothing will be trimmed. The ${opts.engine} engine may be too coarse for this material (silero is the precise default).`);
    }
    clips.push({index:index+1,...clip});
    log(`${c.green('keep    ')} ${seconds(clip.trimStart)}s → ${seconds(clip.trimEnd)}s (${seconds(clip.trimmedDuration)}s)`);
  }

  const sourceDuration=clips.reduce((sum,clip)=>sum+clip.source.duration,0);
  const plannedDuration=clips.reduce((sum,clip)=>sum+clip.trimmedDuration,0);
  let rendered=null;
  if (!opts.dryRun) {
    try {
      rendered=await renderClips(clips,output,{crf:opts.crf,preset:opts.preset,audioBitrate:opts.audioBitrate},{
        onProgress:(f)=>progressLine(`${c.cyan('render  ')} ${(f*100).toFixed(0).padStart(3)}% of ${seconds(plannedDuration)}s`)
      });
    } finally { endProgress(); }
    if (rendered.fpsFallback) warn(`unusable frame rate "${clips[0].source.fps}" reported by probe, fell back to 24`);
    if (rendered.driftWarning) {
      warn(`output duration ${seconds(rendered.finalDuration)}s differs from plan ${seconds(plannedDuration)}s by ${seconds(Math.abs(rendered.drift))}s`);
    }
  }
  const finalDuration=rendered?rendered.finalDuration:null;

  const report={
    tool:TOOL,version:VERSION,createdAt:new Date().toISOString(),
    output:opts.dryRun?null:output,
    settings:{padBefore:opts.padBefore,padAfter:opts.padAfter,snapWindow:opts.snapWindow,engine:opts.engine,activityThreshold:opts.threshold,crf:opts.crf,preset:opts.preset,audioBitrate:opts.audioBitrate},
    sourceDuration:seconds(sourceDuration),plannedDuration:seconds(plannedDuration),
    finalDuration:finalDuration===null?null:seconds(finalDuration),
    durationDrift:rendered?seconds(rendered.drift):null,durationDriftWarning:rendered?rendered.driftWarning:null,
    leadingRemoved:seconds(clips.reduce((sum,clip)=>sum+clip.leadingRemoved,0)),
    trailingRemoved:seconds(clips.reduce((sum,clip)=>sum+clip.trailingRemoved,0)),
    totalRemoved:seconds(sourceDuration-plannedDuration),
    clips:clips.map((clip)=>({
      index:clip.index,input:clip.input,source:clip.source,
      speechStart:seconds(clip.speechStart),speechEnd:seconds(clip.speechEnd),
      trimStart:seconds(clip.trimStart),trimEnd:seconds(clip.trimEnd),
      paddedStart:seconds(clip.paddedStart),paddedEnd:seconds(clip.paddedEnd),
      leadingRemoved:seconds(clip.leadingRemoved),trailingRemoved:seconds(clip.trailingRemoved),
      trimmedDuration:seconds(clip.trimmedDuration),voiceActivity:clip.voiceActivity
    }))
  };
  atomicJson(reportFile,report);
  log(`${c.bold('done    ')} ${opts.dryRun?'dry run':`${seconds(finalDuration)}s output`}`);
  log(`${c.dim('removed ')} ${report.totalRemoved}s (${report.leadingRemoved}s opening + ${report.trailingRemoved}s ending)`);
  log(`${c.dim('report  ')} ${reportFile}`);
  if (opts.json) console.log(JSON.stringify(report,null,2));
}

main().catch((error)=>die(error?.stack||error?.message||String(error),1));
