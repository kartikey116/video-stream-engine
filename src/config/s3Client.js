import {S3Client} from "@aws-sdk/client-s3";
import dotenv from 'dotenv';
dotenv.config();

const s3Client = new S3Client({
    endpoint: process.env.S3_ENDPOINT || "http://127.0.0.1:9000",
    region: process.env.AWS_REGION || "us-east-1", // MinIO doesn't care about region, but SDK requires it
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
    forcePathStyle: true, // Crucial for MinIO to interpret endpoint routes correctly
});

export default s3Client;