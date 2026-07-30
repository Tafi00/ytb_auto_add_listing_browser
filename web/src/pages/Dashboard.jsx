import { useState, useEffect, useRef } from 'react';
import { FiGlobe, FiZap, FiEdit3, FiFilm, FiAlertTriangle, FiList, FiFileText, FiPlus, FiX, FiTrash2, FiWifi, FiWifiOff } from 'react-icons/fi';
import { api } from '../App';

const BrowserIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="20" height="20">
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <line x1="3" y1="9" x2="21" y2="9" />
    <circle cx="7" cy="6" r="0.5" fill="currentColor" />
    <circle cx="10" cy="6" r="0.5" fill="currentColor" />
  </svg>
);

const inputStyle = {
  width: '100%', padding: '10px 14px', borderRadius: '8px',
  border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.05)',
  color: '#fff', fontSize: '14px', outline: 'none',
};

function Dashboard({ user, onLogout }) {
  const [profile, setProfile] = useState(null);
  const [jobUrl, setJobUrl] = useState('');
  const [jobSaved, setJobSaved] = useState(false);
  const [workerConnected, setWorkerConnected] = useState(false);
  const [workerInfo, setWorkerInfo] = useState([]);
  const [historyStats, setHistoryStats] = useState(null);
  const [clearing, setClearing] = useState(false);

  // Site config state
  const [siteConfig, setSiteConfig] = useState(null);
  const [configSaved, setConfigSaved] = useState(false);
  const [uploading, setUploading] = useState(false);
  const videoInputRef = useRef(null);
  const faviconInputRef = useRef(null);

  useEffect(() => {
    loadProfile();
    loadJobConfig();
    loadSiteConfig();
    loadHistoryStats();
    checkWorkerStatus();
    const interval = setInterval(checkWorkerStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  const loadProfile = async () => {
    try { setProfile(await api.getProfile()); } catch { }
  };

  const loadJobConfig = async () => {
    try { const d = await api.getJobConfig(); setJobUrl(d.url || ''); } catch { }
  };

  const loadHistoryStats = async () => {
    try {
      const res = await api.fetch('/api/history-stats');
      setHistoryStats(await res.json());
    } catch { }
  };

  const handleClearHistory = async () => {
    if (!window.confirm('Xóa toàn bộ lịch sử gắn link? Hành động này không thể hoàn tác.')) return;
    setClearing(true);
    try {
      await api.fetch('/api/history-stats', { method: 'DELETE' });
      setHistoryStats({ totalLinks: 0 });
    } catch (err) { alert(err.message); }
    finally { setClearing(false); }
  };

  const loadSiteConfig = async () => {
    try {
      const res = await api.fetch('/api/site-config');
      setSiteConfig(await res.json());
    } catch { }
  };

  const checkWorkerStatus = async () => {
    try {
      const res = await api.fetch('/api/worker-status');
      const data = await res.json();
      setWorkerConnected(data.connected);
      setWorkerInfo(data.workers || []);
    } catch {
      setWorkerConnected(false);
      setWorkerInfo([]);
    }
  };

  const handleSaveJobConfig = async () => {
    try { await api.saveJobConfig(jobUrl); setJobSaved(true); setTimeout(() => setJobSaved(false), 2000); }
    catch (err) { alert('Failed: ' + err.message); }
  };

  const [testing, setTesting] = useState(false);
  const handleTestConcurrency = async () => {
    const testLinks = [
      'https://s.shopee.vn/60LRrcK4ZW',
      'https://vn.shp.ee/ENnQvy8',
      'https://shopee.vn/a-i.1081175057.22956004192',
      'https://shopee.vn/product/307491301/12961322188',
      'https://www.lazada.vn/products/pdp-i246452966-s316699339.html',
      'https://s.lazada.vn/s.6vrsK',
      'https://s.lazada.vn/l.ZCUoB?cc'
    ];
    setTesting(true);

    try {
      const results = await Promise.allSettled(testLinks.map(async (link) => {
        const res = await api.fetch('/api/get-affiliate', {
          method: 'POST',
          body: JSON.stringify({ productUrl: link, clientId: 'admin-test', bypassRateLimit: true }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Request failed');
        return data;
      }));

      const summary = results.map((r, i) => {
        if (r.status === 'fulfilled') {
          return `Link ${i + 1}: OK (Thành công)`;
        } else {
          return `Link ${i + 1}: Lỗi - ${r.reason.message}`;
        }
      }).join('\n');

      alert(`Kết quả test 7 link:\n\n${summary}`);
    } catch (err) {
      alert('Lỗi quá trình test: ' + err.message);
    } finally {
      setTesting(false);
      loadHistoryStats();
    }
  };

  // Site config handlers
  const updateConfig = (key, value) => {
    setSiteConfig(prev => ({ ...prev, [key]: value }));
  };

  const updateTip = (index, value) => {
    setSiteConfig(prev => {
      const tips = [...(prev.tips || [])];
      tips[index] = value;
      return { ...prev, tips };
    });
  };

  const addTip = () => {
    setSiteConfig(prev => ({ ...prev, tips: [...(prev.tips || []), ''] }));
  };

  const removeTip = (index) => {
    setSiteConfig(prev => ({ ...prev, tips: (prev.tips || []).filter((_, i) => i !== index) }));
  };

  const handleSaveSiteConfig = async () => {
    try {
      const res = await api.fetch('/api/site-config', {
        method: 'PUT',
        body: JSON.stringify(siteConfig),
      });
      if (!res.ok) throw new Error('Failed');
      setConfigSaved(true);
      setTimeout(() => setConfigSaved(false), 2000);
    } catch (err) { alert('Failed: ' + err.message); }
  };

  const handleUploadVideo = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('video/')) { alert('Chỉ chấp nhận file video'); return; }
    if (file.size > 100 * 1024 * 1024) { alert('File quá lớn (tối đa 100MB)'); return; }

    setUploading(true);
    try {
      const res = await fetch('/api/upload-video', {
        method: 'POST',
        headers: {
          'Content-Type': file.type,
          'Authorization': `Bearer ${api.token}`,
        },
        body: file,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      updateConfig('guideVideoUrl', data.videoUrl);
      const saveRes = await api.fetch('/api/site-config', {
        method: 'PUT',
        body: JSON.stringify({ ...siteConfig, guideVideoUrl: data.videoUrl }),
      });
      if (saveRes.ok) setSiteConfig(await saveRes.json());
    } catch (err) { alert('Upload failed: ' + err.message); }
    finally { setUploading(false); if (videoInputRef.current) videoInputRef.current.value = ''; }
  };

  const handleRemoveVideo = async () => {
    updateConfig('guideVideoUrl', '');
    try {
      await api.fetch('/api/site-config', {
        method: 'PUT',
        body: JSON.stringify({ ...siteConfig, guideVideoUrl: '' }),
      });
    } catch { }
  };

  const handleUploadFavicon = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { alert('Chỉ chấp nhận file ảnh'); return; }
    if (file.size > 5 * 1024 * 1024) { alert('File quá lớn (tối đa 5MB)'); return; }
    try {
      const res = await fetch('/api/upload-favicon', {
        method: 'POST',
        headers: { 'Content-Type': file.type, 'Authorization': `Bearer ${api.token}` },
        body: file,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      updateConfig('faviconUrl', data.faviconUrl);
      const saveRes = await api.fetch('/api/site-config', {
        method: 'PUT',
        body: JSON.stringify({ ...siteConfig, faviconUrl: data.faviconUrl }),
      });
      if (saveRes.ok) setSiteConfig(await saveRes.json());
    } catch (err) { alert('Upload failed: ' + err.message); }
    finally { if (faviconInputRef.current) faviconInputRef.current.value = ''; }
  };

  const handleRemoveFavicon = async () => {
    updateConfig('faviconUrl', '');
    try {
      await api.fetch('/api/site-config', {
        method: 'PUT',
        body: JSON.stringify({ ...siteConfig, faviconUrl: '' }),
      });
    } catch { }
  };

  return (
    <div className="container">
      <header className="header">
        <div className="logo">
          <div className="logo-icon"><BrowserIcon /></div>
          <h1>Admin Dashboard</h1>
        </div>
        <div className="header-right">
          <span className="user-info">{user}</span>
          <button className="btn-logout" onClick={onLogout}>Sign Out</button>
        </div>
      </header>

      {/* Worker Status */}
      <div className="card">
        <div className="card-header">
          <h2 className="card-title" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            {workerConnected
              ? <FiWifi size={18} color="#4ade80" />
              : <FiWifiOff size={18} color="#f87171" />
            }
            Worker Status
          </h2>
        </div>
        <div className="profile-card">
          <div className="profile-info">
            <div className="profile-name">
              <span className="session-dot" style={{
                background: workerConnected ? '#4ade80' : '#f87171',
                boxShadow: workerConnected ? '0 0 6px rgba(74,222,128,0.4)' : '0 0 6px rgba(248,113,113,0.4)'
              }} />
              {workerConnected ? `${workerInfo.length} worker(s) kết nối` : 'Chưa có worker kết nối'}
              <span style={{ fontSize: '12px', color: workerConnected ? '#4ade80' : '#94a3b8', marginLeft: '8px' }}>
                {workerConnected ? 'Online' : 'Offline'}
              </span>
            </div>
            {workerInfo.length > 0 && (
              <div className="profile-meta">
                {workerInfo.map((w, i) => (
                  <span key={i} style={{ display: 'block', fontSize: '12px', color: '#94a3b8', marginTop: '4px' }}>
                    Worker {i + 1}: {w.workerType === 'android' ? 'Android / LDPlayer' : 'Web / Chrome'}
                    {' · '}{w.urls?.length || 0} video
                    {w.devices?.length ? ` · ${w.devices.join(', ')}` : ''}
                    {' · '}{w.busy ? 'Busy' : 'Ready'}
                    {' · '}Kết nối lúc {new Date(w.connectedAt).toLocaleTimeString()}
                  </span>
                ))}
              </div>
            )}
            {!workerConnected && (
              <div className="profile-meta" style={{ marginTop: '8px' }}>
                <span style={{ color: '#f59e0b', fontSize: '12px' }}>
                  Chạy Android worker: <code style={{ background: 'rgba(255,255,255,0.1)', padding: '2px 6px', borderRadius: '4px' }}>npm run android-worker</code>
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Job Config */}
      <div className="card" style={{ marginTop: '16px' }}>
        <div className="card-header">
          <h2 className="card-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <FiZap size={16} color="#60a5fa" /> Job Configuration (Nhiều luồng)</h2>
          <button className="btn-session btn-session-open" onClick={handleTestConcurrency} disabled={testing} style={{ background: '#455a64', borderColor: '#455a64' }}>
            {testing ? 'Đang test...' : 'Test 7 Link'}
          </button>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
          <span style={{ color: '#94a3b8', fontSize: '13px', minWidth: '90px', marginTop: '10px' }}>Video URLs</span>
          <textarea value={jobUrl} onChange={(e) => setJobUrl(e.target.value)}
            placeholder={"https://studio.youtube.com/video/.../edit\nhttps://studio.youtube.com/video/.../edit\n(Mỗi link 1 dòng)"}
            style={{ ...inputStyle, flex: 1, resize: 'vertical', minHeight: '80px' }} />
          <button className="btn-session btn-session-open"
            style={{ borderColor: 'rgba(52,211,153,0.4)', color: '#34d399', whiteSpace: 'nowrap' }}
            onClick={handleSaveJobConfig}>
            {jobSaved ? '✓ Saved' : 'Save'}
          </button>
        </div>
      </div>

      {/* Lịch sử gắn link */}
      <div className="card" style={{ marginTop: '16px' }}>
        <div className="card-header">
          <h2 className="card-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <FiList size={16} color="#60a5fa" /> Lịch sử gắn link
          </h2>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span style={{ color: '#e2e8f0', fontSize: '28px', fontWeight: 700 }}>
              {historyStats ? historyStats.totalLinks : '...'}
            </span>
            <span style={{ color: '#94a3b8', fontSize: '13px' }}>link đã gắn</span>
          </div>
          {historyStats && historyStats.totalLinks > 0 && (
            <button className="btn-session btn-session-delete" onClick={handleClearHistory} disabled={clearing}
              style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 16px' }}>
              <FiTrash2 size={14} /> {clearing ? 'Đang xóa...' : 'Xóa toàn bộ'}
            </button>
          )}
        </div>
      </div>

      {/* Site Config */}
      {siteConfig && (
        <div className="card" style={{ marginTop: '16px' }}>
          <div className="card-header">
            <h2 className="card-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <FiEdit3 size={16} color="#60a5fa" /> Cấu hình trang Public</h2>
            <button className="btn-session btn-session-open"
              style={{ borderColor: 'rgba(52,211,153,0.4)', color: '#34d399' }}
              onClick={handleSaveSiteConfig}>
              {configSaved ? '✓ Đã lưu' : 'Lưu thay đổi'}
            </button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {/* Page Title & Subtitle */}
            <div>
              <label style={{ color: '#94a3b8', fontSize: '13px', display: 'block', marginBottom: '6px' }}>
                <FiFileText size={13} style={{ verticalAlign: 'middle', marginRight: '4px' }} /> Tiêu đề trang Public
              </label>
              <input type="text" value={siteConfig.pageTitle || ''} onChange={(e) => updateConfig('pageTitle', e.target.value)}
                placeholder="GẮN SẢN PHẨM YOUTUBE" style={inputStyle} />
            </div>
            <div>
              <label style={{ color: '#94a3b8', fontSize: '13px', display: 'block', marginBottom: '6px' }}>
                Mô tả trang Public
              </label>
              <input type="text" value={siteConfig.pageSubtitle || ''} onChange={(e) => updateConfig('pageSubtitle', e.target.value)}
                placeholder="Nhập link sản phẩm Shopee, Lazada để gắn giỏ youtube" style={inputStyle} />
            </div>

            {/* Favicon */}
            <div>
              <label style={{ color: '#94a3b8', fontSize: '13px', display: 'block', marginBottom: '6px' }}>
                <FiGlobe size={13} style={{ verticalAlign: 'middle', marginRight: '4px' }} /> Favicon
              </label>
              {siteConfig.faviconUrl ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <img src={siteConfig.faviconUrl} alt="favicon" style={{ width: '32px', height: '32px', borderRadius: '4px', border: '1px solid #333' }} />
                  <button className="btn-session btn-session-open" onClick={() => faviconInputRef.current?.click()}>
                    Đổi favicon
                  </button>
                  <button className="btn-session btn-session-delete" onClick={handleRemoveFavicon}>
                    Xoá
                  </button>
                </div>
              ) : (
                <button className="btn-session btn-session-open" onClick={() => faviconInputRef.current?.click()}
                  style={{ padding: '10px 20px' }}>
                  Upload favicon
                </button>
              )}
              <input ref={faviconInputRef} type="file" accept="image/*" onChange={handleUploadFavicon}
                style={{ display: 'none' }} />
            </div>

            {/* Video hướng dẫn */}
            <div>
              <label style={{ color: '#94a3b8', fontSize: '13px', display: 'block', marginBottom: '6px' }}>
                <FiFilm size={13} style={{ verticalAlign: 'middle', marginRight: '4px' }} /> Video hướng dẫn
              </label>
              {siteConfig.guideVideoUrl ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <video src={siteConfig.guideVideoUrl} style={{ maxWidth: '300px', borderRadius: '8px', border: '1px solid #333' }} controls />
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <button className="btn-session btn-session-open" onClick={() => videoInputRef.current?.click()}>
                      Đổi video
                    </button>
                    <button className="btn-session btn-session-delete" onClick={handleRemoveVideo}>
                      Xoá video
                    </button>
                  </div>
                </div>
              ) : (
                <button className="btn-session btn-session-open" onClick={() => videoInputRef.current?.click()}
                  disabled={uploading} style={{ padding: '12px 20px' }}>
                  {uploading ? 'Đang upload...' : 'Upload video'}
                </button>
              )}
              <input ref={videoInputRef} type="file" accept="video/*" onChange={handleUploadVideo}
                style={{ display: 'none' }} />
            </div>

            {/* Lưu ý */}
            <div>
              <label style={{ color: '#94a3b8', fontSize: '13px', display: 'block', marginBottom: '6px' }}>
                <FiAlertTriangle size={13} style={{ verticalAlign: 'middle', marginRight: '4px' }} /> Tiêu đề lưu ý
              </label>
              <input type="text" value={siteConfig.noteTitle || ''} onChange={(e) => updateConfig('noteTitle', e.target.value)}
                style={inputStyle} />
            </div>
            <div>
              <label style={{ color: '#94a3b8', fontSize: '13px', display: 'block', marginBottom: '6px' }}>
                Nội dung lưu ý
              </label>
              <textarea value={siteConfig.noteText || ''} onChange={(e) => updateConfig('noteText', e.target.value)}
                rows={3} style={{ ...inputStyle, resize: 'vertical' }} />
            </div>

            {/* Tips */}
            <div>
              <label style={{ color: '#94a3b8', fontSize: '13px', display: 'block', marginBottom: '6px' }}>
                <FiList size={13} style={{ verticalAlign: 'middle', marginRight: '4px' }} /> Danh sách lưu ý (tips)
              </label>
              {(siteConfig.tips || []).map((tip, i) => (
                <div key={i} style={{ display: 'flex', gap: '6px', marginBottom: '6px', alignItems: 'center' }}>
                  <input type="text" value={tip} onChange={(e) => updateTip(i, e.target.value)}
                    style={{ ...inputStyle, flex: 1 }} />
                  <button className="btn-session btn-session-delete" onClick={() => removeTip(i)}
                    style={{ padding: '8px 12px', fontSize: '12px' }}><FiX size={12} /></button>
                </div>
              ))}
              <button className="btn-session btn-session-open" onClick={addTip}
                style={{ fontSize: '12px', padding: '6px 14px' }}><FiPlus size={12} /> Thêm tip</button>
            </div>

            {/* Tips footer */}
            <div>
              <label style={{ color: '#94a3b8', fontSize: '13px', display: 'block', marginBottom: '6px' }}>
                Ghi chú cuối tips
              </label>
              <input type="text" value={siteConfig.tipsFooter || ''} onChange={(e) => updateConfig('tipsFooter', e.target.value)}
                style={inputStyle} />
            </div>

            {/* Product note */}
            <div>
              <label style={{ color: '#94a3b8', fontSize: '13px', display: 'block', marginBottom: '6px' }}>
                Lưu ý trên card sản phẩm
              </label>
              <input type="text" value={siteConfig.productNote || ''} onChange={(e) => updateConfig('productNote', e.target.value)}
                style={inputStyle} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default Dashboard;
