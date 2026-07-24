const { test } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const selfPointageRouter = require('./selfPointage');
const mailer = require('../services/mailer');

const JWT_SECRET = 'test-secret-do-not-use-in-prod';

// Pulls out the actual handler function for a given method+path, bypassing
// any auth middleware on the route (verifyLocalSession is tested in
// isolation in middleware/localSession.test.js). Here we test the business
// logic (PIN lifecycle, lockout, employee resolution, punch guard) as if
// a request already carries a resolved req.matricule where relevant.
function getRouteHandler(router, method, path) {
    const layer = router.stack.find(l => l.route && l.route.path === path && l.route.methods[method]);
    if (!layer) throw new Error(`no ${method.toUpperCase()} ${path} route found`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
}

function mockRes() {
    const res = { statusCode: 200 };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = body; return res; };
    return res;
}

function makeHrPool(employeesByMatricule) {
    return {
        query: async (sql, params) => {
            assert.match(sql, /FROM employees/);
            const [matricule] = params;
            const row = employeesByMatricule[matricule];
            return { rows: row ? [row] : [] };
        },
    };
}

function makeAttendancePool({ employeesByMatricule, dailyRows = {}, credentialsByMatricule = {}, pinTokensByToken = {} }) {
    const daily = { ...dailyRows };
    const credentials = { ...credentialsByMatricule };
    const pinTokens = { ...pinTokensByToken };
    let nextTokenId = 1000;
    const calls = { connectCount: 0, inserts: [] };

    const directQuery = async (sql, params) => {
        if (sql.includes('CREATE TABLE')) return { rows: [] };

        if (sql.includes('INSERT INTO public.self_pointage_pin_tokens')) {
            const [matricule, token, expiresAt] = params;
            const row = { id: nextTokenId++, matricule, token, expires_at: expiresAt, used_at: null };
            pinTokens[token] = row;
            return { rows: [row] };
        }

        if (sql.includes('SELECT * FROM public.self_pointage_pin_tokens')) {
            const [token] = params;
            const row = pinTokens[token];
            return { rows: row ? [row] : [] };
        }

        if (sql.includes('UPDATE public.self_pointage_pin_tokens')) {
            const [id] = params;
            const row = Object.values(pinTokens).find(r => r.id === id);
            if (row) row.used_at = new Date();
            return { rows: row ? [row] : [] };
        }

        if (sql.includes('INSERT INTO public.self_pointage_credentials')) {
            const [matricule, pinHash] = params;
            credentials[matricule] = { pin_hash: pinHash, failed_attempts: 0, locked_until: null };
            return { rows: [] };
        }

        if (sql.includes('SELECT * FROM public.self_pointage_credentials')) {
            const [matricule] = params;
            const row = credentials[matricule];
            return { rows: row ? [{ matricule, ...row }] : [] };
        }

        if (sql.includes('UPDATE public.self_pointage_credentials')) {
            const [matricule] = params;
            const row = credentials[matricule] || { pin_hash: null, failed_attempts: 0, locked_until: null };
            if (sql.includes('failed_attempts = $2')) {
                const [, failedAttempts, lockedUntil] = params;
                row.failed_attempts = failedAttempts;
                row.locked_until = lockedUntil;
            } else {
                row.failed_attempts = 0;
                row.locked_until = null;
            }
            credentials[matricule] = row;
            return { rows: [] };
        }

        if (sql.includes('FROM public.employees')) {
            const [matricule] = params;
            const row = employeesByMatricule[matricule];
            return { rows: row ? [row] : [] };
        }

        if (sql.includes('FROM public.attendance_daily')) {
            const [uid, date] = params;
            const row = daily[`${uid}__${date}`];
            return {
                rows: row ? [{ arrivalTime: row.arrival_time || null, departureTime: row.departure_time || null }] : [],
            };
        }

        throw new Error('unexpected attendancePool.query: ' + sql);
    };

    const client = {
        query: async (sql, params) => {
            if (sql.includes('ALTER TABLE')) return { rows: [] };
            if (sql.includes('SELECT arrival_time, departure_time')) {
                const [uid, date] = params;
                const row = daily[`${uid}__${date}`];
                return { rows: row ? [row] : [] };
            }
            if (sql.includes('INSERT INTO public.attendance_daily')) {
                const [uid, matricule, pointeuseUserId, fullName, cardNo, workDate, dayName, arrivalTime, departureTime, hoursWorked, status] = params;
                const key = `${uid}__${workDate}`;
                const existing = daily[key] || {};
                const row = {
                    arrival_time: arrivalTime || existing.arrival_time || null,
                    departure_time: departureTime || existing.departure_time || null,
                };
                daily[key] = row;
                calls.inserts.push({ uid, workDate, arrivalTime, departureTime, status });
                return { rows: [{ uid, date: workDate, status, hoursWorked }] };
            }
            throw new Error('unexpected client.query: ' + sql);
        },
        release: () => {},
    };

    return {
        query: directQuery,
        connect: async () => { calls.connectCount++; return client; },
        _calls: calls,
        _daily: daily,
        _credentials: credentials,
        _pinTokens: pinTokens,
    };
}

function setupGlobals(opts) {
    global.hrPool = makeHrPool(opts.hrEmployeesByMatricule);
    global.attendancePool = makeAttendancePool(opts);
    return global.attendancePool;
}

const ACTIVE_EMPLOYEE_HR = { id: 1, matricule: 'M001', nom: 'Doe', prenom: 'Jane', adresse_mail: 'jane.doe@avocarbon.com' };
const ATT_ROW = { uid: 42, matricule: 'M001', pointeuse_user_id: '42', full_name: 'Jane Doe', card_no: 'C1' };

function stubMailer() {
    const calls = [];
    mailer.sendMail = async (opts) => { calls.push(opts); };
    return calls;
}

// ── /pin/request ─────────────────────────────────────────────────

test('POST /pin/request sends no email and gives a generic response for an unknown matricule', async () => {
    setupGlobals({ hrEmployeesByMatricule: {}, employeesByMatricule: {} });
    const mailCalls = stubMailer();
    const handler = getRouteHandler(selfPointageRouter, 'post', '/pin/request');

    const req = { body: { matricule: 'GHOST' } };
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(mailCalls.length, 0);
});

test('POST /pin/request emails a setup link for a known active matricule', async () => {
    const pool = setupGlobals({
        hrEmployeesByMatricule: { M001: ACTIVE_EMPLOYEE_HR },
        employeesByMatricule: { M001: ATT_ROW },
    });
    const mailCalls = stubMailer();
    const handler = getRouteHandler(selfPointageRouter, 'post', '/pin/request');

    const req = { body: { matricule: 'M001' } };
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(mailCalls.length, 1);
    assert.equal(mailCalls[0].to, 'jane.doe@avocarbon.com');
    assert.equal(Object.keys(pool._pinTokens).length, 1);
});

// ── /pin/token/:token ────────────────────────────────────────────

test('GET /pin/token/:token rejects an unknown token', async () => {
    setupGlobals({ hrEmployeesByMatricule: { M001: ACTIVE_EMPLOYEE_HR }, employeesByMatricule: { M001: ATT_ROW } });
    const handler = getRouteHandler(selfPointageRouter, 'get', '/pin/token/:token');

    const req = { params: { token: 'nope' } };
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.statusCode, 404);
});

test('GET /pin/token/:token rejects an expired token', async () => {
    setupGlobals({
        hrEmployeesByMatricule: { M001: ACTIVE_EMPLOYEE_HR },
        employeesByMatricule: { M001: ATT_ROW },
        pinTokensByToken: { abc: { id: 1, matricule: 'M001', token: 'abc', expires_at: new Date(Date.now() - 1000), used_at: null } },
    });
    const handler = getRouteHandler(selfPointageRouter, 'get', '/pin/token/:token');

    const req = { params: { token: 'abc' } };
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'expired');
});

test('GET /pin/token/:token returns the employee for a valid token', async () => {
    setupGlobals({
        hrEmployeesByMatricule: { M001: ACTIVE_EMPLOYEE_HR },
        employeesByMatricule: { M001: ATT_ROW },
        pinTokensByToken: { abc: { id: 1, matricule: 'M001', token: 'abc', expires_at: new Date(Date.now() + 60000), used_at: null } },
    });
    const handler = getRouteHandler(selfPointageRouter, 'get', '/pin/token/:token');

    const req = { params: { token: 'abc' } };
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.matricule, 'M001');
    assert.equal(res.body.fullName, 'Jane Doe');
});

// ── /pin/confirm ─────────────────────────────────────────────────

test('POST /pin/confirm rejects a non-6-digit pin', async () => {
    setupGlobals({
        hrEmployeesByMatricule: { M001: ACTIVE_EMPLOYEE_HR },
        employeesByMatricule: { M001: ATT_ROW },
        pinTokensByToken: { abc: { id: 1, matricule: 'M001', token: 'abc', expires_at: new Date(Date.now() + 60000), used_at: null } },
    });
    const handler = getRouteHandler(selfPointageRouter, 'post', '/pin/confirm');

    const req = { body: { token: 'abc', pin: '12345' } };
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.statusCode, 400);
});

test('POST /pin/confirm sets a verifiable PIN hash and marks the token used', async () => {
    const pool = setupGlobals({
        hrEmployeesByMatricule: { M001: ACTIVE_EMPLOYEE_HR },
        employeesByMatricule: { M001: ATT_ROW },
        pinTokensByToken: { abc: { id: 1, matricule: 'M001', token: 'abc', expires_at: new Date(Date.now() + 60000), used_at: null } },
    });
    const handler = getRouteHandler(selfPointageRouter, 'post', '/pin/confirm');

    const req = { body: { token: 'abc', pin: '135790' } };
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.ok(bcrypt.compareSync('135790', pool._credentials.M001.pin_hash));
    assert.equal(pool._pinTokens.abc.used_at !== null, true);
});

test('POST /pin/confirm rejects reusing an already-used token', async () => {
    setupGlobals({
        hrEmployeesByMatricule: { M001: ACTIVE_EMPLOYEE_HR },
        employeesByMatricule: { M001: ATT_ROW },
        pinTokensByToken: { abc: { id: 1, matricule: 'M001', token: 'abc', expires_at: new Date(Date.now() + 60000), used_at: new Date() } },
    });
    const handler = getRouteHandler(selfPointageRouter, 'post', '/pin/confirm');

    const req = { body: { token: 'abc', pin: '135790' } };
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'already_used');
});

// ── /login ───────────────────────────────────────────────────────

test('POST /login rejects a matricule with no PIN set yet', async () => {
    setupGlobals({ hrEmployeesByMatricule: { M001: ACTIVE_EMPLOYEE_HR }, employeesByMatricule: { M001: ATT_ROW } });
    process.env.SELF_POINTAGE_JWT_SECRET = JWT_SECRET;
    const handler = getRouteHandler(selfPointageRouter, 'post', '/login');

    const req = { body: { matricule: 'M001', pin: '135790' } };
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.statusCode, 404);
    assert.equal(res.body.error, 'pin_not_set');
});

test('POST /login succeeds with the correct PIN and returns a usable session token', async () => {
    const pinHash = bcrypt.hashSync('135790', 4);
    setupGlobals({
        hrEmployeesByMatricule: { M001: ACTIVE_EMPLOYEE_HR },
        employeesByMatricule: { M001: ATT_ROW },
        credentialsByMatricule: { M001: { pin_hash: pinHash, failed_attempts: 0, locked_until: null } },
    });
    process.env.SELF_POINTAGE_JWT_SECRET = JWT_SECRET;
    const handler = getRouteHandler(selfPointageRouter, 'post', '/login');

    const req = { body: { matricule: 'M001', pin: '135790' } };
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    const decoded = jwt.verify(res.body.token, JWT_SECRET);
    assert.equal(decoded.sub, 'M001');
});

test('POST /login locks the account after the max number of wrong PINs, even against the correct PIN', async () => {
    const pinHash = bcrypt.hashSync('135790', 4);
    setupGlobals({
        hrEmployeesByMatricule: { M001: ACTIVE_EMPLOYEE_HR },
        employeesByMatricule: { M001: ATT_ROW },
        credentialsByMatricule: { M001: { pin_hash: pinHash, failed_attempts: 0, locked_until: null } },
    });
    process.env.SELF_POINTAGE_JWT_SECRET = JWT_SECRET;
    const handler = getRouteHandler(selfPointageRouter, 'post', '/login');

    let res;
    for (let i = 0; i < 4; i++) {
        res = mockRes();
        await handler({ body: { matricule: 'M001', pin: '000000' } }, res);
        assert.equal(res.statusCode, 401);
    }

    // 5th wrong attempt (default SELF_POINTAGE_MAX_FAILED_ATTEMPTS=5) locks the account.
    res = mockRes();
    await handler({ body: { matricule: 'M001', pin: '000000' } }, res);
    assert.equal(res.statusCode, 423);

    // Even the correct PIN is rejected while locked.
    res = mockRes();
    await handler({ body: { matricule: 'M001', pin: '135790' } }, res);
    assert.equal(res.statusCode, 423);
});

// ── /me and /punch (business logic, auth middleware tested separately) ──

test('GET /me returns 404 for a matricule with no matching active employee', async () => {
    setupGlobals({ hrEmployeesByMatricule: {}, employeesByMatricule: {} });
    const handler = getRouteHandler(selfPointageRouter, 'get', '/me');

    const req = { matricule: 'UNKNOWN' };
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.statusCode, 404);
});

test('POST /punch records a first arrival punch and rejects a same-day repeat', async () => {
    const pool = setupGlobals({ hrEmployeesByMatricule: { M001: ACTIVE_EMPLOYEE_HR }, employeesByMatricule: { M001: ATT_ROW } });
    const handler = getRouteHandler(selfPointageRouter, 'post', '/punch');

    let res = mockRes();
    await handler({ matricule: 'M001', body: { type: 'arrival' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(pool._calls.inserts.length, 1);

    res = mockRes();
    await handler({ matricule: 'M001', body: { type: 'arrival' } }, res);
    assert.equal(res.statusCode, 409);
    assert.equal(pool._calls.inserts.length, 1, 'must not write a second time');
});

test('POST /punch allows a departure punch independently of arrival', async () => {
    const today = selfPointageRouter.todayInTz();
    const pool = setupGlobals({
        hrEmployeesByMatricule: { M001: ACTIVE_EMPLOYEE_HR },
        employeesByMatricule: { M001: ATT_ROW },
        dailyRows: { [`42__${today}`]: { arrival_time: '08:00', departure_time: null } },
    });
    const handler = getRouteHandler(selfPointageRouter, 'post', '/punch');

    const req = { matricule: 'M001', body: { type: 'departure' } };
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(pool._daily[`42__${today}`].arrival_time, '08:00', 'arrival must be preserved');
});
