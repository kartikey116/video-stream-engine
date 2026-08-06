// Benchmark harness — compares encoder configs on the real ladder.
// Lives in bench/ so nodemon (watching src/ only) ignores it.
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

const SRC = 'bench/source1080.mp4';
const DUR = 20; // seconds of 1080p30

function run(cmd, args) {
    return new Promise((resolve) => {
        const p = spawn(cmd, args);
        let err = '';
        p.stdout.on('data', () => {});
        p.stderr.on('data', (d) => { err += d; });
        p.on('error', (e) => resolve({ code: -1, err: e.message }));
        p.on('close', (code) => resolve({ code, err }));
    });
}

const LADDER = [
    { name: 'v0', w: 1920, h: 1080, bitrate: '4500k', maxrate: '4950k', bufsize: '9000k', profile: 'high' },
    { name: 'v1', w: 1280, h: 720,  bitrate: '2500k', maxrate: '2750k', bufsize: '5000k', profile: 'main' },
    { name: 'v2', w: 854,  h: 480,  bitrate: '1000k', maxrate: '1100k', bufsize: '2000k', profile: 'main' },
    { name: 'v3', w: 426,  h: 240,  bitrate: '400k',  maxrate: '440k',  bufsize: '800k',  profile: 'baseline' },
];

function swFilter(ladder) {
    return `[0:v]split=${ladder.length}${ladder.map((_, i) => `[s${i}]`).join('')};` +
        ladder.map((l, i) =>
            `[s${i}]scale=${l.w}:${l.h}:force_original_aspect_ratio=decrease,` +
            `pad=${l.w}:${l.h}:(ow-iw)/2:(oh-ih)/2,setsar=1[v${i}]`
        ).join(';');
}

function hlsOut(wd, l) {
    return ['-f', 'hls', '-hls_time', '4', '-hls_list_size', '0',
        '-hls_segment_filename', `${wd}/${l.name}/file_%03d.ts`, `${wd}/${l.name}/manifest.m3u8`];
}

// ── Config A: exactly what ships today (veryfast + -threads 2) ──────────────
function cfgShipped(src, wd, ladder) {
    return ['-y', '-i', src, '-filter_complex', swFilter(ladder),
        ...ladder.flatMap((l, i) => [
            '-map', `[v${i}]`, '-map', '0:a?',
            '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', l.profile,
            '-b:v', l.bitrate, '-maxrate', l.maxrate, '-bufsize', l.bufsize,
            '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
            '-g', '48', '-keyint_min', '48', '-sc_threshold', '0',
            '-threads', '2', '-max_muxing_queue_size', '4096',
            ...hlsOut(wd, l),
        ])];
}

// ── Config B: raise the thread cap from 2 to 4 per encoder ─────────────────
function cfgNoThreadCap(src, wd, ladder) {
    return ['-y', '-i', src, '-filter_complex', swFilter(ladder),
        ...ladder.flatMap((l, i) => [
            '-map', `[v${i}]`, '-map', '0:a?',
            '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', l.profile,
            '-b:v', l.bitrate, '-maxrate', l.maxrate, '-bufsize', l.bufsize,
            '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
            '-g', '48', '-keyint_min', '48', '-sc_threshold', '0',
            '-threads', '4', '-max_muxing_queue_size', '1024',
            ...hlsOut(wd, l),
        ])];
}

// ── Config C: ultrafast, 4 threads ─────────────────────────────────────────
function cfgUltrafast(src, wd, ladder) {
    return ['-y', '-i', src, '-filter_complex', swFilter(ladder),
        ...ladder.flatMap((l, i) => [
            '-map', `[v${i}]`, '-map', '0:a?',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-profile:v', l.profile,
            '-b:v', l.bitrate, '-maxrate', l.maxrate, '-bufsize', l.bufsize,
            '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
            '-g', '48', '-keyint_min', '48', '-sc_threshold', '0',
            '-threads', '4', '-max_muxing_queue_size', '1024',
            ...hlsOut(wd, l),
        ])];
}

// ── Config D: Intel QSV hardware encode, software scaling ───────────────────
function cfgQsvSwScale(src, wd, ladder) {
    return ['-y', '-i', src, '-filter_complex', swFilter(ladder),
        ...ladder.flatMap((l, i) => [
            '-map', `[v${i}]`, '-map', '0:a?',
            '-c:v', 'h264_qsv', '-preset', 'veryfast', '-profile:v', l.profile,
            '-b:v', l.bitrate, '-maxrate', l.maxrate, '-bufsize', l.bufsize,
            '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
            '-g', '48', '-keyint_min', '48',
            '-max_muxing_queue_size', '1024',
            ...hlsOut(wd, l),
        ])];
}

// ── Config E: full QSV pipeline — hw decode + hw scale + hw encode ──────────
// Frames stay in GPU memory end to end; no CPU<->GPU copies per tier.
function cfgQsvFull(src, wd, ladder) {
    const filter = `[0:v]split=${ladder.length}${ladder.map((_, i) => `[s${i}]`).join('')};` +
        ladder.map((l, i) => `[s${i}]scale_qsv=w=${l.w}:h=${l.h}[v${i}]`).join(';');
    return ['-y',
        '-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv', '-i', src,
        '-filter_complex', filter,
        ...ladder.flatMap((l, i) => [
            '-map', `[v${i}]`, '-map', '0:a?',
            '-c:v', 'h264_qsv', '-preset', 'veryfast', '-profile:v', l.profile,
            '-b:v', l.bitrate, '-maxrate', l.maxrate, '-bufsize', l.bufsize,
            '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
            '-g', '48', '-keyint_min', '48',
            '-max_muxing_queue_size', '1024',
            ...hlsOut(wd, l),
        ])];
}

const CONFIGS = [
    ['A shipped (veryfast, -threads 2)', cfgShipped],
    ['B veryfast, -threads 4',           cfgNoThreadCap],
    ['C ultrafast, -threads 4',          cfgUltrafast],
    ['D QSV encode + sw scale',          cfgQsvSwScale],
    ['E QSV full (hw decode+scale+enc)', cfgQsvFull],
];

// ── Build a source with realistic motion complexity ─────────────────────────
if (!fs.existsSync(SRC)) {
    console.log(`Generating ${DUR}s 1080p30 source...`);
    const gen = await run('ffmpeg', ['-y',
        '-f', 'lavfi', '-i', `testsrc2=size=1920x1080:rate=30:duration=${DUR}`,
        '-f', 'lavfi', '-i', `sine=frequency=440:duration=${DUR}`,
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-threads', '4',
        '-c:a', 'aac', '-shortest', SRC]);
    if (gen.code !== 0) { console.error(gen.err.slice(-800)); process.exit(1); }
}
console.log(`Source: ${(fs.statSync(SRC).size / 1048576).toFixed(1)} MB, ${DUR}s 1080p30\n`);

const results = [];
for (const [label, builder] of CONFIGS) {
    const wd = path.join('bench', label.split(' ')[0]);
    fs.rmSync(wd, { recursive: true, force: true });
    for (const l of LADDER) fs.mkdirSync(path.join(wd, l.name), { recursive: true });

    const args = builder(SRC.replace(/\\/g, '/'), wd.replace(/\\/g, '/'), LADDER);
    const t0 = Date.now();
    const r = await run('ffmpeg', ['-nostats', ...args]);
    const secs = (Date.now() - t0) / 1000;

    if (r.code !== 0) {
        console.log(`${label.padEnd(36)} FAILED (exit ${r.code})`);
        const why = (r.err.match(/^.*(Error|error|Invalid|not supported|failed|Unknown).*$/gm) || []).slice(-3);
        why.forEach(w => console.log(`    ${w.trim().slice(0, 130)}`));
        results.push({ label, secs: null });
        continue;
    }

    // Total output bytes = a proxy for whether we traded quality/size for speed
    let bytes = 0, segs = 0;
    for (const l of LADDER) {
        for (const f of fs.readdirSync(path.join(wd, l.name))) {
            bytes += fs.statSync(path.join(wd, l.name, f)).size;
            if (f.endsWith('.ts')) segs++;
        }
    }
    const speed = DUR / secs;
    results.push({ label, secs, speed, mb: bytes / 1048576, segs, wd });
    console.log(`${label.padEnd(36)} ${secs.toFixed(1)}s  ${speed.toFixed(2)}x realtime  ${(bytes / 1048576).toFixed(1)} MB  ${segs} segs`);
}

// ── Projection to the user's real workload ──────────────────────────────────
const base = results.find(r => r.label.startsWith('A'));
console.log(`\n── Projected encode time for a 9-minute (540s) video ──`);
for (const r of results) {
    if (!r.secs) continue;
    const proj = 540 / r.speed;
    const delta = base?.secs ? ` (${((1 - r.secs / base.secs) * 100).toFixed(0)}% faster than A)` : '';
    console.log(`  ${r.label.padEnd(36)} ~${proj.toFixed(0)}s${r.label.startsWith('A') ? ' ← baseline' : delta}`);
}

// ── GOP alignment must survive whatever we pick ─────────────────────────────
console.log(`\n── GOP alignment check (segment boundaries identical across tiers) ──`);
for (const r of results) {
    if (!r.wd) continue;
    const sets = LADDER.map(l => {
        const m = fs.readFileSync(path.join(r.wd, l.name, 'manifest.m3u8'), 'utf8');
        return (m.match(/#EXTINF:[\d.]+/g) || []).join('|');
    });
    const aligned = new Set(sets).size === 1;
    console.log(`  ${r.label.padEnd(36)} ${aligned ? 'OK aligned' : 'FAIL misaligned — ABR switching would stutter'}`);
}
