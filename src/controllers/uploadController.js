import multer from 'multer';
import multerS3 from 'multer-s3';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import s3Client from '../config/s3Client.js';
import { dispatchTranscodeJobs } from '../queues/transcodeQueue.js';
import { supabase } from '../config/dbConfig.js';

/**
 * Production Zero-Disk Ingestion Configuration
 * Directly streams the multipart video payload from client request network wire
 * straight into the cloud storage bucket without writing a single byte to local disk.
 */
const cloudUpload = multer({
    storage: multerS3({
        s3: s3Client,
        bucket: 'raw-videos', // Raw unprocessed files land here exclusively
        metadata: function (req, file, cb) {
            cb(null, { fieldName: file.fieldname });
        },
        key: function (req, file, cb) {
            const videoId = `vid_${Date.now()}`;
            req.generatedVideoId = videoId; // Store the unique system ID inside request state context
            cb(null, `${videoId}/source_input.mp4`);
        }
    })
}).single('video'); // Key target parameter parsing name

export async function uploadVideoController(req, res) {
    cloudUpload(req, res, async function (err) {
        if (err) {
            console.error("[Ingestion-Engine-Crash] Cloud stream chunk pipe fault:", err);
            return res.status(500).json({ error: "Storage node proxy choke: " + err.message });
        }

        try {
            // Validation: Ensure the file was actually uploaded and caught by Multer
            if (!req.file) {
                return res.status(400).json({ 
                    error: "Upload failed: No file found. Make sure you are using 'form-data' and the key is exactly 'video'." 
                });
            }

            // multer-s3 attaches the uploaded file details to req.file
            // We can safely extract the videoId from the key we generated
            const rawCloudInputKey = req.file.key; 
            const videoId = rawCloudInputKey.split('/')[0];

            console.log(`\n📦 [Ingestion-Engine] Master Ingress locked. Video streaming direct to raw bucket: ${rawCloudInputKey}`);

            // =========================================================================
            // 🚀 STEP 1: Pre-creation of structural master metadata playlist array
            // Synchronously logs tracking layouts inside the final processed-videos bucket
            // =========================================================================
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

            await s3Client.send(new PutObjectCommand({
                Bucket: 'processed-videos',
                Key: `${videoId}/master.m3u8`,
                Body: masterPlaylistContent,
                ContentType: 'application/x-mpegURL'
            }));

            // =========================================================================
            // 🚀 STEP 1.5: Persist Metadata to Supabase Matrix
            // =========================================================================
            const { error: dbError } = await supabase.from('videos').insert({
                videoId: videoId,
                cloudInputSource: `raw-videos/${rawCloudInputKey}`,
                status: 'queued'
            });

            if (dbError) {
                console.error("❌ [Database-Engine-Crash] Supabase Insert Error:", dbError);
            } else {
                console.log(`🗄️ [Database-Engine] Supabase Document registered for ${videoId}`);
            }

            // =========================================================================
            // 🚀 STEP 2: Dispatch tasks to Redis. Notice that input location parameter
            // is now the explicit target key inside 'raw-videos' bucket.
            // =========================================================================
            await dispatchTranscodeJobs(rawCloudInputKey, videoId);

            return res.status(202).json({
                message: "Zero-disk ingestion layer verification successful. Distributed execution grid spawned.",
                videoId: videoId,
                cloudInputSource: `raw-videos/${rawCloudInputKey}`,
                status: "Queued"
            });

        } catch (processErr) {
            return res.status(500).json({ error: "System coordination matrix failure: " + processErr.message });
        }
    });
}