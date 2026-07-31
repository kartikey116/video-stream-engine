import { spawn } from "child_process";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function runSingleTranscodeLayer(args) {
    return new Promise((resolve, reject) => {
        const ffmpegProcess = spawn("ffmpeg", args);

        ffmpegProcess.stderr.on("data", (data) => {
            const logs = data.toString();
            if (logs.includes("frame=")) {
                const frameMatch = logs.match(/frame=\s*(\d+)/);
                if (frameMatch) {
                    process.stdout.write(`.`); // Minimal activity indicators
                }
            }
        });

        ffmpegProcess.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`FFmpeg processing failed with code ${code}`));
        });

        ffmpegProcess.on("error", (err) => reject(err));
    });
}

export default async function transcodeToHLS(inputFilePath, videoId) {
    const outputDir = path.join(__dirname, "../../storage/processed", videoId);
    const cleanInputPath = inputFilePath.replace(/\\/g, "/");
    const cleanOutputDir = outputDir.replace(/\\/g, "/");

    const layers = [
        { name: "v0", resolution: "1920x1080", bitrate: "4500k", profile: "high" },
        { name: "v1", resolution: "1280x720",  bitrate: "2500k", profile: "main" },
        { name: "v2", resolution: "854x480",   bitrate: "1000k", profile: "main" },
        { name: "v3", resolution: "426x240",   bitrate: "400k",  profile: "baseline" }
    ];

    console.log(`[FFmpeg-Engine] Starting Multi-Pass Stable Transcoding for ID: ${videoId}`);

    for (const layer of layers) {
        const layerOutputDir = `${cleanOutputDir}/${layer.name}`;
        if (!fs.existsSync(layerOutputDir)) {
            fs.mkdirSync(layerOutputDir, { recursive: true });
        }

        console.log(`\nProcessing Layer ${layer.name} (${layer.resolution})...`);

        const ffmpegArgs = [
            "-i", cleanInputPath,
            "-threads", "2", // Prevent hardware starvation
            "-c:v", "libx264",
            "-profile:v", layer.profile,
            "-s:v", layer.resolution,
            "-b:v", layer.bitrate,
            "-c:a", "aac",
            "-b:a", "128k",
            "-ac", "2",
            "-g", "48",
            "-keyint_min", "48",
            "-sc_threshold", "0",
            "-f", "hls",
            "-hls_time", "4",
            "-hls_list_size", "0",
            "-hls_segment_filename", `${layerOutputDir}/file_%03d.ts`,
            `${layerOutputDir}/manifest.m3u8`
        ];

        await runSingleTranscodeLayer(ffmpegArgs);
        console.log(`\nLayer ${layer.name} conversion complete!`);
    }

    console.log(`[FFmpeg-Engine] Finalizing master playlist architecture matrix...`);
    const masterPlaylistContent = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=4950000,RESOLUTION=1920x1080
v0/manifest.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2750000,RESOLUTION=1280x720
v1/manifest.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1100000,RESOLUTION=854x480
v2/manifest.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=440000,RESOLUTION=426x240
v3/manifest.m3u8
`;

    const masterPlaylistPath = path.join(outputDir, "master.m3u8");
    fs.writeFileSync(masterPlaylistPath, masterPlaylistContent);
    
    console.log(`[FFmpeg-Success] Structural ABR compilation successfully generated!`);
    return masterPlaylistPath;
}