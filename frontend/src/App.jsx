import { useState, useEffect, useRef } from 'react';
import Hls from 'hls.js';
import './index.css';

function App() {
  const [selectedFile, setSelectedFile] = useState(null);
  const [videoId, setVideoId] = useState(null);
  const [status, setStatus] = useState('idle'); // idle, uploading, processing, ready, error
  const [progressMsg, setProgressMsg] = useState('');
  const [percent, setPercent] = useState(0);
  const [hlsLevels, setHlsLevels] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [startTime, setStartTime] = useState(null);
  const [totalTime, setTotalTime] = useState(null);
  
  const videoRef = useRef(null);
  const hlsRef = useRef(null);

  const handleFileChange = (e) => {
    if (e.target.files && e.target.files[0]) {
      setSelectedFile(e.target.files[0]);
      setStatus('idle');
      setVideoId(null);
      setProgressMsg('');
      setPercent(0);
      setCompletedResolutions([]);
      setTotalTime(null);
    }
  };

  const handleUpload = async () => {
    if (!selectedFile) return;

    setStatus('uploading');
    setProgressMsg('Uploading video to raw storage...');
    setPercent(0);

    const formData = new FormData();
    formData.append('video', selectedFile);

    try {
      const response = await fetch('http://localhost:8000/api/v1/upload', {
        method: 'POST',
        body: formData,
      });

      const data = await response.json();

      if (response.ok) {
        setVideoId(data.videoId);
        setStatus('processing');
        setProgressMsg('Upload complete. Waiting for transcoder...');
        listenToProgress(data.videoId);
      } else {
        setStatus('error');
        setProgressMsg(data.error || 'Upload failed.');
      }
    } catch (err) {
      setStatus('error');
      setProgressMsg('Network error during upload.');
    }
  };

  const [completedResolutions, setCompletedResolutions] = useState([]);

  const listenToProgress = (vidId) => {
    const eventSource = new EventSource(`http://localhost:8000/api/v1/stream-progress/${vidId}`);
    const startProcessingTime = Date.now();

    // VIDEO_RESOLUTIONS are the 4 transcode jobs. AI is separate and non-blocking.
    const VIDEO_RESOLUTIONS = new Set(['1920x1080', '1280x720', '854x480', '426x240']);

    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      console.log("Live Update:", data);

      if (data.status === 'processing') {
        const etaText = data.eta > 0 ? ` (about ${data.eta}s remaining)` : '';
        setProgressMsg(`Processing ${data.resolution}: ${data.percent}%${etaText}`);
        if (data.percent !== undefined) setPercent(data.percent);
      } else if (data.status === 'completed') {
        setCompletedResolutions((prev) => {
          const updated = [...new Set([...prev, data.resolution])];
          const completedVideoJobs = updated.filter(r => VIDEO_RESOLUTIONS.has(r));

          // Video is playable as soon as all 4 video transcodes are done.
          // Do NOT wait for the AI job — it runs independently.
          if (completedVideoJobs.length === 4) {
            setStatus('ready');
            setPercent(100);
            setTotalTime(((Date.now() - startProcessingTime) / 1000).toFixed(1));
          } else {
            const remaining = 4 - completedVideoJobs.length;
            setProgressMsg(`Finished ${data.resolution}. Waiting for ${remaining} more video track(s)...`);
          }
          return updated;
        });
      } else if (data.status === 'error') {
        // If an AI job fails, show a non-fatal warning but don't break the UI.
        // The video transcodes are independent and likely already done or in progress.
        if (data.resolution === 'audio-only') {
          console.warn('[AI-Worker] Transcript/embedding failed:', data.message);
          // Don't set global error state — AI is a background enhancement, not required for playback.
        } else {
          setStatus('error');
          setProgressMsg(`Error on ${data.resolution}: ${data.message}`);
        }
      }
    };
  };

  useEffect(() => {
    if (status === 'ready' && videoId && videoRef.current) {
      const streamUrl = `http://localhost:8000/api/v1/stream/${videoId}/master.m3u8`;
      
      if (Hls.isSupported()) {
        const hls = new Hls({ enableWorker: true });
        hlsRef.current = hls;
        
        hls.loadSource(streamUrl);
        hls.attachMedia(videoRef.current);

        hls.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
          setHlsLevels(data.levels);
        });

        hls.on(Hls.Events.ERROR, (event, data) => {
          if (data.fatal) {
            console.error("Stream breakdown:", data);
            setStatus('error');
            setProgressMsg("Fatal pipeline choke playing stream.");
          }
        });
      } else if (videoRef.current.canPlayType('application/vnd.apple.mpegurl')) {
        videoRef.current.src = streamUrl;
      }
    }

    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
      }
    };
  }, [status, videoId]);

  const handleQualityChange = (e) => {
    if (hlsRef.current) {
      hlsRef.current.currentLevel = parseInt(e.target.value);
    }
  };

  const handleSearch = async (e) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    setIsSearching(true);
    try {
      const response = await fetch(`http://localhost:8000/api/v1/search?q=${encodeURIComponent(searchQuery)}`);
      const data = await response.json();
      setSearchResults(data.results || []);
    } catch (err) {
      console.error("Search failed:", err);
    } finally {
      setIsSearching(false);
    }
  };

  return (
    <div className="app-container">
      <div className="glass-panel">
        <div className="header">
          <h1>Zero-Disk Stream Engine</h1>
          <div className="subtitle">Enterprise Video Ingestion & AI Semantic Search</div>
        </div>

        <form onSubmit={handleSearch} style={{ display: 'flex', gap: '10px', marginBottom: '20px' }}>
          <input 
            type="text" 
            placeholder="Search videos by meaning or spoken words..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{ flex: 1, padding: '10px', borderRadius: '5px', border: '1px solid var(--surface-color)', background: 'var(--bg-color)', color: 'white' }}
          />
          <button type="submit" className="btn" disabled={isSearching}>
            {isSearching ? 'Searching...' : 'Search'}
          </button>
        </form>

        {searchResults.length > 0 && (
          <div style={{ marginBottom: '20px', padding: '15px', background: 'var(--surface-color)', borderRadius: '10px' }}>
            <h3>Semantic Matches</h3>
            <ul style={{ listStyle: 'none', padding: 0 }}>
              {searchResults.map((result) => (
                <li key={result.id} style={{ marginBottom: '10px', borderBottom: '1px solid #333', paddingBottom: '10px' }}>
                  <strong>{result.title}</strong>
                  <p style={{ margin: '5px 0', fontSize: '0.9em', color: 'var(--text-secondary)' }}>
                    Match: {Math.round(result.similarity * 100)}%
                  </p>
                  <p style={{ fontSize: '0.85em', color: '#888' }}>
                    {result.transcript.substring(0, 150)}...
                  </p>
                  <button 
                    className="btn" 
                    style={{ padding: '5px 10px', fontSize: '0.8em' }}
                    onClick={() => {
                        setVideoId(result.videoId);
                        setStatus('ready');
                    }}
                  >
                    Play Video
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {status !== 'ready' && (
          <div className="upload-section">
            <div className="file-drop-area">
              <div className="file-input-wrapper">
                <button className="btn">
                  <svg width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>
                  Browse Video
                </button>
                <input type="file" accept="video/mp4,video/x-m4v,video/*" onChange={handleFileChange} />
              </div>
              {selectedFile ? (
                <div className="file-name">{selectedFile.name}</div>
              ) : (
                <div style={{ marginTop: '1rem', color: 'var(--text-secondary)' }}>Drag and drop your MP4 file here</div>
              )}
            </div>

            <button 
              className="btn" 
              onClick={handleUpload} 
              disabled={!selectedFile || status === 'uploading' || status === 'processing'}
              style={{ background: 'linear-gradient(to right, #10b981, #059669)' }}
            >
              {status === 'uploading' ? 'Ingesting to Cloud...' : 'Upload Video'}
            </button>
          </div>
        )}

        {(status === 'uploading' || status === 'processing' || status === 'error') && (
          <div className="progress-container">
            <div className="status-text" style={{ justifyContent: 'space-between' }}>
              <span>{progressMsg}</span>
            </div>
            
            {status === 'processing' && (
              <div style={{ width: '100%', height: '6px', background: 'var(--surface-color)', borderRadius: '3px', overflow: 'hidden', marginTop: '1rem' }}>
                <div style={{ height: '100%', width: `${percent}%`, background: 'var(--primary-color)', transition: 'width 0.5s ease-in-out' }}></div>
              </div>
            )}
          </div>
        )}

        {status === 'ready' && (
          <div className="video-player-section">
            {totalTime && (
              <div style={{ marginBottom: '15px', padding: '10px', background: 'rgba(16, 185, 129, 0.2)', border: '1px solid #10b981', color: '#10b981', borderRadius: '5px', textAlign: 'center', fontWeight: 'bold' }}>
                ✅ Total Processing Time: {totalTime} seconds
              </div>
            )}
            <video ref={videoRef} controls autoPlay muted></video>
            
            <div className="controls">
              <div style={{ color: 'var(--text-secondary)' }}>Live Stream Active for {videoId}</div>
              <div>
                <label style={{ marginRight: '10px' }}>⚙️ Quality:</label>
                <select onChange={handleQualityChange}>
                  <option value="-1">Auto (Adaptive)</option>
                  {hlsLevels.map((level, index) => (
                    <option key={index} value={index}>
                      {level.height}p ({Math.round(level.bitrate / 1000)} kbps)
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
