import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildOfferGroupBody,
    buildProductSearchBody,
    buildProductSelectionBody,
    extractMarketplaceListingIdentity,
    extractShoppingItemId,
    findBestContentMatch,
    findExactOfferIndex,
    findProductClusterMid,
    MarketplaceOfferCache,
    parseStudioResponse,
    selectStudioHeaders,
    StudioApiError,
    StudioInternalApi,
} from '../src/studio-internal-api.js';

test('identifies exact Shopee listing and offer option', () => {
    const productUrl = 'https://shopee.vn/product/360635088/43700187569';
    assert.deepEqual(extractMarketplaceListingIdentity(productUrl), {
        marketplace: 'shopee',
        productId: '360635088',
        offerId: '43700187569',
    });
    assert.deepEqual(
        extractMarketplaceListingIdentity(
            'https://shopee.vn/example-i.360635088.43700187569',
        ),
        {
            marketplace: 'shopee',
            productId: '360635088',
            offerId: '43700187569',
        },
    );
    assert.deepEqual(
        extractMarketplaceListingIdentity(
            'https://shopee.vn/opaanlp/1205404510/53611982297',
        ),
        {
            marketplace: 'shopee',
            productId: '1205404510',
            offerId: '53611982297',
        },
    );
    assert.equal(findExactOfferIndex([
        { itemId: { rawMerchantOfferId: '111' } },
        { itemId: { rawMerchantOfferId: '43700187569' } },
    ], productUrl), 1);
});

test('accepts a high-confidence same-marketplace title and price fallback', () => {
    const productUrl = 'https://shopee.vn/product/1668757188/41429607892';
    const result = findBestContentMatch([
        {
            title: 'Kem dưỡng ẩm Embryolisse Lait Creme Concentre 75ml',
            price: { amountMicros: '660000000000' },
            targetUrl: 'https://shopee.vn/product/659308161/41161480256',
            itemId: {
                rawMerchantOfferId: '41161480256',
                merchantIdentifier: { merchantId: '123' },
            },
        },
        {
            title: 'Đèn bàn học LED cao cấp',
            price: { amountMicros: '660000000000' },
            targetUrl: 'https://shopee.vn/product/1/2',
            itemId: {
                rawMerchantOfferId: '2',
                merchantIdentifier: { merchantId: '456' },
            },
        },
    ], {
        title: 'Sữa Dưỡng Ẩm Siêu Phục Hồi Embryolisse Lait Creme Concentre 75ml',
        price: '660.000 ₫',
    }, productUrl);

    assert.equal(result.item.itemId.rawMerchantOfferId, '41161480256');
    assert.ok(result.titleScore >= 0.68);
    assert.equal(result.priceDiffRatio, 0);
});

test('rejects content fallbacks with a weak title or materially different price', () => {
    const productUrl = 'https://shopee.vn/product/1668757188/41429607892';
    const weakTitle = findBestContentMatch([{
        title: 'Kem chống nắng dưỡng da 75ml',
        price: '660.000 ₫',
        targetUrl: 'https://shopee.vn/product/1/2',
        itemId: { rawMerchantOfferId: '2' },
    }], {
        title: 'Sữa Dưỡng Ẩm Embryolisse Lait Creme Concentre 75ml',
        price: '660.000 ₫',
    }, productUrl);
    assert.equal(weakTitle, null);

    const wrongPrice = findBestContentMatch([{
        title: 'Sữa Dưỡng Ẩm Embryolisse Lait Creme Concentre 75ml',
        price: '850.000 ₫',
        targetUrl: 'https://shopee.vn/product/1/3',
        itemId: { rawMerchantOfferId: '3' },
    }], {
        title: 'Sữa Dưỡng Ẩm Embryolisse Lait Creme Concentre 75ml',
        price: '660.000 ₫',
    }, productUrl);
    assert.equal(wrongPrice, null);
});

test('captures a delayed metadata write using existing authenticated headers', async () => {
    const page = { on() {}, off() {} };
    const api = new StudioInternalApi(page);
    api.session = {
        capturedAt: Date.now(),
        context: { client: {} },
        headers: { authorization: 'SAPISIDHASH retained' },
    };
    const writeReady = api.waitForWriteSession(1_000);
    await api.captureRequest({
        method: () => 'POST',
        url: () => 'https://studio.youtube.com/youtubei/v1/video_manager/metadata_update?alt=json',
        postDataJSON: () => ({
            encryptedVideoId: 'video-id',
            attestationResponseData: { challenge: 'signed' },
            productsSelection: { shoppingItemIds: [] },
        }),
        allHeaders: async () => ({ 'content-type': 'application/json' }),
    });
    const captured = await writeReady;
    assert.equal(captured.headers.authorization, 'SAPISIDHASH retained');
    assert.equal(api.hasWriteSession(), true);
});

test('builds an offer-group API payload from a GPC search result', () => {
    const body = buildOfferGroupBody({
        context: { client: { clientName: 62 } },
        videoId: 'VNa64icfGAg',
        offerGroupItem: {
            itemId: {
                gpcIdWithMerchantScope: {
                    gpcId: '6853547794971194620',
                    merchantConstraints: ['116709387'],
                },
                itemMetadata: {
                    tagCreationContext: {
                        creatorTagging: { urlSearch: true },
                    },
                },
            },
        },
    });
    assert.deepEqual(
        body.getOffersForOfferGroupRequest.offerGroupId,
        {
            gpcIdWithMerchantScope: {
                gpcId: '6853547794971194620',
                merchantConstraints: ['116709387'],
            },
        },
    );
    assert.equal(
        body.getOffersForOfferGroupRequest
            .tagCreationContext.creatorTagging.urlSearch,
        true,
    );
});

test('extracts item id from YouTube VE sibling key', () => {
    assert.equal(
        extractShoppingItemId('6853547794971194620:116709387'),
        '6853547794971194620',
    );
    assert.throws(() => extractShoppingItemId('bad-key'), /Invalid YouTube Shopping/);
});

test('builds add and remove metadata payloads', () => {
    const add = buildProductSelectionBody({
        context: { client: { clientName: 62 } },
        videoId: 'VNa64icfGAg',
        shoppingItemIds: ['6853547794971194620', '6853547794971194620'],
    });
    assert.deepEqual(add.productsSelection, {
        shoppingItemIds: [{ productClusterMid: '6853547794971194620' }],
        youtubeAutomatedIds: [],
        productStickerMetadata: { autoStickerMetadata: {} },
        enableGlobalProductStickerFeature: true,
    });

    const remove = buildProductSelectionBody({
        context: { client: {} },
        videoId: 'VNa64icfGAg',
        shoppingItemIds: [],
    });
    assert.deepEqual(remove.productsSelection.shoppingItemIds, []);
});

test('preserves the complete exact merchant offer payload', () => {
    const exactItemId = {
        rawMerchantOfferId: '24847812914',
        itemType: 'SHOPPING_ITEM_TYPE_MERCHANT_SKU',
        merchantIdentifier: { merchantId: '5615885343' },
        itemMetadata: {
            offerVersionId: 'offer-version',
            offerDocid: '4585059275409005493',
            tagCreationContext: {
                creatorTagging: {
                    urlSearch: true,
                    taggingTool: 'TAGGING_TOOL_PRODUCT_PICKER',
                    clientInterface: 'CLIENT_INTERFACE_WEB_CREATOR',
                    variantDrilldown: true,
                },
            },
            parentOfferGroupId: {
                gpcIdWithMerchantScope: {
                    gpcId: '14827274982343255922',
                    merchantConstraints: ['115784110'],
                },
            },
        },
        loggingMetadata: { productSearchNonce: '79079066492311036' },
    };
    const body = buildProductSelectionBody({
        context: { client: { clientName: 62 } },
        videoId: 'vMLFUXBnbvY',
        shoppingItemIds: [exactItemId],
    });

    assert.deepEqual(
        body.productsSelection.shoppingItemIds,
        [exactItemId],
    );
});

test('builds a URL product search payload', () => {
    const body = buildProductSearchBody({
        context: { client: { clientName: 62 } },
        delegationContext: { roleType: 'CREATOR_CHANNEL_ROLE_TYPE_OWNER' },
        videoId: 'VNa64icfGAg',
        productUrl: 'https://www.lazada.vn/products/example-i1-s2.html',
    });
    assert.deepEqual(body.searchShoppingProductsRequest, {
        shoppingDescriptor: {
            editDescriptor: { externalVideoId: 'VNa64icfGAg' },
        },
        searchQuery: {
            rawQuery: 'https://www.lazada.vn/products/example-i1-s2.html',
            firstPartyQueryConfig: {},
            thirdPartyQueryConfig: {},
            productSourceRestrict: 'PRODUCT_SOURCE_ALL',
        },
        tagCreationContext: {
            creatorTagging: {
                taggingTool: 'TAGGING_TOOL_PRODUCT_PICKER',
            },
        },
    });
});

test('builds an expanded product search payload only when requested', () => {
    const body = buildProductSearchBody({
        context: { client: { clientName: 62 } },
        videoId: 'VNa64icfGAg',
        productUrl: 'Kem dưỡng ẩm Embryolisse',
        maxResults: 200,
    });
    assert.equal(
        body.searchShoppingProductsRequest.searchQuery.maxResults,
        200,
    );
});

test('caches exact offers and temporary catalog misses by listing identity', () => {
    let now = 1_000;
    const cache = new MarketplaceOfferCache({
        successTtlMs: 1_000,
        notFoundTtlMs: 100,
        now: () => now,
    });
    const url = 'https://shopee.vn/product/1668757188/41429607892';
    const offer = {
        itemId: {
            rawMerchantOfferId: '41429607892',
            merchantIdentifier: { merchantId: '123' },
        },
    };

    cache.setFound(url, offer);
    offer.itemId.rawMerchantOfferId = 'changed';
    assert.equal(cache.get(url).offer.itemId.rawMerchantOfferId, '41429607892');
    now += 1_001;
    assert.equal(cache.get(url), null);

    cache.setNotFound(url);
    assert.deepEqual(cache.get(url), { status: 'not_found', offer: null });
    now += 101;
    assert.equal(cache.get(url), null);
});

test('finds a product cluster id in nested search results', () => {
    assert.equal(
        findProductClusterMid({
            results: [{ itemId: { productClusterMid: '6853547794971194620' } }],
        }),
        '6853547794971194620',
    );
    assert.equal(
        findProductClusterMid({ tracking: { veSiblingKey: '6853547794971194620:116709387' } }),
        '6853547794971194620',
    );
    assert.equal(
        findProductClusterMid({
            itemId: {
                gpcIdWithMerchantScope: {
                    gpcId: '6853547794971194620',
                    merchantConstraints: ['116709387'],
                },
            },
        }),
        '6853547794971194620',
    );
    assert.throws(
        () => findProductClusterMid({ results: [] }),
        error => error instanceof StudioApiError && error.code === 'PRODUCT_NOT_FOUND',
    );
});

test('does not forward cookies or unrelated headers', () => {
    const selected = selectStudioHeaders({
        Authorization: 'SAPISIDHASH redacted',
        Cookie: 'must-not-leak',
        'X-Goog-AuthUser': '0',
        'X-YouTube-Delegation-Context': 'delegation-token',
        'Content-Length': '999',
    });
    assert.equal(selected.authorization, 'SAPISIDHASH redacted');
    assert.equal(selected['x-goog-authuser'], '0');
    assert.equal(selected['x-youtube-delegation-context'], 'delegation-token');
    assert.equal(selected.cookie, undefined);
    assert.equal(selected['content-length'], undefined);
});

test('treats an authentication challenge inside HTTP 200 as an error', async () => {
    const response = {
        ok: () => true,
        status: () => 200,
        text: async () => JSON.stringify({
            responseContext: {
                webResponseContextExtensionData: {
                    challenge: { type: 'CHALLENGE_PROMPT_TYPE_AUTHENTICATE' },
                },
            },
        }),
    };
    await assert.rejects(
        () => parseStudioResponse(response, 'Add YouTube product'),
        error => error instanceof StudioApiError
            && error.code === 'AUTH_CHALLENGE'
            && error.stage === 'authentication',
    );
});

test('reports Bad Gateway text without a JSON parse exception', async () => {
    const response = {
        ok: () => false,
        status: () => 502,
        text: async () => 'Bad Gateway',
    };
    await assert.rejects(async () => {
        try {
            await parseStudioResponse(response, 'Add YouTube product');
        } catch (error) {
            assert.ok(error instanceof StudioApiError);
            assert.equal(error.code, 'YOUTUBE_UPSTREAM_ERROR');
            assert.equal(error.stage, 'youtube-api');
            assert.equal(error.retryable, true);
            throw error;
        }
    }, /HTTP 502: Bad Gateway/);
});
