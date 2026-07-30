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
    'x-youtube-delegation-context',
    'x-youtube-page-cl',
    'x-youtube-page-label',
    'x-youtube-time-zone',
    'x-youtube-utc-offset',
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

export function extractMarketplaceListingIdentity(productUrl) {
    try {
        const url = new URL(productUrl);
        if (/lazada\./i.test(url.hostname)) {
            const match = decodeURIComponent(url.pathname)
                .match(/-i(\d+)-s(\d+)\.html/i);
            if (match) {
                return {
                    marketplace: 'lazada',
                    productId: match[1],
                    offerId: match[2],
                };
            }
        }
        if (/shopee\.vn$/i.test(url.hostname)) {
            const pathname = decodeURIComponent(url.pathname);
            const productPath = pathname.match(/\/product\/(\d+)\/(\d+)/i);
            const seoPath = pathname.match(/-i\.(\d+)\.(\d+)(?:[/?#]|$)/i);
            const openPath = pathname.match(/\/opaanlp\/(\d+)\/(\d+)(?:[/?#]|$)/i);
            const shopId = productPath?.[1] || seoPath?.[1]
                || openPath?.[1] || url.searchParams.get('shopid') || '';
            const itemId = productPath?.[2] || seoPath?.[2] || openPath?.[2]
                || url.searchParams.get('itemid') || '';
            if (/^\d+$/.test(itemId)) {
                return {
                    marketplace: 'shopee',
                    productId: String(shopId),
                    offerId: String(itemId),
                };
            }
        }
    } catch {}
    return null;
}

function cloneCacheValue(value) {
    return value == null ? value : structuredClone(value);
}

export class MarketplaceOfferCache {
    constructor({
        successTtlMs = 6 * 60 * 60_000,
        notFoundTtlMs = 15 * 60_000,
        maxEntries = 1_000,
        now = () => Date.now(),
    } = {}) {
        this.successTtlMs = successTtlMs;
        this.notFoundTtlMs = notFoundTtlMs;
        this.maxEntries = maxEntries;
        this.now = now;
        this.entries = new Map();
    }

    cacheKey(productUrl) {
        const identity = extractMarketplaceListingIdentity(productUrl);
        if (!identity) return null;
        return `${identity.marketplace}:${identity.productId}:${identity.offerId}`;
    }

    get(productUrl) {
        const key = this.cacheKey(productUrl);
        if (!key) return null;
        const entry = this.entries.get(key);
        if (!entry) return null;
        if (entry.expiresAt <= this.now()) {
            this.entries.delete(key);
            return null;
        }
        // Refresh insertion order so the size cap behaves as a small LRU cache.
        this.entries.delete(key);
        this.entries.set(key, entry);
        return {
            status: entry.status,
            offer: cloneCacheValue(entry.offer),
        };
    }

    setFound(productUrl, offer) {
        this.set(productUrl, {
            status: 'found',
            offer: cloneCacheValue(offer),
            expiresAt: this.now() + this.successTtlMs,
        });
    }

    setNotFound(productUrl) {
        this.set(productUrl, {
            status: 'not_found',
            offer: null,
            expiresAt: this.now() + this.notFoundTtlMs,
        });
    }

    set(productUrl, entry) {
        const key = this.cacheKey(productUrl);
        if (!key) return;
        this.entries.delete(key);
        this.entries.set(key, entry);
        while (this.entries.size > this.maxEntries) {
            this.entries.delete(this.entries.keys().next().value);
        }
    }
}

export function findExactOfferIndex(offers, productUrl) {
    const identity = extractMarketplaceListingIdentity(productUrl);
    if (!identity) return -1;
    return (offers || []).findIndex(offer => {
        const rawOfferId = String(offer?.itemId?.rawMerchantOfferId || '');
        if (rawOfferId === identity.offerId) return true;
        const targetIdentity = extractMarketplaceListingIdentity(offer?.targetUrl || '');
        return targetIdentity?.productId === identity.productId
            && targetIdentity?.offerId === identity.offerId;
    });
}

function normalizeProductText(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/đ/g, 'd')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function productTitleSimilarity(expectedTitle, candidateTitle) {
    const expected = normalizeProductText(expectedTitle);
    const candidate = normalizeProductText(candidateTitle);
    if (!expected || !candidate) return 0;
    if (expected === candidate) return 1;

    const expectedTokens = new Set(expected.split(' ').filter(token => token.length > 1));
    const candidateTokens = new Set(candidate.split(' ').filter(token => token.length > 1));
    if (expectedTokens.size === 0 || candidateTokens.size === 0) return 0;

    let intersection = 0;
    for (const token of expectedTokens) {
        if (candidateTokens.has(token)) intersection++;
    }
    const expectedCoverage = intersection / expectedTokens.size;
    const candidateCoverage = intersection / candidateTokens.size;
    const union = expectedTokens.size + candidateTokens.size - intersection;
    const jaccard = union > 0 ? intersection / union : 0;
    return expectedCoverage * 0.5 + candidateCoverage * 0.25 + jaccard * 0.25;
}

function parseProductPrice(value, seen = new Set()) {
    if (value == null) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') {
        const digits = value.replace(/[^\d]/g, '');
        return digits ? Number(digits) : null;
    }
    if (typeof value !== 'object' || seen.has(value)) return null;
    seen.add(value);

    for (const key of ['amountMicros', 'priceMicros', 'micros']) {
        const micros = Number(value[key]);
        if (Number.isFinite(micros) && micros > 0) return micros / 1_000_000;
    }
    for (const key of ['amount', 'price', 'value', 'lowPrice', 'highPrice']) {
        const parsed = parseProductPrice(value[key], seen);
        if (parsed != null) return parsed;
    }
    return null;
}

function findTextField(node, keys, seen = new Set()) {
    if (!node || typeof node !== 'object' || seen.has(node)) return '';
    seen.add(node);
    for (const key of keys) {
        if (typeof node[key] === 'string' && node[key].trim()) return node[key].trim();
    }
    for (const child of Object.values(node)) {
        const found = findTextField(child, keys, seen);
        if (found) return found;
    }
    return '';
}

export function findBestContentMatch(items, expectedInfo, productUrl) {
    const expectedTitle = expectedInfo?.title || '';
    if (!expectedTitle) return null;

    const expectedIdentity = extractMarketplaceListingIdentity(productUrl);
    const expectedPrice = parseProductPrice(expectedInfo?.price);
    const expectedSeller = normalizeProductText(expectedInfo?.seller);
    const expectedBrand = normalizeProductText(
        typeof expectedInfo?.brand === 'string'
            ? expectedInfo.brand
            : expectedInfo?.brand?.name,
    );
    const candidates = [];

    for (let index = 0; index < (items || []).length; index++) {
        const item = items[index];
        if (!item?.title || item?.itemId?.gpcIdWithMerchantScope) continue;

        const targetIdentity = extractMarketplaceListingIdentity(item.targetUrl || '');
        if (
            expectedIdentity
            && targetIdentity
            && targetIdentity.marketplace !== expectedIdentity.marketplace
        ) continue;

        const titleScore = productTitleSimilarity(expectedTitle, item.title);
        const candidatePrice = parseProductPrice(item.price);
        const hasComparablePrice = expectedPrice != null && candidatePrice != null;
        const priceDiffRatio = hasComparablePrice
            ? Math.abs(candidatePrice - expectedPrice) / Math.max(expectedPrice, 1)
            : null;
        const candidateSeller = normalizeProductText(findTextField(item, [
            'sellerName',
            'merchantName',
            'merchantDisplayName',
            'storeName',
        ]));
        const candidateBrand = normalizeProductText(findTextField(item, [
            'brandName',
            'brand',
        ]));
        const sellerMatch = Boolean(
            expectedSeller
            && candidateSeller
            && (expectedSeller.includes(candidateSeller) || candidateSeller.includes(expectedSeller)),
        );
        const brandMatch = Boolean(
            expectedBrand
            && candidateBrand
            && (expectedBrand.includes(candidateBrand) || candidateBrand.includes(expectedBrand)),
        );

        const strongPriceMatch = priceDiffRatio != null && priceDiffRatio <= 0.08;
        const eligible = hasComparablePrice
            ? titleScore >= 0.68 && strongPriceMatch
            : titleScore >= 0.9;
        if (!eligible) continue;

        const priceScore = priceDiffRatio == null
            ? 0
            : Math.max(0, 1 - priceDiffRatio / 0.08);
        const score = titleScore * 0.72
            + priceScore * 0.22
            + (sellerMatch ? 0.04 : 0)
            + (brandMatch ? 0.02 : 0);
        candidates.push({
            item,
            index,
            score,
            titleScore,
            priceDiffRatio,
            sellerMatch,
            brandMatch,
        });
    }

    candidates.sort((a, b) => b.score - a.score || b.titleScore - a.titleScore);
    return candidates[0] || null;
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

export function buildProductSearchBody({
    context,
    delegationContext,
    videoId,
    productUrl,
    maxResults,
}) {
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
                firstPartyQueryConfig: {},
                thirdPartyQueryConfig: {},
                productSourceRestrict: 'PRODUCT_SOURCE_ALL',
                ...(Number.isInteger(maxResults) && maxResults > 0
                    ? { maxResults }
                    : {}),
            },
            tagCreationContext: {
                creatorTagging: {
                    taggingTool: 'TAGGING_TOOL_PRODUCT_PICKER',
                },
            },
        },
    };
}

export function buildOfferGroupBody({
    context,
    delegationContext,
    videoId,
    offerGroupItem,
}) {
    const groupId = offerGroupItem?.itemId?.gpcIdWithMerchantScope;
    if (!groupId?.gpcId) throw new Error('A GPC offer group is required');
    return {
        context,
        ...(delegationContext ? { delegationContext } : {}),
        getOffersForOfferGroupRequest: {
            shoppingDescriptor: {
                editDescriptor: { externalVideoId: videoId },
            },
            offerGroupId: {
                gpcIdWithMerchantScope: groupId,
            },
            tagCreationContext: offerGroupItem?.itemId?.itemMetadata
                ?.tagCreationContext || {
                creatorTagging: {
                    urlSearch: true,
                    taggingTool: 'TAGGING_TOOL_PRODUCT_PICKER',
                    clientInterface: 'CLIENT_INTERFACE_WEB_CREATOR',
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
        const payload = JSON.parse(text);
        const challengeType = payload?.responseContext
            ?.webResponseContextExtensionData?.challenge?.type;
        if (challengeType) {
            throw new StudioApiError(
                'YouTube Studio yêu cầu làm mới xác thực ghi. Worker sẽ tự khởi tạo lại ở lần xử lý tiếp theo.',
                {
                    code: 'AUTH_CHALLENGE',
                    stage: 'authentication',
                    retryable: true,
                    status,
                },
            );
        }
        return payload;
    } catch (error) {
        if (error instanceof StudioApiError) throw error;
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
        this.writeSession = null;
        this.waiters = new Set();
        this.writeWaiters = new Set();
        this.onRequest = request => void this.captureRequest(request);
    }

    start() {
        this.page.on('request', this.onRequest);
        return this;
    }

    stop() {
        this.page.off('request', this.onRequest);
        this.waiters.clear();
        this.writeWaiters.clear();
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
        let headers;
        try {
            headers = selectStudioHeaders(await request.allHeaders());
        } catch {
            headers = {};
        }

        const isWriteRequest = request.url().includes('/video_manager/metadata_update');
        const writeHeaders = headers.authorization ? headers : this.session?.headers;
        if (isWriteRequest && writeHeaders) {
            this.writeSession = {
                capturedAt: Date.now(),
                body: structuredClone(body),
                headers: writeHeaders,
            };
            if (this.writeSession.body?.attestationResponseData) {
                for (const resolve of this.writeWaiters) resolve(this.writeSession);
                this.writeWaiters.clear();
            }
        }

        if (!body?.context || !headers.authorization) return;

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

    hasWriteSession(maxAgeMs = 5 * 60_000) {
        return Boolean(
            this.writeSession
            && Date.now() - this.writeSession.capturedAt < maxAgeMs
            && this.writeSession.body?.attestationResponseData,
        );
    }

    async waitForWriteSession(timeoutMs = 10_000) {
        if (this.hasWriteSession()) return this.writeSession;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.writeWaiters.delete(done);
                reject(new StudioApiError(
                    'Không lấy được xác thực ghi từ YouTube Studio sau khi lưu.',
                    {
                        code: 'WRITE_SESSION_NOT_READY',
                        stage: 'authentication',
                        retryable: true,
                    },
                ));
            }, timeoutMs);
            const done = session => {
                clearTimeout(timer);
                resolve(session);
            };
            this.writeWaiters.add(done);
        });
    }

    getWriteShoppingItemId() {
        const items = this.writeSession?.body?.productsSelection?.shoppingItemIds || [];
        for (const item of items) {
            const value = typeof item === 'object'
                ? item?.rawMerchantOfferId || item?.productClusterMid
                : item;
            if (/^\d+$/.test(String(value || ''))) return String(value);
            try {
                return findProductClusterMid(item);
            } catch {}
        }
        return null;
    }

    invalidateWriteSession() {
        this.writeSession = null;
        this.writeWaiters.clear();
    }

    async updateProducts(videoId, shoppingItemIds) {
        const session = await this.waitUntilReady();
        if (!this.hasWriteSession()) {
            throw new StudioApiError(
                'Chưa có phiên xác thực ghi của YouTube Studio.',
                {
                    code: 'WRITE_SESSION_NOT_READY',
                    stage: 'authentication',
                    retryable: true,
                },
            );
        }
        const operation = shoppingItemIds.length
            ? 'Add YouTube product'
            : 'Remove YouTube products';
        const selection = buildProductSelectionBody({
            context: session.context,
            delegationContext: session.delegationContext,
            videoId,
            shoppingItemIds,
        }).productsSelection;
        const body = structuredClone(this.writeSession.body);
        body.encryptedVideoId = videoId;
        body.productsSelection = selection;
        try {
            const response = await this.page.request.post(METADATA_UPDATE_URL, {
                headers: this.writeSession.headers,
                data: body,
                timeout: 10_000,
            });
            return await parseStudioResponse(response, operation);
        } catch (error) {
            if (error?.code === 'AUTH_CHALLENGE') this.writeSession = null;
            throw wrapStudioError(error, operation);
        }
    }

    async searchProductsRaw(videoId, productUrl, options = {}) {
        const session = await this.waitUntilReady();
        const body = buildProductSearchBody({
            context: session.context,
            delegationContext: session.delegationContext,
            videoId,
            productUrl,
            maxResults: options.maxResults,
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

    async getOffersForOfferGroupRaw(videoId, offerGroupItem) {
        const session = await this.waitUntilReady();
        const body = buildOfferGroupBody({
            context: session.context,
            delegationContext: session.delegationContext,
            videoId,
            offerGroupItem,
        });
        const operation = 'Get YouTube Shopping offers';
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
}

export { METADATA_UPDATE_URL, SHOPPING_SETTINGS_URL };
