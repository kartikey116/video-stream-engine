import { useState, useEffect, useRef, useCallback } from 'react';
import Hls from 'hls.js';
import './index.css';

// ─── Helpers ───────────────────────────────────────────────────────────────
function fmtTime(sec) {
  if (!sec && sec !== 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Smart duration: seconds → "42s", "3m 12s", "1h 5m"
function fmtDuration(totalSeconds) {
  const s = Math.round(Number(totalSeconds));
  if (s < 60)  return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60)  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM > 0 ? `${h}h ${remM}m` : `${h}h`;
}

const SPEED_OPTIONS = [0.5, 1, 1.25, 1.5, 1.75, 2, 2.5];

// ─── Main Component ────────────────────────────────────────────────────────
export default function App() {
  // Upload state
  const [selectedFile, setSelectedFile] = useState(null);
  const [videoTitle, setVideoTitle]     = useState('');
  const [dragOver, setDragOver]         = useState(false);

  // Processing state
  const [videoId, setVideoId]           = useState(null);
  const [status, setStatus]             = useState('idle'); // idle | uploading | processing | ready | error
  const [progressMsg, setProgressMsg]   = useState('');
  const [percent, setPercent]           = useState(0);
  const [totalTime, setTotalTime]       = useState(null);
  const [completedRes, setCompletedRes] = useState([]);

  // Player state
  const [hlsLevels, setHlsLevels]       = useState([]);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [currentTime, setCurrentTime]   = useState(0);

  // Transcript state
  const [segments, setSegments]         = useState([]);
  const [transcriptStatus, setTranscriptStatus] = useState('pending'); // pending | loading | ready
  const [activeSegIdx, setActiveSegIdx] = useState(-1);
  const segRefs = useRef({});
  const transcriptBodyRef = useRef(null);

  // Search state
  const [searchQuery, setSearchQuery]   = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [isSearching, setIsSearching]   = useState(false);
  const [activeResult, setActiveResult] = useState(null);
  const [pendingSeekQuery, setPendingSeekQuery] = useState('');

  const videoRef = useRef(null);
  const hlsRef   = useRef(null);

  // ─── Upload handlers ───────────────────────────────────────────────────
  const resetUpload = () => {
    setSelectedFile(null);
    setVideoTitle('');
    setVideoId(null);
    setStatus('idle');
    setProgressMsg('');
    setPercent(0);
    setCompletedRes([]);
    setTotalTime(null);
    setSegments([]);
    setTranscriptStatus('pending');
    setActiveSegIdx(-1);
    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
  };

  const handleFileDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer?.files?.[0] || e.target.files?.[0];
    if (f) { setSelectedFile(f); setStatus('idle'); }
  };

  const handleUpload = async () => {
    if (!selectedFile) return;
    setStatus('uploading');
    setProgressMsg('Uploading video to cloud storage…');
    setPercent(5);

    const formData = new FormData();
    formData.append('video', selectedFile);
    formData.append('title', videoTitle.trim() || selectedFile.name.replace(/\.[^/.]+$/, ''));

    try {
      const res  = await fetch('/api/v1/upload', { method: 'POST', body: formData });
      const data = await res.json();
      if (res.ok) {
        setVideoId(data.videoId);
        setStatus('processing');
        setProgressMsg('Upload complete. Transcoding in progress…');
        listenToProgress(data.videoId);
      } else {
        setStatus('error');
        setProgressMsg(data.error || 'Upload failed.');
      }
    } catch {
      setStatus('error');
      setProgressMsg('Network error during upload.');
    }
  };

  // ─── Transcript fetch (reusable) ────────────────────────────────────────
  const fetchTranscript = useCallback((vidId) => {
    setTranscriptStatus('loading');
    fetch(`/api/v1/transcript/${vidId}`)
      .then(r => r.json())
      .then(d => {
        if (Array.isArray(d.segments) && d.segments.length > 0) {
          setSegments(d.segments);
          setTranscriptStatus('ready');
        } else {
          setTranscriptStatus('pending'); // still generating — poll will retry
        }
      })
      .catch(() => setTranscriptStatus('pending'));
  }, []);

  // ─── SSE Progress ──────────────────────────────────────────────────────
  const listenToProgress = (vidId) => {
    const es = new EventSource(`/api/v1/stream-progress/${vidId}`);
    const t0 = Date.now();
    let expectedTracks = 4;

    es.onmessage = (event) => {
      const d = JSON.parse(event.data);
      if (d.status === 'processing') {
        const eta = d.eta > 0 ? ` (~${fmtDuration(d.eta)} left)` : '';
        setProgressMsg(`Transcoding: ${d.percent}%${eta}`);
        if (d.percent !== undefined) setPercent(d.percent);
      } else if (d.status === 'completed') {
        if (d.total) expectedTracks = d.total;
        // AI job finished → fetch transcript immediately instead of discarding the event
        if (d.resolution === 'audio-only') { fetchTranscript(vidId); return; }
        setCompletedRes((prev) => {
          const next = [...new Set([...prev, d.resolution])];
          if (next.length >= expectedTracks) {
            setStatus('ready');
            setPercent(100);
            setTotalTime(((Date.now() - t0) / 1000).toFixed(1));
            es.close();
          } else {
            setProgressMsg(`Done: ${d.resolution} (${next.length}/${expectedTracks})`);
          }
          return next;
        });
      } else if (d.status === 'error' && d.resolution !== 'audio-only') {
        setStatus('error');
        setProgressMsg(`Error: ${d.message}`);
        es.close();
      }
    };
    es.onerror = () => console.warn('[SSE] Connection dropped.');
    return es;
  };

  // ─── HLS Player ───────────────────────────────────────────────────────
  useEffect(() => {
    if (status !== 'ready' || !videoId || !videoRef.current) return;
    const streamUrl = `/api/v1/stream/${videoId}/master.m3u8`;

    if (Hls.isSupported()) {
      const hls = new Hls({ enableWorker: true });
      hlsRef.current = hls;
      hls.loadSource(streamUrl);
      hls.attachMedia(videoRef.current);
      hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => setHlsLevels(data.levels));
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) { setStatus('error'); setProgressMsg('Fatal stream error.'); }
      });
    } else if (videoRef.current.canPlayType('application/vnd.apple.mpegurl')) {
      videoRef.current.src = streamUrl;
    }

    return () => { if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; } };
  }, [status, videoId]);

  // Sync playback speed
  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = playbackSpeed;
  }, [playbackSpeed]);

  // Track current time for transcript sync
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onTime = () => setCurrentTime(video.currentTime);
    video.addEventListener('timeupdate', onTime);
    return () => video.removeEventListener('timeupdate', onTime);
  }, [status]);

  // Update active transcript segment
  useEffect(() => {
    if (!segments.length) return;
    let idx = 0;
    for (let i = 0; i < segments.length; i++) {
      if (segments[i].t <= currentTime) idx = i;
      else break;
    }
    if (idx !== activeSegIdx) {
      setActiveSegIdx(idx);
      // Auto-scroll the active segment into view
      const el = segRefs.current[idx];
      if (el && transcriptBodyRef.current) {
        const body = transcriptBodyRef.current;
        const top  = el.offsetTop - body.offsetTop;
        body.scrollTo({ top: top - 80, behavior: 'smooth' });
      }
    }
  }, [currentTime, segments]);

  // Load transcript when player is ready.
  // Polls every 6s until segments arrive because the AI job finishes AFTER
  // the video tracks complete (they run independently). The audio-only SSE
  // event also triggers fetchTranscript directly, so the poll usually
  // fires at most once before the SSE path resolves it.
  useEffect(() => {
    if (status !== 'ready' || !videoId) return;
    if (transcriptStatus === 'ready') return;

    // Initial attempt (covers search-result playback with no live SSE)
    fetchTranscript(videoId);

    let attempts = 0;
    const poll = setInterval(() => {
      attempts++;
      fetch(`/api/v1/transcript/${videoId}`)
        .then(r => r.json())
        .then(d => {
          if (Array.isArray(d.segments) && d.segments.length > 0) {
            setSegments(d.segments);
            setTranscriptStatus('ready');
            clearInterval(poll);
          } else if (attempts >= 75) {
            // Bug fix: 75 attempts × 6s = 7.5 minutes. The AI queue retries on
            // Gemini quota errors with 60s/120s/240s backoff, so a rate-limited
            // transcript can land 7 minutes later. The old 60s cutoff dropped
            // pendingSeekQuery before the transcript arrived.
            setTranscriptStatus('error');
            clearInterval(poll);
          }
        })
        .catch(() => {
          if (attempts >= 75) {
            setTranscriptStatus('error');
            clearInterval(poll);
          }
        });
    }, 6000);

    return () => clearInterval(poll);
  // fetchTranscript is stable (useCallback); transcriptStatus intentionally
  // excluded so the poll doesn't restart whenever loading→pending toggles.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, videoId]);

  // ─── Quality & Speed ───────────────────────────────────────────────────
  const handleQuality = (e) => {
    if (hlsRef.current) hlsRef.current.currentLevel = parseInt(e.target.value);
  };

  // ─── Seek to timestamp ─────────────────────────────────────────────────
  const seekTo = useCallback((sec) => {
    const video = videoRef.current;
    if (!video) return;

    const doSeek = () => {
      video.currentTime = sec;
      video.play().catch(() => {});
    };

    // If metadata is already loaded (readyState >= 1), we can seek immediately.
    // Otherwise, wait for it to load (crucial for HLS streams).
    if (video.readyState >= 1) {
      doSeek();
    } else {
      video.addEventListener('loadedmetadata', doSeek, { once: true });
    }
  }, []);

  // Auto-seek to keyword match after search
  useEffect(() => {
    if (pendingSeekQuery && segments.length > 0 && videoRef.current) {
      const qExact = pendingSeekQuery.toLowerCase();
      const qTokens = qExact.split(/\s+/).filter(Boolean);
      const qChars = qExact.replace(/[^a-z0-9]/g, '');

      let bestMatch = null;
      let maxScore = 0;

      for (const seg of segments) {
        let score = 0;
        const sLower = seg.s.toLowerCase();
        
        // 1. Exact phrase match (Highest Priority)
        if (sLower.includes(qExact)) score += 100;

        // 2. Token match (Catches partial phrase matches)
        for (const token of qTokens) {
          if (token.length > 2 && sLower.includes(token)) score += 10;
        }

        // 3. Subsequence match (Catches transliteration typos like 'sona' -> 'sohna' or 'raja' -> 'raanjha')
        if (qChars.length > 3) {
          const sChars = sLower.replace(/[^a-z0-9]/g, '');
          let qIdx = 0;
          for (let i = 0; i < sChars.length && qIdx < qChars.length; i++) {
            if (sChars[i] === qChars[qIdx]) qIdx++;
          }
          if (qIdx === qChars.length) score += 5;
        }

        if (score > maxScore) {
          maxScore = score;
          bestMatch = seg;
        }
      }
      
      if (bestMatch && maxScore > 0) {
        seekTo(bestMatch.t);
      }
      setPendingSeekQuery('');
    }
  }, [segments, pendingSeekQuery, seekTo]);

  // ─── Play from search result ───────────────────────────────────────────
  const playResult = async (result) => {
    // Bug fix: if clicking the same video that's already playing, just re-seek
    // instead of destroying the HLS instance (which would leave a black player
    // since React won't re-run the effect when videoId/status are unchanged).
    if (videoId === result.videoId && status === 'ready') {
      setPendingSeekQuery(searchQuery);
      return;
    }

    setActiveResult(result.videoId);
    setSegments([]);
    setTranscriptStatus('pending');
    setActiveSegIdx(-1);
    setHlsLevels([]);
    setTotalTime(null);
    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
    setVideoId(result.videoId);
    setStatus('ready');
    setPendingSeekQuery(searchQuery); // trigger the auto-seek once transcript loads
    // Transcript will load via the useEffect poll
  };

  // ─── Search ────────────────────────────────────────────────────────────
  const handleSearch = async (e) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    setIsSearching(true);
    try {
      const res  = await fetch(`/api/v1/search?q=${encodeURIComponent(searchQuery)}`);
      const data = await res.json();
      setSearchResults(data.results || []);
    } catch (err) { console.error(err); }
    finally { setIsSearching(false); }
  };

  // ─── Drag and Drop ─────────────────────────────────────────────────────
  const onDragOver = (e) => { e.preventDefault(); setDragOver(true); };
  const onDragLeave = () => setDragOver(false);

  // ────────────────────────────────────────────────────────────────────────
  // RENDER
  // ────────────────────────────────────────────────────────────────────────
  return (
    <div className="app-root">
      {/* HEADER */}
      <header className="app-header">
        <h1>⚡ Zero-Disk Stream Engine</h1>
        <div className="subtitle">Enterprise Video Ingestion · AI Semantic Search · HLS Adaptive Streaming</div>
      </header>

      {/* SEARCH */}
      <div className="card">
        <form className="search-bar" onSubmit={handleSearch}>
          <input
            className="search-input"
            type="text"
            placeholder="Search by meaning, spoken words, or topic…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          <button type="submit" className="btn btn-ghost" disabled={isSearching}>
            {isSearching ? '⏳ Searching…' : '🔍 Search'}
          </button>
        </form>

        {searchResults.length > 0 && (
          <div style={{ marginTop: 20 }}>
            <div className="results-header">
              {searchResults.length} Semantic Match{searchResults.length > 1 ? 'es' : ''}
            </div>
            {searchResults.map((r) => (
              <div
                key={r.videoId}
                className={`result-card ${activeResult === r.videoId ? 'active' : ''}`}
                onClick={() => playResult(r)}
              >
                <div className="result-thumb">🎬</div>
                <div className="result-info">
                  <div className="result-title">{r.title || r.videoId}</div>
                  <div className="result-snippet">
                    {r.transcript ? r.transcript.substring(0, 120) + '…' : 'No transcript yet.'}
                  </div>
                </div>
                <div className="result-meta">
                  <span className="match-badge">{Math.round((r.similarity || 0) * 100)}%</span>
                  <button
                    className="btn btn-ghost"
                    style={{ padding: '5px 12px', fontSize: '0.78rem' }}
                    onClick={(e) => { e.stopPropagation(); playResult(r); }}
                  >▶ Play</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* UPLOAD (shown when not in ready state from upload) */}
      {status !== 'ready' && (
        <div className="card">
          <div
            className={`upload-zone ${dragOver ? 'drag-over' : ''}`}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={handleFileDrop}
          >
            <input type="file" accept="video/*" onChange={handleFileDrop} />
            <div className="upload-icon">📹</div>
            <div className="upload-title">
              {selectedFile ? 'Video Selected' : 'Drop your video here'}
            </div>
            <div className="upload-hint">MP4, MKV, MOV, AVI supported</div>
            {selectedFile && (
              <div className="upload-filename">📄 {selectedFile.name}</div>
            )}
          </div>

          {selectedFile && (
            <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <input
                className="title-input"
                type="text"
                placeholder="Enter a title for this video (optional)"
                value={videoTitle}
                onChange={(e) => setVideoTitle(e.target.value)}
                maxLength={120}
              />
              <button
                className="btn btn-success"
                onClick={handleUpload}
                disabled={status === 'uploading' || status === 'processing'}
              >
                {status === 'uploading' ? '⬆️ Uploading…' : status === 'processing' ? '⚙️ Transcoding…' : '🚀 Upload & Process'}
              </button>
            </div>
          )}

          {/* Progress bar */}
          {(status === 'uploading' || status === 'processing') && (
            <div className="progress-card" style={{ marginTop: 20 }}>
              <div className="progress-label">{progressMsg}</div>
              <div className="progress-bar-outer">
                <div className="progress-bar-fill" style={{ width: `${percent}%` }} />
              </div>
            </div>
          )}

          {status === 'error' && (
            <div style={{ marginTop: 14, color: '#ef4444', fontSize: '0.9rem', textAlign: 'center' }}>
              ❌ {progressMsg}
              <button className="btn btn-ghost" onClick={resetUpload} style={{ display: 'block', margin: '10px auto 0', width: 'auto' }}>
                Try Again
              </button>
            </div>
          )}
        </div>
      )}

      {/* PLAYER */}
      {status === 'ready' && (
        <div className="card">
          {totalTime && (
            <div className="success-badge" style={{ marginBottom: 16 }}>
              ✅ Processed in {fmtDuration(totalTime)}
            </div>
          )}

          <div className="player-layout">
            {/* LEFT: Video + Controls */}
            <div className="player-col">
              <video ref={videoRef} controls autoPlay muted />

              {/* Controls bar */}
              <div className="controls-bar">
                <div className="controls-group">
                  <span className="controls-label">Quality:</span>
                  <select className="quality-select" onChange={handleQuality}>
                    <option value="-1">Auto (ABR)</option>
                    {hlsLevels.map((lvl, i) => (
                      <option key={i} value={i}>{lvl.height}p · {Math.round(lvl.bitrate / 1000)} kbps</option>
                    ))}
                  </select>
                </div>

                <div className="controls-group">
                  <span className="controls-label">Speed:</span>
                  {SPEED_OPTIONS.map((s) => (
                    <button
                      key={s}
                      className={`btn-speed ${playbackSpeed === s ? 'active' : ''}`}
                      onClick={() => setPlaybackSpeed(s)}
                    >{s}x</button>
                  ))}
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <span className="video-id-pill">{videoId}</span>
                <button className="btn btn-ghost" style={{ width: 'auto', padding: '7px 14px', fontSize: '0.82rem' }} onClick={resetUpload}>
                  ↩ Upload New
                </button>
              </div>
            </div>

            {/* RIGHT: Transcript */}
            <div className="transcript-col">
              <div className="transcript-header">
                <div className="transcript-header-title">
                  {transcriptStatus === 'ready' && <span className="transcript-dot" />}
                  Transcript
                </div>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-3)' }}>
                  {transcriptStatus === 'ready'
                    ? `${segments.length} segments`
                    : transcriptStatus === 'loading'
                    ? 'Loading…'
                    : 'AI generating…'}
                </span>
              </div>
              <div className="transcript-body" ref={transcriptBodyRef}>
                {segments.length === 0 ? (
                  <div className="transcript-empty">
                    <span style={{ fontSize: 28 }}>
                      {transcriptStatus === 'loading' ? '⏳' : transcriptStatus === 'error' ? '⚠️' : '🤖'}
                    </span>
                    <span>
                      {transcriptStatus === 'loading'
                        ? 'Loading transcript…'
                        : transcriptStatus === 'error'
                        ? 'Transcript is missing or failed for this video.'
                        : 'AI is generating the transcript. It will appear here automatically once ready.'}
                    </span>
                  </div>
                ) : (
                  segments.map((seg, i) => (
                    <div
                      key={i}
                      ref={(el) => segRefs.current[i] = el}
                      className={`transcript-segment ${i === activeSegIdx ? 'active' : ''}`}
                      onClick={() => seekTo(seg.t)}
                    >
                      <span className="seg-time">{fmtTime(seg.t)}</span>
                      <span className="seg-text">{seg.s}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
