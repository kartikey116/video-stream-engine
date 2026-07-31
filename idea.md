Phase 1: Ingestion & Core Processing (Weeks 1-2)
Goal: Bina memory leak ke 1GB+ video file chunks mein stream karna aur local FFmpeg script chalana.

Milestone 1.1 (Chunked Upload): Node.js Express server setup kijiye. Standard multer disk storage use mat kijiye. Node.js fs.createWriteStream aur Streams pipeline ka use karke video file ko chunks mein download kijiye taaki RAM consume na ho.

Milestone 1.2 (FFmpeg Mastery): Local machine par FFmpeg CLI tool install kijiye. Node.js child_process.spawn ka use karke command trigger kijiye jo .mp4 file ko adaptive bitrate playlist (.m3u8) aur .ts segment chunks (2-second length) mein break kare.

Phase 2: Decentralization & Background Queues (Week 3)
Goal: Heavy work ko upload API se decouple karna aur storage abstraction lagana.

Milestone 2.1 (MinIO Setup): Docker install kijiye aur docker run se MinIO aur Redis locally start kijiye. Node.js mein AWS-SDK configure kijiye jo local MinIO endpoint se connect ho.

Milestone 2.2 (The Event Queue): BullMQ integrate kijiye. Upload API jaise hi raw video file catch karegi, use MinIO ke raw-uploads bucket mein fenk degi aur Redis queue mein ek job publish karega: { jobId: 'v1', filename: 'lecture.mp4' }.

Milestone 2.3 (The Decoupled Worker): Ek alag background process code kijiye jo is queue se job uthaye, MinIO se stream padhe, transcode kare, aur final HLS outputs ko processed-streams bucket mein push kar de.

Phase 3: The Polyglot Split & Real-time WebSockets (Week 4)
Goal: Core logic ko microservices mein todna aur Transcoder ko Go mein convert karna.

Milestone 3.1 (The Go Transcoder): Apni worker service ko Node.js se shift karke Go mein likhiye. Go-worker Redis queue se job read karega aur native internal buffers control karega.

Milestone 3.2 (WebSocket Feedback Loop): Go-worker jab transcode karega, toh har chunk processing par Redis PUBLISH command bhejega. Aapka Node.js backend (Socket.io) is event ko SUBSCRIBE karke client browser tak live percentage status bhejega ("Processing: 42% completed").

Milestone 3.3 (HLS Playback UI): Ek minimal React layer banaiye jismein hls.js video player ho. MinIO se signed playlist link fetch karke video streaming test kijiye.

Phase 4: Containerization & Cloud Ingress (Week 5)
Goal: Local setup ko completely production-ready package mein badalna.

Milestone 4.1 (Optimized Dockerfile): Node.js aur Go-worker dono ke liye Multi-stage Dockerfiles likhiye. Make sure Go image ka size minimum ho (using alpine or scratch) aur uske andar FFmpeg static binaries baked hon.

Milestone 4.2 (Minikube Setup): Minikube start kijiye. Apne components ke liye Kubernetes manifests (deployment.yaml, service.yaml, configmap.yaml) likhiye.

Milestone 4.3 (Nginx Reverse Proxy): K8s cluster ke aage ek Nginx configuration deploy kijiye jo traffic route kare: /api/v1/upload -> Upload Service, /stream/* -> MinIO storage.

Phase 5: Production Scalability & AI Layer (Week 6)
Goal: Platform ko unbreakable banana aur GenAI capabilities integrate karna.

Milestone 5.1 (KEDA Autoscaling): Minikube mein KEDA (Kubernetes Event-driven Autoscaling) deploy kijiye. Ek ScaledObject banaiye jo Redis/BullMQ queue ka active count dekhkar Go-transcoder worker pods ko 0 se 10 tak automatic scale up ya scale down kare.

Milestone 5.2 (Gemini API Pipes): Transcoding pipeline ke beech mein Gemini API call lagaiye. Jab video raw format mein ho, uske audio track ka sample lekar text transcript banayein aur PgVector/PostgreSQL mein search ke liye index kijiye.

Milestone 5.3 (Chaos Engineering / Fault Tolerance Test): Ek 2GB ki heavy video processing par lagaiye aur beech mein hi chalte hue worker pod ka Docker container forcefully kill (docker rm -f) kar dijiye. Dekhiye ki kya aapka Redis queue system job ko gracefully drop hone se bachakar dusre pod par automatic retry karwata hai ya nahi.