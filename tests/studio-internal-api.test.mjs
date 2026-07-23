import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildProductSearchBody,
    buildProductSelectionBody,
    extractShoppingItemId,
    findProductClusterMid,
    parseStudioResponse,
    selectStudioHeaders,
    StudioApiError,
} from '../src/studio-internal-api.js';

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
        'Content-Length': '999',
    });
    assert.equal(selected.authorization, 'SAPISIDHASH redacted');
    assert.equal(selected['x-goog-authuser'], '0');
    assert.equal(selected.cookie, undefined);
    assert.equal(selected['content-length'], undefined);
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
