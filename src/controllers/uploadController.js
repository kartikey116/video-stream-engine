import multer from 'multer';
import multerS3 from 'multer-s3';
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

// multer-s3 processes the file stream before express.json() can parse body fields.
// multer itself makes text fields available on req.body after the upload is done.

export async function uploadVideoController(req, res) {
    cloudUpload(req, res, async function (err) {
        if (err) {
            // The client went away, or the server was torn down, before the body
            // finished streaming — nodemon restarting on a file change does this.
            // Nothing was persisted and no storage node is at fault, so don't
            // report it as a 500.
            const aborted = err.code === 'ABORT_ERR' || err.name === 'AbortError' ||
                            err.code === 'ECONNRESET' || req.destroyed;
            if (aborted) {
                console.warn("[Ingestion-Engine] Upload aborted before completion (client disconnected or server restarted).");
                if (!res.headersSent) res.status(499).json({ error: "Upload aborted before completion." });
                return;
            }
            console.error("[Ingestion-Engine-Crash] Cloud stream chunk pipe fault:", err);
            if (res.headersSent) return;
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

            // NOTE: master.m3u8 is no longer pre-written here. The ABR ladder is
            // decided by the worker after probing the source (tiers above the
            // source resolution are dropped), so a playlist authored at upload
            // time would advertise variants that never get encoded. The worker
            // writes ${videoId}/master.m3u8 once the real tier list is known.

            // =========================================================================
            // 🚀 STEP 1: Persist Metadata to Supabase Matrix
            // =========================================================================
            const title = (req.body && req.body.title) ? req.body.title.trim() : null;

            const { error: dbError } = await supabase.from('videos').insert({
                videoId: videoId,
                title: title || videoId,
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