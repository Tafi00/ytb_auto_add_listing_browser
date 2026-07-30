import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeRelayJobError } from '../src/relay-response.js';
import { formatApiError, readJsonResponse } from '../web/src/response.js';

test('formats structured worker errors for users', () => {
    assert.equal(
        formatApiError({ code: 'PRODUCT_NOT_FOUND', error: 'raw' }),
        'Sản phẩm này không gắn giỏ được',
    );
    assert.equal(
        formatApiError({
            code: 'AFFILIATE_LISTING_MISMATCH',
            error: 'YouTube trả về listing khác.',
        }),
        'Sản phẩm này không gắn giỏ được',
    );
    assert.match(
        formatApiError({ code: 'AUTH_REQUIRED', error: 'raw' }),
        /đăng nhập lại/,
    );
    assert.match(
        formatApiError({
            code: 'AFFILIATE_NOT_READY',
            cleanupSucceeded: false,
        }),
        /chưa xác nhận được việc gỡ sản phẩm/,
    );
});

test('relay hides listing mismatch details from the public response', () => {
    const error = Object.assign(
        new Error('YouTube trả về listing 41672767265 thay vì 24847812914.'),
        {
            code: 'AFFILIATE_LISTING_MISMATCH',
            stage: 'affiliate-validation',
            retryable: true,
        },
    );
    const response = normalizeRelayJobError(error, {
        knownWorkerError: true,
    });

    assert.deepEqual(response, {
        payload: {
            error: 'Sản phẩm này không gắn giỏ được',
            code: 'PRODUCT_NOT_FOUND',
            stage: 'product-selection',
            retryable: false,
        },
        status: 422,
    });
});

test('relay converts old mobile exact-offer errors into product unavailable', () => {
    const result = normalizeRelayJobError({
        code: 'COLLECTION_API_ERROR',
        stage: 'mobile-api',
        retryable: true,
        message: (
            'YouTube Shopping không trả đúng offer ID 11350223102 '
            + 'cho URL này'
        ),
    }, { knownWorkerError: true });

    assert.equal(result.status, 422);
    assert.deepEqual(result.payload, {
        error: 'Sản phẩm này không gắn giỏ được',
        code: 'PRODUCT_NOT_FOUND',
        stage: 'product-selection',
        retryable: false,
    });
});

test('turns a plain Bad Gateway page into a clear relay error', async () => {
    const response = {
        status: 502,
        text: async () => 'Bad Gateway',
    };
    await assert.rejects(
        () => readJsonResponse(response),
        /Relay tạm thời mất kết nối/,
    );
});
