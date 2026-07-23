export async function readJsonResponse(response) {
  const body = await response.text();
  if (!body.trim()) return {};
  try {
    return JSON.parse(body);
  } catch {
    const upstreamError = /bad gateway|gateway timeout|service unavailable/i.test(body);
    if (upstreamError || [502, 503, 504].includes(response.status)) {
      throw new Error('Relay tạm thời mất kết nối. Job có thể vẫn đang chạy, vui lòng kiểm tra lại sau.');
    }
    throw new Error(`Server trả về dữ liệu không hợp lệ (HTTP ${response.status || 'unknown'})`);
  }
}
