import { useState, useEffect, useCallback } from 'react';
import { FiLink, FiCopy, FiCheck, FiTrash2, FiAlertTriangle, FiMonitor, FiSmartphone, FiClock, FiPlay, FiArrowRight } from 'react-icons/fi';
import { FaYoutube } from 'react-icons/fa';

const COOLDOWN_MS = 15000;

function getClientId() {
  let id = localStorage.getItem('_cid');
  if (!id) {
    id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('_cid', id);
  }
  return id;
}

function getCooldownRemaining() {
  const last = parseInt(localStorage.getItem('_lastSubmit') || '0', 10);
  const diff = Date.now() - last;
  return diff < COOLDOWN_MS ? COOLDOWN_MS - diff : 0;
}

function Public() {
  const [productUrl, setProductUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [cooldown, setCooldown] = useState(getCooldownRemaining());
  const [history, setHistory] = useState(() => {
    try { return JSON.parse(localStorage.getItem('_history') || '[]'); } catch { return []; }
  });
  const [copied, setCopied] = useState(null);
  const [siteConfig, setSiteConfig] = useState(null);

  useEffect(() => {
    fetch('/api/site-config').then(r => r.json()).then(setSiteConfig).catch(() => {});
  }, []);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => {
      const remaining = getCooldownRemaining();
      setCooldown(remaining);
      if (remaining <= 0) clearInterval(timer);
    }, 500);
    return () => clearInterval(timer);
  }, [cooldown]);

  const saveHistory = useCallback((entry) => {
    setHistory(prev => {
      const next = [entry, ...prev].slice(0, 50);
      localStorage.setItem('_history', JSON.stringify(next));
      return next;
    });
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setResult(null);
    if (!productUrl.trim()) { setError('Vui lòng nhập link sản phẩm'); return; }
    const remaining = getCooldownRemaining();
    if (remaining > 0) {
      setCooldown(remaining);
      setError(`Vui lòng đợi ${Math.ceil(remaining / 1000)}s trước khi gửi tiếp`);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/get-affiliate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productUrl: productUrl.trim(), clientId: getClientId() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Có lỗi xảy ra');
      if (!data.affiliateUrl) {
        setError('Không tìm thấy link affiliate. Vui lòng thử sản phẩm khác.');
      } else {
        const entry = {
          productUrl: productUrl.trim(),
          affiliateUrl: data.affiliateUrl,
          metadata: data.metadata || {},
          createdAt: new Date().toISOString(),
        };
        setResult(entry);
        saveHistory(entry);
      }
      localStorage.setItem('_lastSubmit', Date.now().toString());
      setCooldown(COOLDOWN_MS);
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  };

  const handleCopy = (text, idx) => {
    navigator.clipboard.writeText(text).then(() => { setCopied(idx); setTimeout(() => setCopied(null), 2000); });
  };

  const clearHistory = () => { setHistory([]); localStorage.removeItem('_history'); };
  const cooldownSec = Math.ceil(cooldown / 1000);

  const cfg = siteConfig || {};
  const productNote = cfg.productNote || 'Nếu mã không hiện, tài khoản của bạn có thể đã bị lọc, cần đổi tài khoản khác.';

  return (
    <div className="public-page">
      <div className="public-container">
        <div className="public-header">
          <div className="public-logo">
            <FaYoutube size={26} />
            <span>Áp Mã Youtube</span>
          </div>
          <p className="public-subtitle">Nhập link sản phẩm Shopee / Lazada để tạo link affiliate</p>
        </div>

        <div className="public-card">
          <form onSubmit={handleSubmit} className="public-form">
            <div className="public-input-wrap">
              <FiLink className="public-input-icon" />
              <input type="text" value={productUrl} onChange={(e) => setProductUrl(e.target.value)}
                placeholder="Dán link Shopee hoặc Lazada vào đây..."
                className="public-input" disabled={loading} autoFocus />
            </div>
            <button type="submit" className="public-btn" disabled={loading || cooldown > 0}>
              {loading ? <><span className="spinner-small" /> Đang xử lý...</>
                : cooldown > 0 ? <><FiClock size={14} /> {cooldownSec}s</>
                : 'Thêm giỏ hàng'}
            </button>
          </form>
          {error && <div className="public-error"><FiAlertTriangle size={14} /> {error}</div>}
          {result && <ProductCard item={result} copied={copied} onCopy={handleCopy} copyKey="result" productNote={productNote} />}
        </div>

        <div className="public-grid">
          <div className="public-left">
            <div className="public-card public-note-card">
              <h3 className="public-card-title"><FiMonitor size={15} /> {cfg.noteTitle || 'Lưu ý máy tính'}</h3>
              <p className="public-note-text">{cfg.noteText || 'Tool chỉ hoạt động khi mở link đến app Shopee trên điện thoại. Trên PC, hãy copy link rồi mở trên điện thoại.'}</p>
            </div>
            <div className="public-card">
              <h3 className="public-card-title"><FiPlay size={15} /> Hướng dẫn</h3>
              {cfg.guideVideoUrl ? (
                <video src={cfg.guideVideoUrl} controls style={{ width: '100%', borderRadius: '8px', marginBottom: '10px' }} />
              ) : (
                <div className="public-video-placeholder">
                  <FaYoutube size={32} />
                  <p>Video hướng dẫn sẽ được cập nhật</p>
                </div>
              )}
              <ul className="public-tips">
                {(cfg.tips || ['Không dùng nhiều tài khoản trên 1 thiết bị', 'Không dùng cùng mã trên nhiều thiết bị chung mạng', 'Không mua cùng shop liên tục trong thời gian ngắn']).map((tip, i) => (
                  <li key={i}>{tip}</li>
                ))}
              </ul>
              <p className="public-tips-sub">{cfg.tipsFooter || 'Nếu không hiện mã: kiểm tra lượt còn, cập nhật Shopee, thử SP khác, đổi tài khoản.'}</p>
            </div>
          </div>

          <div className="public-right">
            <div className="public-card public-history-card">
              <div className="public-card-header-row">
                <h3 className="public-card-title"><FiClock size={15} /> Lịch sử</h3>
                {history.length > 0 && (
                  <button className="public-clear-btn" onClick={clearHistory}><FiTrash2 size={12} /> Xoá</button>
                )}
              </div>
              {history.length === 0 ? (
                <p className="public-empty">Chưa có lịch sử</p>
              ) : (
                <div className="public-history">
                  {history.map((item, i) => (
                    <ProductCard key={i} item={item} copied={copied} onCopy={handleCopy} copyKey={i} compact productNote={productNote} />
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ProductCard({ item, copied, onCopy, copyKey, compact, productNote }) {
  const meta = item.metadata || {};
  const hasImage = !!meta.image;
  const title = meta.title || item.productUrl;
  const price = meta.price || '';
  const desc = meta.description || '';

  return (
    <div className={`product-card ${compact ? 'product-card--compact' : ''}`}>
      <div className="product-card__top">
        <h4 className="product-card__title" title={title}>
          {title.length > (compact ? 60 : 80) ? title.slice(0, compact ? 57 : 77) + '...' : title}
        </h4>
      </div>
      <div className="product-card__body">
        {hasImage && <img src={meta.image} alt="" className="product-card__img" loading="lazy" />}
        <div className="product-card__info">
          {price && <span className="product-card__price">{price}</span>}
          {desc && <p className="product-card__desc">--- {desc.length > 100 ? desc.slice(0, 97) + '...' : desc}</p>}
        </div>
      </div>
      <p className="product-card__note"><em>Lưu ý:</em> {productNote}</p>
      <div className="product-card__actions">
        <a href={item.affiliateUrl} target="_blank" rel="noopener noreferrer" className="product-card__btn product-card__btn--yt">
          <FiArrowRight size={14} /> Mã YT
        </a>
        <button className="product-card__copy" onClick={() => onCopy(item.affiliateUrl, copyKey)} title="Copy link">
          {copied === copyKey ? <FiCheck size={14} /> : <FiCopy size={14} />}
        </button>
      </div>
    </div>
  );
}

export default Public;
