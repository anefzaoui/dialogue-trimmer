#!/usr/bin/env node
/**
 * dialogue-trimmer: remove non-dialogue lead-in/tail and optionally assemble clips.
 *
 * Requirements: Node.js >= 20, ffmpeg + ffprobe, and the declared Echogarden
 * dependency. External programs are spawned without a shell for portable path
 * handling on macOS, Linux, and Windows.
 */

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { detectVoiceActivity } from 'echogarden';

const VERSION = '1.0.0';
const TOOL = 'dialogue-trimmer';
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

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
  --pad <seconds>       Safety padding before/after detected voice (default: 0.08)
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
    inputs:[],out:null,report:null,pad:0.08,threshold:0.5,engine:'silero',
    crf:18,preset:'medium',audioBitrate:'192k',dryRun:false,force:false,json:false
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
  if (!Number.isFinite(opts.pad) || opts.pad<0 || opts.pad>2) die('--pad must be between 0 and 2 seconds');
  if (!Number.isFinite(opts.threshold) || opts.threshold<0 || opts.threshold>1) die('--threshold must be between 0 and 1');
  if (!Number.isFinite(opts.crf) || opts.crf<0 || opts.crf>51) die('--crf must be between 0 and 51');
  if (!['silero','webrtc'].includes(opts.engine)) die('--engine must be silero or webrtc');
  if (!/^[1-9][0-9]*k$/i.test(opts.audioBitrate)) die('--audio-bitrate must look like 192k');
  return opts;
}

function preflight() {
  for (const executable of [FFMPEG,FFPROBE]) {
    try { execFileSync(executable,['-version'],{stdio:'ignore'}); }
    catch { die(`${executable} not found. Install FFmpeg or set FFMPEG_PATH/FFPROBE_PATH`); }
  }
}

function run(executable,args,{onStdout}={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,args,{stdio:['ignore','pipe','pipe'],shell:false});
    let stdout=''; let stderr='';
    child.stdout.on('data',(chunk)=>{ const text=chunk.toString(); stdout+=text; onStdout?.(text); });
    child.stderr.on('data',(chunk)=>{ if (stderr.length<64*1024*1024) stderr+=chunk.toString(); });
    child.on('error',reject);
    child.on('close',(code)=> code===0
      ? resolve({stdout,stderr})
      : reject(new Error(`${path.basename(executable)} exited ${code}: ${stderr.split('\n').filter(Boolean).slice(-5).join(' | ')}`)));
  });
}

async function probe(file) {
  const {stdout}=await run(FFPROBE,['-v','error','-show_streams','-show_format','-of','json',file]);
  const data=JSON.parse(stdout);
  const video=(data.streams||[]).find((stream)=>stream.codec_type==='video');
  const audio=(data.streams||[]).find((stream)=>stream.codec_type==='audio');
  if (!video) throw new Error(`no video stream in ${file}`);
  if (!audio) throw new Error(`no audio stream in ${file}; voice activity cannot be detected`);
  const duration=Number(data.format?.duration)||Number(video.duration)||Number(audio.duration)||0;
  if (!(duration>0)) throw new Error(`invalid duration for ${file}`);
  return {
    duration,width:Number(video.width),height:Number(video.height),
    fps:String(video.r_frame_rate||video.avg_frame_rate||'24/1'),
    videoCodec:video.codec_name,audioCodec:audio.codec_name,
    sampleRate:Number(audio.sample_rate)||null,channels:Number(audio.channels)||null,
    sizeBytes:Number(data.format?.size)||fs.statSync(file).size
  };
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
  preflight();

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

  const clips=[];
  for (let index=0;index<inputs.length;index++) {
    const input=inputs[index];
    const media=await probe(input);
    log(`${c.cyan('detect  ')} ${index+1}/${inputs.length} ${path.basename(input)}`);
    const vad=await detectVoiceActivity(input,{
      engine:opts.engine,activityThreshold:opts.threshold,
      silero:{frameDuration:90},webrtc:{frameDuration:30,mode:1}
    },{logLevel:'silent'});
    // keep only active-speech segments; current engines emit nothing else, but
    // the boundary math must not depend on that staying true
    const activity=vad.timeline
      .filter(({text})=>text==='active')
      .map(({type,text,startTime,endTime})=>({type,text,startTime,endTime}));
    if (!activity.length) throw new Error(`no voice detected in ${input}`);
    const speechStart=Number(activity[0].startTime);
    const speechEnd=Number(activity.at(-1).endTime);
    if (activity.length===1 && speechStart<=0.05 && speechEnd>=media.duration-0.05) {
      warn(`${path.basename(input)}: detector reports one speech span covering the whole clip; nothing will be trimmed. The ${opts.engine} engine may be too coarse for this material (silero is the precise default).`);
    }
    const trimStart=Math.max(0,speechStart-opts.pad);
    const trimEnd=Math.min(media.duration,speechEnd+opts.pad);
    clips.push({
      index:index+1,input,source:media,voiceActivity:activity,
      speechStart,speechEnd,trimStart,trimEnd,
      leadingRemoved:trimStart,trailingRemoved:media.duration-trimEnd,
      trimmedDuration:trimEnd-trimStart
    });
    log(`${c.green('keep    ')} ${seconds(trimStart)}s → ${seconds(trimEnd)}s (${seconds(trimEnd-trimStart)}s)`);
  }

  const sourceDuration=clips.reduce((sum,clip)=>sum+clip.source.duration,0);
  const plannedDuration=clips.reduce((sum,clip)=>sum+clip.trimmedDuration,0);
  let finalDuration=null;
  if (!opts.dryRun) {
    fs.mkdirSync(path.dirname(output),{recursive:true});
    const partial=path.join(path.dirname(output),`.${outputStem}.${process.pid}.partial.mp4`);
    const width=Math.max(2,clips[0].source.width-(clips[0].source.width%2));
    const height=Math.max(2,clips[0].source.height-(clips[0].source.height%2));
    let fps=clips[0].source.fps;
    const [fpsNum,fpsDen]=String(fps).split('/').map(Number);
    if (!(fpsNum>0) || (fps.includes('/') && !(fpsDen>0))) {
      warn(`unusable frame rate "${fps}" reported by probe, falling back to 24`);
      fps='24';
    }
    // normalize audio to the first clip's channel layout so concat behaves the
    // same on every ffmpeg version instead of relying on auto-negotiation
    const channelLayout=(clips[0].source.channels||2)===1?'mono':'stereo';
    const filters=[];
    for (let index=0;index<clips.length;index++) {
      const clip=clips[index];
      filters.push(
        `[${index}:v:0]trim=start=${clip.trimStart.toFixed(6)}:end=${clip.trimEnd.toFixed(6)},`+
        `setpts=PTS-STARTPTS,fps=${fps},scale=${width}:${height}:force_original_aspect_ratio=decrease,`+
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v${index}]`
      );
      filters.push(
        `[${index}:a:0]atrim=start=${clip.trimStart.toFixed(6)}:end=${clip.trimEnd.toFixed(6)},`+
        `asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=${channelLayout}[a${index}]`
      );
    }
    filters.push(`${clips.map((_,index)=>`[v${index}][a${index}]`).join('')}concat=n=${clips.length}:v=1:a=1[vout][aout]`);
    try {
      await run(FFMPEG,[
        '-y','-hide_banner','-loglevel','error',
        ...inputs.flatMap((input)=>['-i',input]),
        '-filter_complex',filters.join(';'),
        '-map','[vout]','-map','[aout]',
        '-c:v','libx264','-preset',opts.preset,'-crf',String(opts.crf),
        '-c:a','aac','-b:a',opts.audioBitrate,'-movflags','+faststart',
        '-progress','pipe:1',partial
      ],{onStdout:(text)=>{
        const match=text.match(/out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (match && plannedDuration>0) {
          const done=Number(match[1])*3600+Number(match[2])*60+Number(match[3]);
          const percent=Math.min(100,(done/plannedDuration)*100);
          progressLine(`${c.cyan('render  ')} ${percent.toFixed(0).padStart(3)}% of ${seconds(plannedDuration)}s`);
        }
      }});
      endProgress();
      const finalProbe=await probe(partial);
      finalDuration=finalProbe.duration;
      if (Math.abs(finalDuration-plannedDuration)>0.25) {
        warn(`output duration ${seconds(finalDuration)}s differs from plan ${seconds(plannedDuration)}s by ${seconds(Math.abs(finalDuration-plannedDuration))}s`);
      }
      if (fs.existsSync(output)) fs.unlinkSync(output);
      fs.renameSync(partial,output);
    } catch(error) {
      endProgress();
      if (fs.existsSync(partial)) fs.unlinkSync(partial);
      throw error;
    }
  }

  const report={
    tool:TOOL,version:VERSION,createdAt:new Date().toISOString(),
    output:opts.dryRun?null:output,
    settings:{padSeconds:opts.pad,engine:opts.engine,activityThreshold:opts.threshold,crf:opts.crf,preset:opts.preset,audioBitrate:opts.audioBitrate},
    sourceDuration:seconds(sourceDuration),plannedDuration:seconds(plannedDuration),
    finalDuration:finalDuration===null?null:seconds(finalDuration),
    leadingRemoved:seconds(clips.reduce((sum,clip)=>sum+clip.leadingRemoved,0)),
    trailingRemoved:seconds(clips.reduce((sum,clip)=>sum+clip.trailingRemoved,0)),
    totalRemoved:seconds(sourceDuration-plannedDuration),
    clips:clips.map((clip)=>({
      index:clip.index,input:clip.input,source:clip.source,
      speechStart:seconds(clip.speechStart),speechEnd:seconds(clip.speechEnd),
      trimStart:seconds(clip.trimStart),trimEnd:seconds(clip.trimEnd),
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
