const METADATA_UPDATE_URL =
    'https://studio.youtube.com/youtubei/v1/video_manager/metadata_update?alt=json';
const SHOPPING_SETTINGS_URL =
    'https://studio.youtube.com/youtubei/v1/monetization/get_shopping_settings?alt=json';

const FORWARDED_HEADER_NAMES = new Set([
    'authorization',
    'content-type',
    'origin',
    'referer',
    'x-goog-authuser',
    'x-goog-pageid',
    'x-goog-visitor-id',
    'x-origin',
    'x-youtube-client-name',
    'x-youtube-client-version',
]);

export class StudioApiError extends Error {
    constructor(message, {
        code = 'STUDIO_API_ERROR',
        stage = 'studio-api',
        retryable = false,
        status = null,
        cause = null,
    } = {}) {
        super(message, cause ? { cause } : undefined);
        this.name = 'StudioApiError';
        this.code = code;
        this.stage = stage;
        this.retryable = retryable;
        this.status = status;
    }
}

function operationErrorInfo(operation, status = null) {
    const lower = String(operation || '').toLowerCase();
    if (status === 401 || status === 403) {
        return {
            code: 'AUTH_REQUIRED',
            stage: 'authentication',
            retryable: false,
            message: 'Phiên đăng nhập YouTube Studio đã hết hạn. Hãy mở chế độ đăng nhập và đăng nhập lại.',
        };
    }
    if (status === 429) {
        return {
            code: 'YOUTUBE_RATE_LIMIT',
            stage: 'youtube-api',
            retryable: true,
            message: 'YouTube đang giới hạn tần suất. Vui lòng thử lại sau ít phút.',
        };
    }
    if (status && status >= 500) {
        return {
            code: 'YOUTUBE_UPSTREAM_ERROR',
            stage: 'youtube-api',
            retryable: true,
            message: 'YouTube Studio đang tạm thời không phản hồi ổn định.',
        };
    }
    if (lower.includes('search')) {
        return { code: 'PRODUCT_SEARCH_FAILED', stage: 'product-search', retryable: true };
    }
    if (lower.includes('add')) {
        return { code: 'PRODUCT_ADD_FAILED', stage: 'product-add', retryable: true };
    }
    if (lower.includes('remove')) {
        return { code: 'CLEANUP_FAILED', stage: 'cleanup', retryable: true };
    }
    return { code: 'STUDIO_API_ERROR', stage: 'studio-api', retryable: true };
}

function wrapStudioError(error, operation) {
    if (error instanceof StudioApiError) return error;
    const info = operationErrorInfo(operation);
    const raw = error?.message || String(error);
    const timedOut = /timeout|timed out/i.test(raw);
    return new StudioApiError(
        timedOut ? `${operation} quá thời gian chờ.` : `${operation} thất bại: ${raw}`,
        {
            ...info,
            code: timedOut ? 'YOUTUBE_API_TIMEOUT' : info.code,
            retryable: true,
            cause: error,
        },
    );
}

export function extractShoppingItemId(veSiblingKey) {
    const match = String(veSiblingKey || '').match(/^(\d+):\d+$/);
    if (!match) {
        throw new Error(`Invalid YouTube Shopping item key: ${veSiblingKey || '(empty)'}`);
    }
    return match[1];
}

export function buildProductSelectionBody({
    context,
    delegationContext,
    videoId,
    shoppingItemIds,
    youtubeAutomatedIds = [],
}) {
    if (!videoId) throw new Error('videoId is required');
    if (!context || typeof context !== 'object') {
        throw new Error('A captured YouTube Studio request context is required');
    }

    const ids = [...new Set((shoppingItemIds || []).map(item => {
        if (item && typeof item === 'object') return JSON.stringify(item);
        return JSON.stringify({ productClusterMid: String(item || '') });
    }).filter(item => item !== '{"productClusterMid":""}'))]
        .map(item => JSON.parse(item));
    return {
        context,
        ...(delegationContext ? { delegationContext } : {}),
        encryptedVideoId: videoId,
        productsSelection: {
            shoppingItemIds: ids,
            youtubeAutomatedIds,
            productStickerMetadata: { autoStickerMetadata: {} },
            enableGlobalProductStickerFeature: true,
        },
    };
}

export function buildProductSearchBody({ context, delegationContext, videoId, productUrl }) {
    if (!videoId) throw new Error('videoId is required');
    if (!productUrl) throw new Error('productUrl is required');
    if (!context || typeof context !== 'object') {
        throw new Error('A captured YouTube Studio request context is required');
    }

    return {
        context,
        ...(delegationContext ? { delegationContext } : {}),
        searchShoppingProductsRequest: {
            shoppingDescriptor: {
                editDescriptor: { externalVideoId: videoId },
            },
            searchQuery: {
                rawQuery: productUrl,
                thirdPartyQueryConfig: {},
                productSourceRestrict: 'PRODUCT_SOURCE_ALL',
            },
            tagCreationContext: {
                creatorTagging: {
                    taggingTool: 'TAGGING_TOOL_PRODUCT_PICKER',
                },
            },
        },
    };
}

export function findProductClusterMid(value) {
    const seen = new Set();

    function visit(node) {
        if (!node || typeof node !== 'object' || seen.has(node)) return null;
        seen.add(node);

        const direct = node.productClusterMid;
        if (/^\d+$/.test(String(direct || ''))) return String(direct);
        const gpcId = node.gpcId;
        if (/^\d+$/.test(String(gpcId || ''))) return String(gpcId);

        for (const child of Object.values(node)) {
            if (typeof child === 'string') {
                const match = child.match(/^(\d+):\d+$/);
                if (match) return match[1];
            } else {
                const found = visit(child);
                if (found) return found;
            }
        }
        return null;
    }

    const id = visit(value);
    if (!id) {
        throw new StudioApiError(
            'Không tìm thấy sản phẩm tương ứng với URL trên YouTube Shopping.',
            {
                code: 'PRODUCT_NOT_FOUND',
                stage: 'product-search',
                retryable: false,
            },
        );
    }
    return id;
}

export function selectStudioHeaders(headers = {}) {
    const selected = {};
    for (const [name, value] of Object.entries(headers)) {
        const lower = name.toLowerCase();
        if (FORWARDED_HEADER_NAMES.has(lower) && value) selected[lower] = value;
    }
    selected['content-type'] = 'application/json';
    return selected;
}

export async function parseStudioResponse(response, operation = 'YouTube Studio API') {
    const text = await response.text();
    const status = response.status();
    const ok = response.ok();

    if (!ok) {
        const detail = text.replace(/\s+/g, ' ').trim().slice(0, 300) || 'empty response';
        const info = operationErrorInfo(operation, status);
        throw new StudioApiError(
            info.message
                ? `${info.message} (HTTP ${status}: ${detail})`
                : `${operation} HTTP ${status}: ${detail}`,
            { ...info, status },
        );
    }

    try {
        return JSON.parse(text);
    } catch {
        const detail = text.replace(/\s+/g, ' ').trim().slice(0, 120) || 'empty response';
        const info = operationErrorInfo(operation, status);
        throw new StudioApiError(
            `${operation} trả về dữ liệu không hợp lệ: ${detail}`,
            { ...info, code: 'INVALID_YOUTUBE_RESPONSE', status, retryable: true },
        );
    }
}

/**
 * Keeps only short-lived YouTubei request metadata in memory. Cookies and
 * browser-profile data are never read or persisted.
 */
export class StudioInternalApi {
    constructor(page) {
        this.page = page;
        this.session = null;
        this.waiters = new Set();
        this.onRequest = request => void this.captureRequest(request);
    }

    start() {
        this.page.on('request', this.onRequest);
        return this;
    }

    stop() {
        this.page.off('request', this.onRequest);
        this.waiters.clear();
    }

    async captureRequest(request) {
        if (
            request.method() !== 'POST'
            || !request.url().startsWith('https://studio.youtube.com/youtubei/')
        ) return;

        let body;
        try {
            body = request.postDataJSON();
        } catch {
            return;
        }
        if (!body?.context) return;

        let headers;
        try {
            headers = selectStudioHeaders(await request.allHeaders());
        } catch {
            return;
        }
        if (!headers.authorization) return;

        this.session = {
            capturedAt: Date.now(),
            context: body.context,
            delegationContext: body.delegationContext,
            headers,
        };
        for (const resolve of this.waiters) resolve(this.session);
        this.waiters.clear();
    }

    async waitUntilReady(timeoutMs = 10_000) {
        if (this.session) return this.session;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.waiters.delete(done);
                reject(new StudioApiError(
                    'Chưa lấy được phiên đăng nhập YouTube Studio. Hãy mở chế độ đăng nhập và tải lại trang Studio.',
                    {
                        code: 'AUTH_SESSION_NOT_READY',
                        stage: 'authentication',
                        retryable: false,
                    },
                ));
            }, timeoutMs);
            const done = session => {
                clearTimeout(timer);
                resolve(session);
            };
            this.waiters.add(done);
        });
    }

    async updateProducts(videoId, shoppingItemIds) {
        const session = await this.waitUntilReady();
        const operation = shoppingItemIds.length
            ? 'Add YouTube product'
            : 'Remove YouTube products';
        const body = buildProductSelectionBody({
            context: session.context,
            delegationContext: session.delegationContext,
            videoId,
            shoppingItemIds,
        });
        try {
            const response = await this.page.request.post(METADATA_UPDATE_URL, {
                headers: session.headers,
                data: body,
                timeout: 10_000,
            });
            return await parseStudioResponse(response, operation);
        } catch (error) {
            throw wrapStudioError(error, operation);
        }
    }

    async searchProductsRaw(videoId, productUrl) {
        const session = await this.waitUntilReady();
        const body = buildProductSearchBody({
            context: session.context,
            delegationContext: session.delegationContext,
            videoId,
            productUrl,
        });
        const operation = 'Search YouTube Shopping product';
        try {
            const response = await this.page.request.post(SHOPPING_SETTINGS_URL, {
                headers: session.headers,
                data: body,
                timeout: 10_000,
            });
            return await parseStudioResponse(response, operation);
        } catch (error) {
            throw wrapStudioError(error, operation);
        }
    }

    async searchProduct(videoId, productUrl) {
        const result = await this.searchProductsRaw(videoId, productUrl);
        return {
            shoppingItemId: findProductClusterMid(result),
            response: result,
        };
    }
}

export { METADATA_UPDATE_URL, SHOPPING_SETTINGS_URL };
