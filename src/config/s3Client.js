import {S3Client} from "@aws-sdk/client-s3";
import dotenv from 'dotenv';
dotenv.config();

export const S3_INTERNAL_ENDPOINT = process.env.S3_ENDPOINT || "http://127.0.0.1:9000";

const credentials = {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
};
const region = process.env.AWS_REGION || "us-east-1"; // MinIO doesn't care about region, but SDK requires it

// In-cluster client. Talks to minio-svc:9000 over the pod network.
const s3Client = new S3Client({
    endpoint: S3_INTERNAL_ENDPOINT,
    region,
    credentials,
    forcePathStyle: true, // Crucial for MinIO to interpret endpoint routes correctly
});

// ─────────────────────────────────────────────────────────────────────────────
// PRESIGNING CLIENTS
//
// SigV4 signs the Host header. A URL signed against the internal endpoint
// (minio-svc:9000) and then string-replaced to a public host fails with
// SignatureDoesNotMatch the moment the browser sends the rewritten Host.
// The URL has to be signed against the origin the browser will actually use,
// so we keep one client per public origin instead of rewriting after the fact.
// ─────────────────────────────────────────────────────────────────────────────
const presignClients = new Map();

export function getPresignClient(publicOrigin) {
    const origin = process.env.S3_PUBLIC_ENDPOINT || publicOrigin || S3_INTERNAL_ENDPOINT;
    if (origin === S3_INTERNAL_ENDPOINT) return s3Client;

    let client = presignClients.get(origin);
    if (!client) {
        client = new S3Client({ endpoint: origin, region, credentials, forcePathStyle: true });
        presignClients.set(origin, client);
    }
    return client;
}

export default s3Client;
