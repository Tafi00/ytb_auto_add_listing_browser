const ERROR_MESSAGES = {
  AUTH_REQUIRED: 'Phiên đăng nhập YouTube Studio đã hết hạn. Hãy mở API Tool và đăng nhập lại.',
  AUTH_SESSION_NOT_READY: 'API Tool chưa lấy được phiên Studio. Hãy mở chế độ đăng nhập rồi tải lại YouTube Studio.',
  PRODUCT_NOT_FOUND: 'Không tìm thấy sản phẩm này trên YouTube Shopping. Hãy kiểm tra URL hoặc thử sản phẩm khác.',
  PRODUCT_SEARCH_FAILED: 'YouTube Shopping chưa tìm được sản phẩm. Vui lòng thử lại.',
  PRODUCT_ADD_FAILED: 'YouTube Studio không gắn được sản phẩm vào video. Vui lòng thử lại.',
  AFFILIATE_NOT_READY: 'Đã gắn sản phẩm nhưng link affiliate công khai chưa cập nhật kịp. Vui lòng thử lại sau.',
  CLEANUP_FAILED: 'Không thể xác nhận đã gỡ sản phẩm khỏi video. Hãy kiểm tra video trong YouTube Studio.',
  VIDEO_NOT_READY: 'Tab video trên API Tool chưa sẵn sàng. Hãy kiểm tra danh sách video local.',
  BROWSER_DISCONNECTED: 'Chrome nền bị mất kết nối. Hãy khởi động lại API worker.',
  WORKER_BUSY: 'Video đang xử lý một yêu cầu khác. Vui lòng thử lại.',
  WORKER_DISCONNECTED: 'API worker chưa kết nối relay. Hãy mở API Tool trên máy Windows.',
  WORKER_TIMEOUT: 'API worker xử lý quá thời gian chờ. Vui lòng thử lại.',
  QUEUE_TIMEOUT: 'Hàng đợi đang quá tải. Vui lòng thử lại sau.',
  YOUTUBE_RATE_LIMIT: 'YouTube đang giới hạn tần suất. Vui lòng thử lại sau ít phút.',
  YOUTUBE_UPSTREAM_ERROR: 'YouTube Studio đang tạm thời không ổn định. Vui lòng thử lại.',
  YOUTUBE_API_TIMEOUT: 'YouTube Studio phản hồi quá chậm. Vui lòng thử lại.',
  RELAY_ERROR: 'Relay không thể hoàn tất yêu cầu lúc này. Vui lòng thử lại.',
};

export function formatApiError(data, fallback = 'Có lỗi xảy ra. Vui lòng thử lại.') {
  if (!data || typeof data !== 'object') return fallback;
  const message = ERROR_MESSAGES[data.code] || data.error || fallback;
  if (data.cleanupSucceeded === false && data.code !== 'CLEANUP_FAILED') {
    return `${message} Lưu ý: chưa xác nhận được việc gỡ sản phẩm khỏi video.`;
  }
  return message;
}

export async function readJsonResponse(response) {
  const body = await response.text();
  if (!body.trim()) return {};
  try {
    return JSON.parse(body);
  } catch {
    const upstreamError = /bad gateway|gateway timeout|service unavailable/i.test(body);
    if (upstreamError || [502, 503, 504].includes(response.status)) {
      throw new Error('Relay tạm thời mất kết nối. Yêu cầu có thể vẫn đang chạy; vui lòng kiểm tra lại sau.');
    }
    throw new Error(`Server trả về dữ liệu không hợp lệ (HTTP ${response.status || 'không xác định'}).`);
  }
}
