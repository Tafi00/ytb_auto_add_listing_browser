import assert from 'node:assert/strict';
import test from 'node:test';

import { formatApiError, readJsonResponse } from '../web/src/response.js';

test('formats structured worker errors for users', () => {
    assert.equal(
        formatApiError({ code: 'PRODUCT_NOT_FOUND', error: 'raw' }),
        'Sản phẩm này không gắn giỏ được.',
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
