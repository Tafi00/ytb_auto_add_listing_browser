import { useState, useEffect, useRef, useCallback } from 'react';
import { FiRefreshCw, FiNavigation, FiType, FiCornerDownLeft, FiArrowLeft, FiArrowRight, FiDelete, FiArrowUp, FiArrowDown } from 'react-icons/fi';
import { api } from '../App';

function RemoteBrowser() {
  const [screenshot, setScreenshot] = useState(null);
  const [pageUrl, setPageUrl] = useState('');
  const [pageTitle, setPageTitle] = useState('');
  const [navUrl, setNavUrl] = useState('');
  const [typeText, setTypeText] = useState('');
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [error, setError] = useState('');
  const [viewport, setViewport] = useState({ width: 1920, height: 1080 });
  const imgRef = useRef(null);
  const intervalRef = useRef(null);
  const navUrlRef = useRef('');

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

  useEffect(() => { fetchScreenshot(); }, []);

  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = setInterval(fetchScreenshot, 2000);
    } else if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [autoRefresh, fetchScreenshot]);

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
      await new Promise(r => setTimeout(r, 800));
      await fetchScreenshot();
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
      setTimeout(fetchScreenshot, 400);
    } catch {}
  };

  const handleNavigate = async (e) => {
    e.preventDefault();
    if (!navUrl) return;
    setLoading(true);
    try {
      await api.fetch('/api/browser/navigate', { method: 'POST', body: JSON.stringify({ url: navUrl }) });
      await new Promise(r => setTimeout(r, 1500));
      await fetchScreenshot();
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
      await new Promise(r => setTimeout(r, 500));
      await fetchScreenshot();
    } catch {}
    setLoading(false);
  };

  const handleKey = async (key) => {
    setLoading(true);
    try {
      await api.fetch('/api/browser/key', { method: 'POST', body: JSON.stringify({ key }) });
      await new Promise(r => setTimeout(r, 500));
      await fetchScreenshot();
    } catch {}
    setLoading(false);
  };

  const handleScrollBtn = async (direction) => {
    try {
      await api.fetch('/api/browser/scroll', {
        method: 'POST',
        body: JSON.stringify({ x: viewport.width / 2, y: viewport.height / 2, deltaX: 0, deltaY: direction === 'down' ? 400 : -400 }),
      });
      setTimeout(fetchScreenshot, 400);
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
        <label style={{ fontSize: '12px', color: '#888', display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer', whiteSpace: 'nowrap' }}>
          <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} /> Auto
        </label>
        <button type="button" className="btn-session btn-session-open" onClick={fetchScreenshot} disabled={refreshing}
          style={{ padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '4px' }}>
          <FiRefreshCw size={12} className={refreshing ? 'spin' : ''} />
        </button>
      </form>

      {/* Screenshot - fills remaining space */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative', borderRadius: '8px', overflow: 'hidden', border: '1px solid #252525', background: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {screenshot ? (
          <img ref={imgRef} src={screenshot} alt="Browser" onClick={handleClick} onWheel={handleScroll}
            style={{ maxWidth: '100%', maxHeight: '100%', display: 'block', cursor: 'crosshair', objectFit: 'contain' }} draggable={false} />
        ) : (
          <div style={{ padding: '60px', textAlign: 'center', color: '#555' }}>Click Refresh to load screenshot</div>
        )}
        {loading && (
          <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div className="spinner" />
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
    </div>
  );
}

export default RemoteBrowser;
