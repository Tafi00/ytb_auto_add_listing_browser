const PRODUCT_UNAVAILABLE_CODES = new Set([
  'PRODUCT_NOT_FOUND',
  'AFFILIATE_LISTING_MISMATCH',
]);

export function normalizeRelayJobError(error, { knownWorkerError = false } = {}) {
  const rawMessage = error?.message || '';
  const rawCode = error?.code
    || (/queue/i.test(rawMessage) ? 'QUEUE_TIMEOUT' : 'RELAY_ERROR');
  const productUnavailable = PRODUCT_UNAVAILABLE_CODES.has(rawCode);
  const code = productUnavailable ? 'PRODUCT_NOT_FOUND' : rawCode;
  const stage = productUnavailable
    ? 'product-selection'
    : error?.stage || (/queue/i.test(rawMessage) ? 'queue' : 'relay');
  const retryable = productUnavailable
    ? false
    : knownWorkerError ? Boolean(error?.retryable) : true;
  const message = productUnavailable
    ? 'Sản phẩm này không gắn giỏ được'
    : knownWorkerError
      ? rawMessage
      : 'Relay không thể hoàn tất yêu cầu lúc này. Vui lòng thử lại.';
  const status = code === 'PRODUCT_NOT_FOUND'
    ? 422
    : code === 'YOUTUBE_RATE_LIMIT'
      ? 429
      : ['WORKER_TIMEOUT', 'QUEUE_TIMEOUT'].includes(code)
        ? 504
        : ['WORKER_DISCONNECTED', 'VIDEO_NOT_READY', 'AUTH_SESSION_NOT_READY', 'AUTH_REQUIRED'].includes(code)
          ? 503
          : 500;

  return {
    payload: {
      error: message,
      code,
      stage,
      retryable,
      ...(error?.cleanupSucceeded === false ? {
        cleanupSucceeded: false,
        cleanupError: error.cleanupError || 'Không thể xác nhận đã gỡ sản phẩm.',
      } : {}),
    },
    status,
  };
}
