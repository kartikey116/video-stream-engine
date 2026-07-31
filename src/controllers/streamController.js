// import { GetObjectCommand } from '@aws-sdk/client-s3';
// import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
// import s3Client from '../config/s3Client.js';

// export async function streamVideoController(req, res) {
//     const { videoId, variantDir, file } = req.params;
    
//     const hlsFileTarget = variantDir ? `${variantDir}/${file}` : file;
//     const s3Key = `${videoId}/${hlsFileTarget}`;
//     const bucketName = 'processed-videos';

//     try {
//         const s3Response = await s3Client.send(new GetObjectCommand({
//             Bucket: bucketName,
//             Key: s3Key
//         }));

//         // generate secure presigned URL for S3 object
//         const signedUrl = await getSignedUrl(s3Client, command, {expiresIn: 60});


//         // Agar client connection pehle hi drop ho chuka hai, toh gracefully exit karo
//         if (res.headersSent) return;

//         let contentType = 'application/x-mpegURL';
//         if (file.endsWith('.ts')) {
//             contentType = 'video/MP2T';
//         }

//         res.setHeader('Content-Type', contentType);
//         res.setHeader('Cache-Control', 'public, max-age=86400');

//         // Capture internal piping stream errors directly on the network payload pipe
//         s3Response.Body.on('error', (streamErr) => {
//             console.error(`[Stream-Pipe-Error] Operational failure during client transmission:`, streamErr);
//             if (!res.headersSent) {
//                 res.status(500).end();
//             }
//         });

//         // Direct network pipe
//         s3Response.Body.pipe(res);

//     } catch (err) {
//         // CRITICAL CHECK: Agar stream pipeline headers pehle hi send kar chuki hai, 
//         // toh res.json ya res.status call karke server crash mat karo!
//         if (res.headersSent) {
//             console.error(`[Stream-Gateway-Bypass] Error caught after headers sent:`, err.message);
//             return;
//         }

//         if (err.name === 'NoSuchKey') {
//             console.error(`[Stream-Gateway] Missing piece inside cluster: ${s3Key}`);
//             return res.status(404).json({ error: "Stream payload fragment not found." });
//         }
        
//         console.error(`[Stream-Gateway-Crash] Critical pipeline breakdown:`, err);
//         return res.status(500).json({ error: "Transmission gateway down." });
//     }
// }

import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import s3Client from '../config/s3Client.js';

async function streamToString(stream) {
    const chunks = [];
    return new Promise((resolve, reject) => {
        stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        stream.on('error', (err) => reject(err));
        stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
}

export async function streamVideoController(req, res) {
    const { videoId, variantDir, file } = req.params;
    
    const hlsFileTarget = variantDir ? `${variantDir}/${file}` : file;
    const s3Key = `${videoId}/${hlsFileTarget}`;
    const bucketName = 'processed-videos';

    try {
        //  CASE 1: Client demands a raw `.ts` segment fragment chunk
        // Action: Instantly sign it and redirect browser to pull direct from MinIO
        if (file.endsWith('.ts')) {
            const command = new GetObjectCommand({ Bucket: bucketName, Key: s3Key });
            const signedUrl = await getSignedUrl(s3Client, command, { expiresIn: 300 }); // 5 Mins validity
            return res.redirect(signedUrl);
        }
        // CASE 2: Client demands manifest structure (`master.m3u8` or `manifest.m3u8`)
        // Action: Rewrite relative paths to hit Express App Gateway explicitly!
        if (file.endsWith('.m3u8')) {
            const s3Response = await s3Client.send(new GetObjectCommand({
                Bucket: bucketName,
                Key: s3Key
            }));

            const rawManifestText = await streamToString(s3Response.Body);
            const textLines = rawManifestText.split(/\r?\n/);
            const modifiedLines = [];

            // Base entry points validation
            const hostGateway = `${req.protocol}://${req.headers.host}/api/v1/stream/${videoId}`;

            for (let line of textLines) {
                const trimmedLine = line.trim();
                
                if (trimmedLine && !trimmedLine.startsWith('#')) {
                    if (!variantDir) {
                        // We are inside master.m3u8 -> rewrite lines to point to variant manifest gateway route
                        // e.g., v0/manifest.m3u8 becomes http://localhost:8000/api/v1/stream/vid_xxx/v0/manifest.m3u8
                        modifiedLines.push(`${hostGateway}/${trimmedLine}`);
                    } else {
                        // We are inside sub-variant vX/manifest.m3u8 -> rewrite segment files to force Express intercept
                        // e.g., file_000.ts becomes http://localhost:8000/api/v1/stream/vid_xxx/v0/file_000.ts
                        modifiedLines.push(`${hostGateway}/${variantDir}/${trimmedLine}`);
                    }
                } else {
                    modifiedLines.push(line);
                }
            }

            res.setHeader('Content-Type', 'application/x-mpegURL');
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
            return res.send(modifiedLines.join('\n'));
        }

    } catch (err) {
        console.error(`[Streaming-Gateway-Crash] Critical matrix failure:`, err);
        return res.status(500).json({ error: "Streaming node down." });
    }
}