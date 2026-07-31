# Video Stream Engine 🎥🚀

A high-performance, distributed video processing and streaming engine built with Node.js. It handles chunked video uploads, transcodes them into Adaptive Bitrate HLS (HTTP Live Streaming) playlists using background workers, and offers real-time progression tracking and AI-powered video search.

## ✨ Core Features

*   **Robust Video Ingestion**: Efficient chunked video file uploading without overwhelming server RAM (using streams and S3/MinIO abstractions).
*   **Distributed Processing**: Decoupled heavy lifting using **BullMQ** and **Redis**. Uploaded videos are placed into a job queue for background transcoding.
*   **Multi-Tier HLS Transcoding**: A background worker powered by **FFmpeg** performs single-pass decoding to generate distinct resolution streams (e.g., 1080p, 720p, 480p, 240p) and segment chunks (`.ts`) simultaneously.
*   **Real-time Progress Sync**: Uses Redis Pub/Sub and Server-Sent Events (SSE) to stream live transcoding percentages back to the client browser in real-time.
*   **AI-Powered Search & Enrichment**: Integrates the **Google Gemini API** to generate audio transcripts and uses **Supabase (pgvector)** to enable fast semantic search across video content.
*   **Custom Rate Limiting & API Gateway**: Secure endpoints for handling uploads, streams, and database queries.

## 🛠️ Tech Stack

### Backend / Core
*   **Node.js & Express.js**: Main API gateway and routing.
*   **MongoDB**: Primary database for metadata storage.
*   **AWS SDK (S3)**: Storage abstraction (works with AWS S3, MinIO, etc.).

### Queue & Background Workers
*   **BullMQ & ioredis**: Highly reliable, Redis-based job queues for managing background processing.
*   **Redis**: Used for job queues, rate limiting, and Pub/Sub event broadcasting.
*   **FFmpeg**: Core media framework used in background workers for transcoding MP4s into HLS formats.

### AI & Vector Database
*   **Google GenAI (`@google/genai`)**: For transcript generation and video enrichment.
*   **Supabase (`@supabase/supabase-js`)**: For storing embeddings and executing semantic/vector searches using PostgreSQL/pgvector.

## 🚀 Getting Started

### Prerequisites
*   Node.js (v18+)
*   Redis server running locally or via Docker
*   MongoDB instance
*   FFmpeg installed on your machine/server
*   Cloud Keys (S3/MinIO, Gemini API, Supabase) configured in `.env`

### Installation

1.  **Clone the repository and install dependencies:**
    ```bash
    npm install
    ```

2.  **Environment Setup:**
    Create a `.env` file in the root directory and ensure all necessary keys are present. Make sure it is added to your `.gitignore`.

3.  **Run the Main API Gateway:**
    ```bash
    npm run dev
    ```

4.  **Run the Transcoding Worker:**
    In a separate terminal, start the background worker process:
    ```bash
    npm run workers
    ```

## 📡 API Endpoints

*   **`POST /api/v1/upload`**: Upload raw video files (intercepted by custom rate limiter).
*   **`GET /api/v1/search`**: Search through processed videos.
*   **`GET /api/v1/stream/:videoId/:file`**: Fetch the master `m3u8` playlist for video playback.
*   **`GET /api/v1/stream/:videoId/:variantDir/:file`**: Fetch individual HLS segment chunks and variant playlists.
*   **`GET /api/v1/stream-progress/:videoId`**: SSE endpoint for real-time transcoding progress.

## 🏗️ Architecture Flow

1.  **Client** uploads a raw `.mp4` file via `/upload`.
2.  **Express Server** streams it directly to S3/MinIO and drops a job into the **BullMQ** queue.
3.  **Worker Process** picks up the job, pulls the video, and runs **FFmpeg** to transcode it into HLS `.ts` chunks and `.m3u8` playlists.
4.  **Worker** publishes progress via **Redis**. The Main server reads this and streams it to the client via SSE.
5.  **AI Engine** optionally intercepts the raw audio to create transcripts via Gemini and indexes it in Supabase for global semantic search.
