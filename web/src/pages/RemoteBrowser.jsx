import { useState, useEffect, useRef, useCallback } from 'react';
import { FiRefreshCw, FiNavigation, FiType, FiCornerDownLeft, FiArrowLeft, FiArrowRight, FiDelete, FiArrowUp, FiArrowDown, FiZap, FiZapOff, FiPlus, FiX } from 'react-icons/fi';
import { api } from '../App';

function RemoteBrowser() {
  const [tabs, setTabs] = useState([]);
  const [activeTabId, setActiveTabId] = useState(null);
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
  // Track the actual screencast image dimensions for accurate coordinate mapping
  const [screencastSize, setScreencastSize] = useState(null);
  const imgRef = useRef(null);
  const navUrlRef = useRef('');
  const wsRef = useRef(null);
  const reconnectTimer = useRef(null);
  const scrollThrottleRef = useRef(null);

  // Fetch tabs list
  const fetchTabs = useCallback(async () => {
    try {
      const res = await api.fetch('/api/browser/tabs');
      const data = await res.json();
      if (data.tabs) {
        setTabs(data.tabs);
        const active = data.tabs.find(t => t.active);
        if (active) setActiveTabId(active.id);
      }
    } catch { }
  }, []);

  // Switch tab
  const switchTab = useCallback(async (targetId) => {
    try {
      await api.fetch('/api/browser/tabs/switch', { method: 'POST', body: JSON.stringify({ targetId }) });
      setActiveTabId(targetId);
      // Tell screencast WS to switch
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'switchTab', targetId }));
      }
      fetchTabs();
    } catch { }
  }, [fetchTabs]);

  // New tab
  const newTab = useCallback(async () => {
    try {
      const res = await api.fetch('/api/browser/tabs/new', { method: 'POST', body: JSON.stringify({}) });
      const data = await res.json();
      if (data.tab) {
        setActiveTabId(data.tab.id);
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: 'switchTab', targetId: data.tab.id }));
        }
      }
      fetchTabs();
    } catch { }
  }, [fetchTabs]);

  // Close tab
  const closeTab = useCallback(async (targetId, e) => {
    e.stopPropagation();
    try {
      await api.fetch('/api/browser/tabs/close', { method: 'POST', body: JSON.stringify({ targetId }) });
      // If we closed the active tab, the backend will reset, refetch to get new active
      fetchTabs();
      // If we closed the active tab, screencast needs to reconnect
      if (targetId === activeTabId && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        // Small delay then tell WS to switch to whatever is now active
        setTimeout(async () => {
          const res = await api.fetch('/api/browser/tabs');
          const data = await res.json();
          if (data.tabs && data.tabs.length > 0) {
            const newActive = data.tabs.find(t => t.active) || data.tabs[0];
            setActiveTabId(newActive.id);
            wsRef.current?.send(JSON.stringify({ type: 'switchTab', targetId: newActive.id }));
          }
        }, 300);
      }
    } catch { }
  }, [activeTabId, fetchTabs]);

  // Fetch tabs periodically
  useEffect(() => {
    fetchTabs();
    const interval = setInterval(fetchTabs, 2000);
    return () => clearInterval(interval);
  }, [fetchTabs]);

  // Build WebSocket URL
  const getWsUrl = useCallback(() => {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const token = localStorage.getItem('token');
    return `${proto}//${host}/ws/screencast?token=${encodeURIComponent(token)}`;
  }, []);

  // Send a command through the WebSocket (for input events)
  const wsSend = useCallback((msg) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }, []);

  // Connect WebSocket for live screencast
  const connectScreencast = useCallback(() => {
    if (wsRef.current) {
      try { wsRef.current.close(); } catch { }
    }

    const ws = new WebSocket(getWsUrl());
    wsRef.current = ws;

    ws.onopen = () => {
      setWsConnected(true);
      setError('');
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'frame') {
          setScreenshot(msg.image);
          if (msg.metadata) {
            const { deviceWidth, deviceHeight, offsetTop } = msg.metadata;
            if (deviceWidth && deviceHeight) {
              setScreencastSize({ width: deviceWidth, height: deviceHeight, offsetTop: offsetTop || 0 });
            }
          }
        } else if (msg.type === 'tabChanged') {
          // Server auto-switched to a new tab (e.g., popup opened)
          if (msg.targetId) {
            setActiveTabId(msg.targetId);
            fetchTabs();
          }
        } else if (msg.type === 'debug') {
          console.log('[RemoteBrowser Debug]', msg.message);
        } else if (msg.type === 'error') {
          setError(msg.error);
        }
      } catch { }
    };

    ws.onclose = () => {
      setWsConnected(false);
      wsRef.current = null;
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
      try { wsRef.current.close(); } catch { }
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

  // Fallback: fetch screenshot via REST
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

  // Fetch page info periodically when in live mode
  useEffect(() => {
    if (!liveMode) return;
    const fetchInfo = async () => {
      try {
        const res = await api.fetch('/api/browser/page-info');
        const data = await res.json();
        if (data.url) setPageUrl(data.url);
        if (data.title) setPageTitle(data.title);
        if (data.viewport) setViewport(data.viewport);
        if (!navUrlRef.current) {
          setNavUrl(data.url);
          navUrlRef.current = data.url;
        }
      } catch { }
    };
    fetchInfo();
    const interval = setInterval(fetchInfo, 5000);
    return () => clearInterval(interval);
  }, [liveMode]);

  /**
   * Accurate coordinate mapping that handles objectFit: contain letterboxing.
   * The img element may have black bars (letterbox) on sides or top/bottom.
   * We need to find where the actual image content is rendered within the element,
   * then map that to the real browser viewport coordinates.
   */
  const getCoords = useCallback((e) => {
    const img = imgRef.current;
    if (!img) return null;

    const rect = img.getBoundingClientRect();
    // The actual rendered size of the image content (natural aspect ratio within the element)
    const naturalW = img.naturalWidth;
    const naturalH = img.naturalHeight;
    if (!naturalW || !naturalH) return null;

    // Calculate the rendered image dimensions within the element (objectFit: contain)
    const elemAspect = rect.width / rect.height;
    const imgAspect = naturalW / naturalH;

    let renderedW, renderedH, offsetX, offsetY;
    if (imgAspect > elemAspect) {
      // Image is wider than element — letterbox top/bottom
      renderedW = rect.width;
      renderedH = rect.width / imgAspect;
      offsetX = 0;
      offsetY = (rect.height - renderedH) / 2;
    } else {
      // Image is taller than element — letterbox left/right
      renderedH = rect.height;
      renderedW = rect.height * imgAspect;
      offsetX = (rect.width - renderedW) / 2;
      offsetY = 0;
    }

    // Mouse position relative to the rendered image content (not the element)
    const relX = e.clientX - rect.left - offsetX;
    const relY = e.clientY - rect.top - offsetY;

    // If click is outside the actual image content (in the letterbox), ignore
    if (relX < 0 || relY < 0 || relX > renderedW || relY > renderedH) return null;

    // Map to the real browser viewport coordinates
    // Use screencastSize (from CDP metadata) if in live mode, otherwise use viewport
    const targetW = (liveMode && screencastSize) ? screencastSize.width : viewport.width;
    const targetH = (liveMode && screencastSize) ? screencastSize.height : viewport.height;

    return {
      x: Math.round((relX / renderedW) * targetW),
      y: Math.round((relY / renderedH) * targetH),
    };
  }, [viewport, screencastSize, liveMode]);

  const handleClick = async (e) => {
    const coords = getCoords(e);
    if (!coords) return;
    setLoading(true);
    try {
      // Try WebSocket first for lower latency
      if (liveMode && wsSend({ type: 'click', ...coords })) {
        // CDP click sent via WS, no need for REST
      } else {
        await api.fetch('/api/browser/click', { method: 'POST', body: JSON.stringify(coords) });
        if (!liveMode) {
          await new Promise(r => setTimeout(r, 800));
          await fetchScreenshot();
        }
      }
    } catch { }
    setLoading(false);
  };

  const handleScroll = async (e) => {
    e.preventDefault();
    const coords = getCoords(e);
    if (!coords) return;
    const deltaY = e.deltaY > 0 ? 300 : -300;

    // Throttle scroll events
    if (scrollThrottleRef.current) return;
    scrollThrottleRef.current = true;
    setTimeout(() => { scrollThrottleRef.current = false; }, 80);

    // Try WebSocket first for instant scroll
    if (liveMode && wsSend({ type: 'scroll', x: coords.x, y: coords.y, deltaX: 0, deltaY })) {
      return; // Sent via WS, screencast will update automatically
    }
    try {
      await api.fetch('/api/browser/scroll', {
        method: 'POST',
        body: JSON.stringify({ x: coords.x, y: coords.y, deltaX: 0, deltaY }),
      });
      if (!liveMode) setTimeout(fetchScreenshot, 400);
    } catch { }
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
    } catch { }
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
    } catch { }
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
    } catch { }
    setLoading(false);
  };

  const handleScrollBtn = async (direction) => {
    const deltaY = direction === 'down' ? 400 : -400;
    const cx = viewport.width / 2;
    const cy = viewport.height / 2;
    if (liveMode && wsSend({ type: 'scroll', x: cx, y: cy, deltaX: 0, deltaY })) return;
    try {
      await api.fetch('/api/browser/scroll', {
        method: 'POST',
        body: JSON.stringify({ x: cx, y: cy, deltaX: 0, deltaY }),
      });
      if (!liveMode) setTimeout(fetchScreenshot, 400);
    } catch { }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Tab bar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '2px', marginBottom: '4px', flexShrink: 0,
        overflowX: 'auto', paddingBottom: '2px',
      }}>
        {tabs.map(tab => (
          <div
            key={tab.id}
            onClick={() => switchTab(tab.id)}
            style={{
              display: 'flex', alignItems: 'center', gap: '6px',
              padding: '5px 10px', borderRadius: '6px 6px 0 0', cursor: 'pointer',
              fontSize: '12px', maxWidth: '180px', minWidth: '80px',
              background: tab.id === activeTabId ? '#1a1a1a' : '#0a0a0a',
              border: `1px solid ${tab.id === activeTabId ? '#444' : '#222'}`,
              borderBottom: tab.id === activeTabId ? '1px solid #1a1a1a' : '1px solid #222',
              color: tab.id === activeTabId ? '#fff' : '#888',
            }}
          >
            <span style={{
              flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {tab.title || 'Untitled'}
            </span>
            <span
              onClick={(e) => closeTab(tab.id, e)}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: '16px', height: '16px', borderRadius: '3px', flexShrink: 0,
                opacity: 0.5, cursor: 'pointer',
              }}
              onMouseEnter={(e) => e.currentTarget.style.opacity = 1}
              onMouseLeave={(e) => e.currentTarget.style.opacity = 0.5}
            >
              <FiX size={10} />
            </span>
          </div>
        ))}
        <button
          onClick={newTab}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: '28px', height: '28px', borderRadius: '6px', cursor: 'pointer',
            background: 'transparent', border: '1px solid #333', color: '#888',
            flexShrink: 0,
          }}
          title="New tab"
        >
          <FiPlus size={12} />
        </button>
      </div>

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

      {/* Screenshot */}
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
