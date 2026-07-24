const { test } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const { createVerifyLocalSession } = require('./localSession');

const SECRET = 'test-secret-do-not-use-in-prod';

function mockRes() {
    const res = { statusCode: 200 };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = body; return res; };
    return res;
}

test('valid token passes and extracts the matricule', async () => {
    const middleware = createVerifyLocalSession({ secret: SECRET });
    const token = jwt.sign({ sub: 'M001' }, SECRET, { expiresIn: '1h' });
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes();
    let nextCalled = false;

    middleware(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, true);
    assert.equal(req.matricule, 'M001');
});

test('missing bearer token is rejected with 401', () => {
    const middleware = createVerifyLocalSession({ secret: SECRET });
    const req = { headers: {} };
    const res = mockRes();

    middleware(req, res, () => assert.fail('next should not be called'));

    assert.equal(res.statusCode, 401);
});

test('malformed token is rejected with 401', () => {
    const middleware = createVerifyLocalSession({ secret: SECRET });
    const req = { headers: { authorization: 'Bearer not-a-jwt' } };
    const res = mockRes();

    middleware(req, res, () => assert.fail('next should not be called'));

    assert.equal(res.statusCode, 401);
});

test('token signed with a different secret is rejected with 401', () => {
    const middleware = createVerifyLocalSession({ secret: SECRET });
    const token = jwt.sign({ sub: 'M001' }, 'someone-elses-secret', { expiresIn: '1h' });
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes();

    middleware(req, res, () => assert.fail('next should not be called'));

    assert.equal(res.statusCode, 401);
});

test('expired token is rejected with 401', () => {
    const middleware = createVerifyLocalSession({ secret: SECRET });
    const token = jwt.sign({ sub: 'M001' }, SECRET, { expiresIn: '-1h' });
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes();

    middleware(req, res, () => assert.fail('next should not be called'));

    assert.equal(res.statusCode, 401);
});

test('missing configured secret is rejected with 500', () => {
    const middleware = createVerifyLocalSession({ secret: undefined });
    const req = { headers: { authorization: 'Bearer whatever' } };
    const res = mockRes();

    middleware(req, res, () => assert.fail('next should not be called'));

    assert.equal(res.statusCode, 500);
});
