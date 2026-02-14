import { useState, useEffect, useRef, useCallback } from 'react';
import { FiRefreshCw, FiNavigation, FiType, FiCornerDownLeft, FiArrowLeft, FiArrowRight, FiDelete, FiArrowUp, FiArrowDown, FiZap, FiZapOff } from 'react-icons/fi';
import { api } from '../App';

function RemoteBrowser() {
  const [screenshot, setScreenshot] = useState(null);
  const [pageUrl, setPageUrl] = useState('');
  const [pageTitle, setPageTitle] = useState('');
  const [navUrl, setNavUrl] = useState('');
  const [typeText, setTypeText] = useState('');
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [viewport, setViewport] = useState({ width: 1920, height: 1080 });
  const [liveMode, setLiveMode] = useState(true);
  const [wsConnected, setWsConnected] = useState(false);
  const imgRef = useRef(null);
  const navUrlRef = useRef('');
  const wsRef = useRef(null);
  const reconnectTimer = useRef(null);

  // Build WebSocket URL
  const getWsUrl = useCallback(() => {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const token = localStorage.getItem('token');
    return `${proto}//${host}/ws/screencast?token=${encodeURIComponent(token)}`;
  }, []);

  // Connect WebSocket for live screencast
  const connectScreencast = useCallback(() => {
    if (wsRef.current) {
      try { wsRef.current.close(); } catch {}
    }

    const ws = new WebSocket(getWsUrl());
    wsRef.current = ws;

    ws.onopen = () => {
      setWsConnected(true);
      setError('');
      console.log('[Screencast] Connected');
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'frame') {
          setScreenshot(msg.image);
          if (msg.metadata) {
            if (msg.metadata.pageScaleFactor) {
              // Update viewport from metadata if available
            }
          }
        } else if (msg.type === 'error') {
          setError(msg.error);
        }
      } catch {}
    };

    ws.onclose = () => {
      setWsConnected(false);
      wsRef.current = null;
      // Auto-reconnect after 3s if live mode is still on
      if (liveMode) {
        reconnectTimer.current = setTimeout(connectScreencast, 3000);
      }
    };

    ws.onerror = () => {
      setWsConnected(false);
    };
  }, [getWsUrl, liveMode]);

  // Disconnect WebSocket
  const disconnectScreencast = useCallback(() => {
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
    if (wsRef.current) {
      try { wsRef.current.close(); } catch {}
      wsRef.current = null;
    }
    setWsConnected(false);
  }, []);

  // Toggle live mode
  useEffect(() => {
    if (liveMode) {
      connectScreencast();
    } else {
      disconnectScreencast();
    }
    return () => disconnectScreencast();
  }, [liveMode]);

  // Fallback: fetch screenshot via REST (used when live mode is off, or for initial load)
  const fetchScreenshot = useCallback(async () => {
    try {
      setError('');
      setRefreshing(true);
      const res = await api.fetch('/api/browser/screenshot');
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Failed'); return; }
      setScreenshot(data.image);
      setPageUrl(data.url);
      setPageTitle(data.title);
      if (data.viewport) setViewport(data.viewport);
      if (!navUrlRef.current) {
        setNavUrl(data.url);
        navUrlRef.current = data.url;
      }
    } catch (e) { setError(e.message); }
    finally { setRefreshing(false); }
  }, []);

  // Fetch page info (URL, title) periodically when in live mode
  useEffect(() => {
    if (!liveMode) return;
    const fetchInfo = async () => {
      try {
        const res = await api.fetch('/api/browser/page-info');
        const data = await res.json();
        if (data.url) setPageUrl(data.url);
        if (data.title) setPageTitle(data.title);
        if (!navUrlRef.current) {
          setNavUrl(data.url);
          navUrlRef.current = data.url;
        }
      } catch {}
    };
    fetchInfo();
    const interval = setInterval(fetchInfo, 5000);
    return () => clearInterval(interval);
  }, [liveMode]);

  const getCoords = (e) => {
    if (!imgRef.current) return null;
    const rect = imgRef.current.getBoundingClientRect();
    const scaleX = viewport.width / rect.width;
    const scaleY = viewport.height / rect.height;
    return {
      x: Math.round((e.clientX - rect.left) * scaleX),
      y: Math.round((e.clientY - rect.top) * scaleY),
    };
  };

  const handleClick = async (e) => {
    const coords = getCoords(e);
    if (!coords) return;
    setLoading(true);
    try {
      await api.fetch('/api/browser/click', { method: 'POST', body: JSON.stringify(coords) });
      if (!liveMode) {
        await new Promise(r => setTimeout(r, 800));
        await fetchScreenshot();
      }
    } catch {}
    setLoading(false);
  };

  const handleScroll = async (e) => {
    e.preventDefault();
    const coords = getCoords(e);
    if (!coords) return;
    try {
      await api.fetch('/api/browser/scroll', {
        method: 'POST',
        body: JSON.stringify({ x: coords.x, y: coords.y, deltaX: 0, deltaY: e.deltaY > 0 ? 300 : -300 }),
      });
      if (!liveMode) setTimeout(fetchScreenshot, 400);
    } catch {}
  };

  const handleNavigate = async (e) => {
    e.preventDefault();
    if (!navUrl) return;
    setLoading(true);
    try {
      await api.fetch('/api/browser/navigate', { method: 'POST', body: JSON.stringify({ url: navUrl }) });
      if (!liveMode) {
        await new Promise(r => setTimeout(r, 1500));
        await fetchScreenshot();
      }
    } catch {}
    setLoading(false);
  };

  const handleType = async (e) => {
    e.preventDefault();
    if (!typeText) return;
    setLoading(true);
    try {
      await api.fetch('/api/browser/type', { method: 'POST', body: JSON.stringify({ text: typeText }) });
      setTypeText('');
      if (!liveMode) {
        await new Promise(r => setTimeout(r, 500));
        await fetchScreenshot();
      }
    } catch {}
    setLoading(false);
  };

  const handleKey = async (key) => {
    setLoading(true);
    try {
      await api.fetch('/api/browser/key', { method: 'POST', body: JSON.stringify({ key }) });
      if (!liveMode) {
        await new Promise(r => setTimeout(r, 500));
        await fetchScreenshot();
      }
    } catch {}
    setLoading(false);
  };

  const handleScrollBtn = async (direction) => {
    try {
      await api.fetch('/api/browser/scroll', {
        method: 'POST',
        body: JSON.stringify({ x: viewport.width / 2, y: viewport.height / 2, deltaX: 0, deltaY: direction === 'down' ? 400 : -400 }),
      });
      if (!liveMode) setTimeout(fetchScreenshot, 400);
    } catch {}
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* URL bar */}
      <form onSubmit={handleNavigate} style={{ display: 'flex', gap: '6px', marginBottom: '8px', flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: '4px' }}>
          <button type="button" className="btn-session btn-session-open" onClick={() => handleKey('Alt+ArrowLeft')}
            style={{ padding: '6px 8px' }}><FiArrowLeft size={14} /></button>
          <button type="button" className="btn-session btn-session-open" onClick={() => handleKey('Alt+ArrowRight')}
            style={{ padding: '6px 8px' }}><FiArrowRight size={14} /></button>
        </div>
        <input type="text" value={navUrl} onChange={(e) => { setNavUrl(e.target.value); navUrlRef.current = e.target.value; }}
          placeholder="URL..." style={{
            flex: 1, padding: '8px 12px', borderRadius: '6px', fontSize: '13px',
            border: '1px solid #333', background: '#0a0a0a', color: '#fff', outline: 'none',
          }} />
        <button type="submit" className="btn-session btn-session-open" disabled={loading}
          style={{ padding: '6px 14px' }}><FiNavigation size={12} /> Go</button>
        <button
          type="button"
          className="btn-session btn-session-open"
          onClick={() => setLiveMode(!liveMode)}
          style={{
            padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '4px',
            background: liveMode && wsConnected ? 'rgba(34,197,94,0.15)' : undefined,
            borderColor: liveMode && wsConnected ? '#22c55e' : undefined,
            color: liveMode && wsConnected ? '#22c55e' : undefined,
          }}
          title={liveMode ? 'Live mode ON - click to switch to manual' : 'Manual mode - click for live preview'}
        >
          {liveMode ? <FiZap size={12} /> : <FiZapOff size={12} />}
          {liveMode ? 'Live' : 'Manual'}
        </button>
        {!liveMode && (
          <button type="button" className="btn-session btn-session-open" onClick={fetchScreenshot} disabled={refreshing}
            style={{ padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '4px' }}>
            <FiRefreshCw size={12} className={refreshing ? 'spin' : ''} />
          </button>
        )}
      </form>

      {/* Screenshot - fills remaining space */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative', borderRadius: '8px', overflow: 'hidden', border: '1px solid #252525', background: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {screenshot ? (
          <img ref={imgRef} src={screenshot} alt="Browser" onClick={handleClick} onWheel={handleScroll}
            style={{ maxWidth: '100%', maxHeight: '100%', display: 'block', cursor: 'crosshair', objectFit: 'contain' }} draggable={false} />
        ) : (
          <div style={{ padding: '60px', textAlign: 'center', color: '#555' }}>
            {liveMode ? 'Connecting live preview...' : 'Click Refresh to load screenshot'}
          </div>
        )}
        {loading && (
          <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div className="spinner" />
          </div>
        )}
        {/* Live indicator */}
        {liveMode && (
          <div style={{
            position: 'absolute', top: '8px', right: '8px',
            padding: '3px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: 500,
            background: wsConnected ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)',
            color: wsConnected ? '#22c55e' : '#f87171',
            border: `1px solid ${wsConnected ? '#22c55e33' : '#f8717133'}`,
            display: 'flex', alignItems: 'center', gap: '4px',
          }}>
            <span style={{
              width: '6px', height: '6px', borderRadius: '50%',
              background: wsConnected ? '#22c55e' : '#f87171',
              animation: wsConnected ? 'pulse 2s infinite' : 'none',
            }} />
            {wsConnected ? 'LIVE' : 'Reconnecting...'}
          </div>
        )}
      </div>

      {/* Page info + error */}
      {error && (
        <div style={{ fontSize: '12px', color: '#f87171', marginTop: '4px', padding: '6px 10px', background: 'rgba(239,68,68,0.08)', borderRadius: '6px', flexShrink: 0 }}>
          {error}
        </div>
      )}
      {pageTitle && (
        <div style={{ fontSize: '11px', color: '#666', marginTop: '4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 0 }}>
          {pageTitle} — {pageUrl}
        </div>
      )}

      {/* Keyboard + scroll controls */}
      <div style={{ display: 'flex', gap: '6px', marginTop: '8px', flexWrap: 'wrap', alignItems: 'center', flexShrink: 0 }}>
        <form onSubmit={handleType} style={{ display: 'flex', gap: '4px', flex: 1, minWidth: '200px' }}>
          <input type="text" value={typeText} onChange={(e) => setTypeText(e.target.value)}
            placeholder="Type text..." style={{
              flex: 1, padding: '7px 10px', borderRadius: '6px', fontSize: '13px',
              border: '1px solid #333', background: '#0a0a0a', color: '#fff', outline: 'none',
            }} />
          <button type="submit" className="btn-session btn-session-open" disabled={loading || !typeText}
            style={{ padding: '6px 12px' }}><FiType size={12} /> Type</button>
        </form>
        <button className="btn-session btn-session-open" onClick={() => handleKey('Enter')} style={{ padding: '6px 10px' }}><FiCornerDownLeft size={12} /> Enter</button>
        <button className="btn-session btn-session-open" onClick={() => handleKey('Tab')} style={{ padding: '6px 10px' }}>Tab</button>
        <button className="btn-session btn-session-open" onClick={() => handleKey('Backspace')} style={{ padding: '6px 10px' }}><FiDelete size={12} /></button>
        <button className="btn-session btn-session-open" onClick={() => handleKey('Escape')} style={{ padding: '6px 10px' }}>Esc</button>
        <button className="btn-session btn-session-open" onClick={() => handleScrollBtn('up')} style={{ padding: '6px 10px' }}><FiArrowUp size={12} /></button>
        <button className="btn-session btn-session-open" onClick={() => handleScrollBtn('down')} style={{ padding: '6px 10px' }}><FiArrowDown size={12} /></button>
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </div>
  );
}

export default RemoteBrowser;
