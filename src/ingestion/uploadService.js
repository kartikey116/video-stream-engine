import fs from "fs";
import path from "path";
import { fileURLToPath } from 'url';
import { pipeline } from 'stream/promises';
import transcodeToHLS from "./transcodeService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default async function handleChunkedUpload(req, res) {
  const videoId = `vid_${Date.now()}`;
  const uploadDir = path.join(__dirname, "../../storage/raw");

  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  const targetFilePath = path.join(uploadDir, `${videoId}.mp4`);
  const writeStream = fs.createWriteStream(targetFilePath);

  try {
    console.log(`[Inbound] Incoming video stream chunk execution for ID: ${videoId}`);

    await pipeline(req, writeStream);
    console.log(`[Storage] Raw upload successful for ${videoId}. Passing to Transcoder Core...`);

    transcodeToHLS(targetFilePath, videoId)
      .then((playlistPath) => {
        console.log(`[Success] Processing done. Access path: ${playlistPath}`);
      })
      .catch((err) => {
        console.error(`[Failure] Worker engine crashed for video ${videoId}:`, err);
      });

    return res.status(202).json({
        success: true,
        message: 'Video uploaded successfully. Processing started in the background.',
        videoId: videoId,
    });

  } catch (e) {
    console.error("Stream Pipeline Failure:", error);
    if (fs.existsSync(targetFilePath)) fs.unlinkSync(targetFilePath);
    return res
      .status(500)
      .json({ error: "Upload pipeline failed during transfer." });
  }
}
