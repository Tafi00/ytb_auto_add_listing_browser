import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildOfferGroupBody,
    buildProductSearchBody,
    buildProductSelectionBody,
    extractMarketplaceListingIdentity,
    extractShoppingItemId,
    findExactOfferIndex,
    findProductClusterMid,
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
