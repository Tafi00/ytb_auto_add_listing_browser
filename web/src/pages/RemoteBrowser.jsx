import { useState, useEffect, useRef, useCallback } from 'react';
import { FiMonitor, FiRefreshCw, FiNavigation, FiType, FiCornerDownLeft, FiArrowLeft, FiArrowRight, FiDelete } from 'react-icons/fi';
import { api } from '../App';

const VIEWPORT = { width: 1920, height: 1080 };

function RemoteBrowser() {
  const [screenshot, setScreenshot] = useState(null);
  const [pageUrl, setPageUrl] = useState('');
  const [pageTitle, setPageTitle] = useState('');
  const [navUrl, setNavUrl] = useState('');
  const [typeText, setTypeText] = useState('');
  const [loading, setLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [error, setError] = useState('');
  const imgRef = useRef(null);
  const intervalRef = useRef(null);
  const navUrlRef = useRef('');

  const fetchScreenshot = useCallback(async () => {
    try {
      setError('');
      const res = await api.fetch('/api/browser/screenshot');
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Failed'); return; }
      setScreenshot(data.image);
      setPageUrl(data.url);
      setPageTitle(data.title);
      if (!navUrlRef.current) {
        setNavUrl(data.url);
        navUrlRef.current = data.url;
      }
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    fetchScreenshot();
  }, []);

  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = setInterval(fetchScreenshot, 2000);
    } else {
      if (intervalRef.current) clearInterval(intervalRef.current);
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [autoRefresh, fetchScreenshot]);

  const handleClick = async (e) => {
    if (!imgRef.current) return;
    const rect = imgRef.current.getBoundingClientRect();
    const scaleX = VIEWPORT.width / rect.width;
    const scaleY = VIEWPORT.height / rect.height;
    const x = Math.round((e.clientX - rect.left) * scaleX);
    const y = Math.round((e.clientY - rect.top) * scaleY);

    setLoading(true);
    try {
      await api.fetch('/api/browser/click', { method: 'POST', body: JSON.stringify({ x, y }) });
      await new Promise(r => setTimeout(r, 800));
      await fetchScreenshot();
    } catch {}
    setLoading(false);
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

  return (
    <div className="card" style={{ marginTop: '16px' }}>
      <div className="card-header">
        <h2 className="card-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <FiMonitor size={16} color="#60a5fa" /> Remote Browser
        </h2>
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          <label style={{ fontSize: '12px', color: '#888', display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
            <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
            Auto refresh
          </label>
          <button className="btn-session btn-session-open" onClick={fetchScreenshot} disabled={loading}
            style={{ padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '4px' }}>
            <FiRefreshCw size={12} className={loading ? 'spin' : ''} /> Refresh
          </button>
        </div>
      </div>

      {/* URL bar */}
      <form onSubmit={handleNavigate} style={{ display: 'flex', gap: '6px', marginBottom: '10px' }}>
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
          style={{ padding: '6px 14px' }}>
          <FiNavigation size={12} /> Go
        </button>
      </form>

      {/* Screenshot */}
      <div style={{ position: 'relative', borderRadius: '8px', overflow: 'hidden', border: '1px solid #252525', background: '#000' }}>
        {screenshot ? (
          <img ref={imgRef} src={screenshot} alt="Browser" onClick={handleClick}
            style={{ width: '100%', display: 'block', cursor: 'crosshair' }} />
        ) : (
          <div style={{ padding: '60px', textAlign: 'center', color: '#555' }}>
            Click Refresh to load screenshot
          </div>
        )}
        {loading && (
          <div style={{
            position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <div className="spinner" />
          </div>
        )}
      </div>

      {/* Page info */}
      {error && (
        <div style={{ fontSize: '12px', color: '#f87171', marginTop: '6px', padding: '8px 12px', background: 'rgba(239,68,68,0.08)', borderRadius: '6px' }}>
          {error}
        </div>
      )}
      {pageTitle && (
        <div style={{ fontSize: '11px', color: '#666', marginTop: '6px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {pageTitle} — {pageUrl}
        </div>
      )}

      {/* Keyboard controls */}
      <div style={{ display: 'flex', gap: '6px', marginTop: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
        <form onSubmit={handleType} style={{ display: 'flex', gap: '4px', flex: 1, minWidth: '200px' }}>
          <input type="text" value={typeText} onChange={(e) => setTypeText(e.target.value)}
            placeholder="Type text..." style={{
              flex: 1, padding: '7px 10px', borderRadius: '6px', fontSize: '13px',
              border: '1px solid #333', background: '#0a0a0a', color: '#fff', outline: 'none',
            }} />
          <button type="submit" className="btn-session btn-session-open" disabled={loading || !typeText}
            style={{ padding: '6px 12px' }}>
            <FiType size={12} /> Type
          </button>
        </form>
        <button className="btn-session btn-session-open" onClick={() => handleKey('Enter')} style={{ padding: '6px 10px' }}>
          <FiCornerDownLeft size={12} /> Enter
        </button>
        <button className="btn-session btn-session-open" onClick={() => handleKey('Tab')} style={{ padding: '6px 10px' }}>
          Tab
        </button>
        <button className="btn-session btn-session-open" onClick={() => handleKey('Backspace')} style={{ padding: '6px 10px' }}>
          <FiDelete size={12} />
        </button>
        <button className="btn-session btn-session-open" onClick={() => handleKey('Escape')} style={{ padding: '6px 10px' }}>
          Esc
        </button>
      </div>
    </div>
  );
}

export default RemoteBrowser;
