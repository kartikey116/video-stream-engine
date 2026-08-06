1. Abhi Ka Implementation: "302 then Sign" (The Flow)  Dynamic Gateway Tokenizer via HTTP 302 Bouncing
Jo current code aapke laptop par chal raha hai (jo humne last patch kiya), uska architectural workflow aisa dikhta hai:

Step-by-Step Flow:
The Request: Player video chalate-chalate dynamic resolution folder ke andar kisi segment ki demand karta hai (e.g., GET /api/v1/stream/vid_123/v0/file_000.ts).

The Express Interception (The 302): Yeh request seedhe aapke Express Gateway (:8000) par aati hai. Express khud video byte-stream load nahi karta. Woh instantly MinIO ke credentials se ek offline cryptographic mathematical calculation run karta hai aur us specific chunk ke liye ek explicit temporary signature dynamic string prepare karta hai.

The Bounce: Express browser ko video data bejne ke bajaye ek header response stamp dekar wapas bounce kar deta hai:

Status Code: 302 Found (Redirect)

Location: http://127.0.0.1:9000/processed-videos/vid_123/v0/file_000.ts?X-Amz-Signature=xyz...

The Direct 200 Pull: Browser jaise hi 302 dekhta hai, woh bina user ko bataye fractions of millisecond mein direct MinIO Storage Node (:9000) ke us secure target signature link par hit marta hai. MinIO signature crypto verify karta hai aur raw 188-byte discrete TS video packets stream kar deta hai (Status 200 OK).

⚡ 2. Pre-Signed Manifest Vectors (Direct 200 OK) Kya Hai?
Yeh hai pure YouTube aur Netflix standard, jisme browser player ko pure timeline mein ek baar bhi 302 Redirect ka samna nahi karna padta.

Iska Ideal Mechanism:
Jab user video play karta hai, toh browser sabse pehle master content layout files (.m3u8 ya .mpd) ki request karta hai.

Backend architecture kya karta hai? Woh use plain list bejne ke bajaye, use text-parse kaze, us file ke andar jitne bhi hazaaron video chunks (file_000.ts, file_001.ts, up to file_999.ts) aane wale hain, un saare chunks ke direct production storage secure paths with signature tokens pehle se hi manifest text ke andar embed (likh) deta hai!

The Performance Blast: Browser jab us playlist file ko download karta hai, toh uske paas video ke end-to-end saare parts ke ready-made secure VIP entry passes hote hain. Browser bina kisi central API gateway (Express) ko bar-bar hit kiye ya 302 ka delay sahi hue, seedhe CDN/Storage se direct high-speed chunk pipelines fetch karta hai standard single link response 200 OK ke sath.

❌ 3. Hum Abhi HLS (.ts) Ke Sath Yeh Kyun Nahi Kar Pa Rhe Hain?
Aapne dekha ki jab humne manifest ke andar absolute pre-signed URLs inject kiye, toh browser ne file_000.ts par wapas bina signature ke relative hit maari aur 403 Forbidden aa gaya. Iski teen badi core network engineering reasons hain:

A. The HLS.js Relative URL Fallback Rule:
HLS.js player framework jab koi sub-playlist (v0/manifest.m3u8) read karta hai, agar uske andar use absolute URL string formats (http://127.0.0.1:9000/...) milte hain, toh uska built-in adaptive bit-rate management core bohot baar un security query strings (?X-Amz-Algorithm=...) ko strip (delete) kar deta hai. Kyun? Kyunki HLS specifications standard ke mutabik chunk strings plain filename honi chahiye (file_000.ts), taaki base network path validation parameters secure rahein.

B. MinIO Query Parameter Over-Strictness:
MinIO/S3 ke pre-signed URLs bohot strict hote hain. Unhe exact protocol domain block chahiye hota hai. Jab HLS player internal state switches (1080p -> 720p) ke dauran relative routing compute karta hai, toh domain handshakes fail ho jate hain aur token variables drop ho jate hain.

C. The Real Matrix Separation:
YouTube/Netflix jab pre-signed manifests ke threw zero-redirect single 200 OK chala pate hain, toh woh HLS (.ts) container specifications use hi nahi karte. Woh use karte hain MPEG-DASH (.m4s) ya CMAF (fMP4) jahan initialization block (init.mp4) browser ke internal MSE engine buffer memory mein pehle hi global credentials maps load kara deta hai.





1. Presigned URL Manifest Vector (YouTube/Netflix Way)
Aapne bilkul sahi samjha: is tarike mein browser baar-baar Express server ke paas request lekar nahi jata.

Kaise hota hai? Jab browser video shuru karte waqt master.m3u8 ya manifest.m3u8 text file download karta hai, toh Express server us file ke andar pehle se hi saare chunks (file_000.ts, file_001.ts) ke aage unka poora signed token network string generate karke likh deta hai.

Browser ke paas ek hi baar mein poori VIP entry list aa jaati hai, aur woh seedhe storage CDN se direct block pull karta hai without any intermediate server latency.


2.Sabse Bada Sawaal: "Isme har ek file ke liye sign mil raha hai, par KAISE?"
Aapne screenshot mein dekha ki har single chunk (file_015.ts, file_016.ts, file_022.ts) jab jab screen par play hone wala hota hai, network tab mein uske aage ek naya long encrypted token string chipak jata hai.

"Yeh jadugar ki tarah piche background mein ho kaise raha hai jabki humne loop nahi chalaya?"

Chaliye iska step-by-step real-time computer science mechanism dekhiye:

A. The Master Plan (Manifest Path Manipulation):
Jab browser ne sabse pehle aapka sub-manifest (manifest.m3u8) manga, toh hamare Express server controller ne use ek chaal chal kar file di. Server ne text file ke andar direct physical absolute entries rewrite karke aisi bana di:

Plaintext
#EXTINF:4.000,
http://localhost:8000/api/v1/stream/vid_123/v0/file_000.ts
#EXTINF:4.000,
http://localhost:8000/api/v1/stream/vid_123/v0/file_001.ts
#EXTINF:4.000,
http://localhost:8000/api/v1/stream/vid_123/v0/file_022.ts
Notice Karo: Yeh links MinIO ke nahi hain! Yeh saare links wapas aapke Express Server (:8000) ko point kar rahe hain bina kisi signature ke.

B. The Runtime Request Trigger:
Video chal rahi hai. Browser player 88th second par pahunchta hai use pata chalta hai ki mujhe file_022.ts chahiye. Woh manifest check karta hai. Manifest mein likha hai: http://localhost:8000/.../file_022.ts.

Browser chupchaap aapke Express Gateway par ek fresh request bhejta hai:
GET http://localhost:8000/api/v1/stream/vid_123/v0/file_022.ts

C. The On-The-Fly Cryptographic Engine:
Jaise hi yeh request Express ke pass aati hai, aapka Express router use pakadta hai aur streamVideoController(req, res) function trigger hota hai:

req.params Capture: Node.js engine request URL se variables nikalta hai: videoId = "vid_123", variantDir = "v0", file = "file_022.ts".

The S3 Offline Signer: Express ke andhar jo humne AWS-SDK ka code likha hai, woh instant execute hota hai:

JavaScript
const command = new GetObjectCommand({ Bucket: 'processed-videos', Key: 'vid_123/v0/file_022.ts' });
const signedUrl = await getSignedUrl(s3Client, command, { expiresIn: 300 });
Aapka server bina MinIO par network call kiye, CPU memory ke andhar apni Access/Secret Keys aur cryptography algorithms ka use karke instant kuch microseconds mein sirf us single file_022.ts ke liye ek high-security unique cryptographic signature hash compute kar deta hai.

The 302 Response Bounce: Express browser ko response header bhejta hai:

Status: 302 Found

Location: [http://127.0.0.1:9000/processed-videos/.../file_022.ts?X-Amz-Signature=4c1ef](http://127.0.0.1:9000/processed-videos/.../file_022.ts?X-Amz-Signature=4c1ef)...

The Direct Storage Download: Browser is redirect code 302 ko dekhta hai, fractions of millisecond mein apna path badalta hai, aur direct MinIO (:9000) se encrypted query string ke sath data download kar leta hai Status 200 OK par!







docker run video-api:latest      # API server starts
docker run video-worker:latest   # Worker starts (FFmpeg included!)
docker run video-frontend:latest # Frontend starts



Start the cluster:

powershell
minikube start
(Kubernetes will wake up and automatically launch your API, Frontend, MinIO, and Redis pods exactly as they were).

Open the tunnel (in a separate window) to access it:

powershell
minikube tunnel


stern -n video-engine .
