const crypto = require('crypto');
const moment = require('moment-timezone');
const {
    formatLocalDate,
    fetchActiveReportEmployees,
    normalizeMatricule,
} = require('../routes/attendance');
const { sendMail } = require('./mailer');
const { applyManualCorrection } = require('./attendanceCorrection');

const TIMEZONE = 'Africa/Tunis';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://pointeuse-back.azurewebsites.net').replace(/\/+$/, '');
const TEST_OVERRIDE_EMAIL = (process.env.REMOTE_ATTENDANCE_TEST_OVERRIDE_EMAIL || '').trim() || null;
const AUDIT_CC_EMAIL = (process.env.REMOTE_ATTENDANCE_AUDIT_CC || 'rami.mejri@avocarbon.com').trim() || null;

// Uids never emailed for remote attendance — mirrors MISSING_POINTS_EXCLUDED_UIDS
// (e.g. Fethi, uid 1, doesn't badge through the normal process either).
const EXCLUDED_UIDS = new Set(
    (process.env.REMOTE_ATTENDANCE_EXCLUDED_UIDS || '1')
        .split(',')
        .map(s => parseInt(s.trim(), 10))
        .filter(n => Number.isFinite(n))
);

// Reserved uid for synthetic test punches — real employee uids are always
// positive, and this is distinct from missingPoints.js's own TEST_UID (-1)
// since the two features use separate tables.
const TEST_UID = -2;

// ══════════════════════════════════════════════════════════════
// TABLE BOOTSTRAP
// ══════════════════════════════════════════════════════════════

let remoteDaysTableEnsured = false;

async function ensureRemoteWorkDaysTable() {
    if (remoteDaysTableEnsured) return;
    await global.attendancePool.query(`
        CREATE TABLE IF NOT EXISTS public.remote_work_days (
            id SERIAL PRIMARY KEY,
            work_date DATE NOT NULL UNIQUE,
            label TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);
    remoteDaysTableEnsured = true;
}

let punchesTableEnsured = false;

async function ensureRemoteAttendancePunchesTable() {
    if (punchesTableEnsured) return;
    await global.attendancePool.query(`
        CREATE TABLE IF NOT EXISTS public.remote_attendance_punches (
            id SERIAL PRIMARY KEY,
            uid INTEGER NOT NULL,
            matricule TEXT NOT NULL,
            full_name TEXT,
            work_date DATE NOT NULL,
            punch_type TEXT NOT NULL CHECK (punch_type IN ('arrival', 'departure')),
            employee_email TEXT NOT NULL,
            token TEXT UNIQUE NOT NULL,
            token_expires_at TIMESTAMPTZ NOT NULL,
            sent_at TIMESTAMPTZ,
            used_at TIMESTAMPTZ,
            recorded_time TEXT,
            is_test BOOLEAN NOT NULL DEFAULT false,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (uid, work_date, punch_type)
        )
    `);
    punchesTableEnsured = true;
}

// ══════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════

function todayInTz() {
    return moment().tz(TIMEZONE).format('YYYY-MM-DD');
}

function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

// Punch links are only ever meaningful for the day they were issued for —
// unlike the missing-points correction links, there's no reason to let
// someone confirm an arrival/departure days later.
function endOfDayExpiry(dateStr) {
    return moment.tz(`${dateStr} 23:59:59`, 'YYYY-MM-DD HH:mm:ss', TIMEZONE).toDate();
}

function resolveRecipient(realEmail) {
    return TEST_OVERRIDE_EMAIL || realEmail;
}

function withAuditCc(...ccCandidates) {
    const seen = new Set();
    const result = [];
    for (const email of [...ccCandidates, AUDIT_CC_EMAIL]) {
        const normalized = (email || '').trim();
        if (!normalized) continue;
        const key = normalized.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(normalized);
    }
    return result.length ? result : undefined;
}

async function fetchEmployeeEmailsByMatricules(matricules) {
    if (!matricules.length) return new Map();
    const { rows } = await global.hrPool.query(`
        SELECT matricule, adresse_mail
        FROM employees
        WHERE matricule = ANY($1::text[])
    `, [matricules]);

    const byMatricule = new Map();
    rows.forEach(row => {
        const key = normalizeMatricule(row.matricule);
        if (key && row.adresse_mail) byMatricule.set(key, row.adresse_mail);
    });
    return byMatricule;
}

// ══════════════════════════════════════════════════════════════
// REMOTE WORK DAYS (admin toggle — reusable for any future remote day)
// ══════════════════════════════════════════════════════════════

async function isRemoteWorkDay(dateStr) {
    await ensureRemoteWorkDaysTable();
    const { rows } = await global.attendancePool.query(`
        SELECT 1 FROM public.remote_work_days WHERE work_date = $1
    `, [dateStr]);
    return rows.length > 0;
}

async function addRemoteWorkDay(dateStr, label) {
    await ensureRemoteWorkDaysTable();
    const { rows } = await global.attendancePool.query(`
        INSERT INTO public.remote_work_days (work_date, label)
        VALUES ($1, $2)
        ON CONFLICT (work_date) DO UPDATE SET label = EXCLUDED.label
        RETURNING id, work_date::text AS date, label
    `, [dateStr, label || null]);
    return rows[0];
}

async function removeRemoteWorkDay(dateStr) {
    await ensureRemoteWorkDaysTable();
    const { rowCount } = await global.attendancePool.query(`
        DELETE FROM public.remote_work_days WHERE work_date = $1
    `, [dateStr]);
    return rowCount;
}

async function listRemoteWorkDays() {
    await ensureRemoteWorkDaysTable();
    const { rows } = await global.attendancePool.query(`
        SELECT id, work_date::text AS date, label
        FROM public.remote_work_days
        ORDER BY work_date DESC
    `);
    return rows;
}

// ══════════════════════════════════════════════════════════════
// EMAIL
// ══════════════════════════════════════════════════════════════

async function sendPunchEmail(row) {
    const link = `${PUBLIC_BASE_URL}/remote-attendance/punch/${row.token}`;
    const isArrival = row.punch_type === 'arrival';
    const label = isArrival ? "votre heure d'arrivée" : 'votre heure de départ';
    const workDate = row.work_date instanceof Date ? formatLocalDate(row.work_date) : String(row.work_date).split('T')[0];

    await sendMail({
        to: resolveRecipient(row.employee_email),
        cc: withAuditCc(),
        subject: `Télétravail ${workDate} — confirmez ${isArrival ? 'votre arrivée' : 'votre départ'}`,
        html: `
            <p>Bonjour ${row.full_name || ''},</p>
            <p>Aujourd'hui est déclaré comme journée de télétravail. Merci de confirmer ${label} en cliquant sur le lien ci-dessous :</p>
            <p><a href="${link}">${link}</a></p>
            <p>L'heure est enregistrée automatiquement au moment où vous cliquez sur le bouton de confirmation. Ce lien n'est valable que pour la journée du ${workDate}.</p>
        `,
    });
}

// ══════════════════════════════════════════════════════════════
// SENDING PUNCH LINKS
// ══════════════════════════════════════════════════════════════

async function getPunchRow(uid, workDate, punchType) {
    const { rows } = await global.attendancePool.query(`
        SELECT * FROM public.remote_attendance_punches
        WHERE uid = $1 AND work_date = $2 AND punch_type = $3
    `, [uid, workDate, punchType]);
    return rows[0] || null;
}

async function getPunchByToken(token) {
    await ensureRemoteAttendancePunchesTable();
    const { rows } = await global.attendancePool.query(`
        SELECT * FROM public.remote_attendance_punches WHERE token = $1
    `, [token]);
    return rows[0] || null;
}

/**
 * Emails every active employee their arrival or departure confirmation link
 * for the given date. Idempotent: an employee who already has a punch row
 * for that uid/date/punchType (sent or used) is skipped, so re-running the
 * sweep (e.g. after a partial failure) never double-emails anyone.
 */
async function sendPunchLinksForDate(dateStr, punchType, { dryRun = false } = {}) {
    await ensureRemoteAttendancePunchesTable();

    const employees = await fetchActiveReportEmployees();
    const activeEmployees = employees.filter(e =>
        e.uid !== null && e.uid !== undefined && !EXCLUDED_UIDS.has(e.uid)
    );
    if (!activeEmployees.length) return { date: dateStr, punchType, dryRun, skipped: [], actions: [] };

    const matricules = activeEmployees.map(e => normalizeMatricule(e.matricule)).filter(Boolean);
    const emailByMatricule = await fetchEmployeeEmailsByMatricules(matricules);

    const actions = [];
    const skipped = [];

    for (const emp of activeEmployees) {
        const matricule = normalizeMatricule(emp.matricule);
        const email = emailByMatricule.get(matricule);
        if (!email) {
            skipped.push({ uid: emp.uid, matricule, reason: 'missing employee email in HR record' });
            continue;
        }

        const existing = await getPunchRow(emp.uid, dateStr, punchType);
        if (existing) {
            actions.push({ action: 'already_sent', uid: emp.uid, matricule });
            continue;
        }

        if (dryRun) {
            actions.push({ action: 'would_send', uid: emp.uid, matricule });
            continue;
        }

        const token = generateToken();
        const { rows } = await global.attendancePool.query(`
            INSERT INTO public.remote_attendance_punches
                (uid, matricule, full_name, work_date, punch_type, employee_email, token, token_expires_at, sent_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
            ON CONFLICT (uid, work_date, punch_type) DO NOTHING
            RETURNING *
        `, [emp.uid, matricule, emp.name, dateStr, punchType, email, token, endOfDayExpiry(dateStr)]);

        const row = rows[0];
        if (!row) {
            actions.push({ action: 'already_sent', uid: emp.uid, matricule });
            continue;
        }

        try {
            await sendPunchEmail(row);
            actions.push({ action: 'sent', uid: emp.uid, matricule });
        } catch (err) {
            console.error(`❌ [remote-attendance] failed to email uid=${row.uid} ${punchType} ${dateStr}:`, err.message);
            actions.push({ action: 'send_failed', uid: emp.uid, matricule, error: err.message });
        }
    }

    return { date: dateStr, punchType, dryRun, skipped, actions };
}

/**
 * Creates a fully synthetic punch (reserved uid, never touching real
 * HR/attendance data) so the email + confirmation-page loop can be tested
 * end-to-end against a single real inbox. Confirming it never writes to
 * attendance_daily (see confirmPunch below).
 */
async function createSyntheticTestPunch(testEmail, punchType) {
    await ensureRemoteAttendancePunchesTable();
    const dateStr = todayInTz();

    await global.attendancePool.query(`DELETE FROM public.remote_attendance_punches WHERE is_test = true`);

    const token = generateToken();
    const { rows } = await global.attendancePool.query(`
        INSERT INTO public.remote_attendance_punches
            (uid, matricule, full_name, work_date, punch_type, employee_email, token, token_expires_at, sent_at, is_test)
        VALUES ($1,'TEST','Test (bac a sable)',$2,$3,$4,$5,$6, now(), true)
        RETURNING *
    `, [TEST_UID, dateStr, punchType, testEmail, token, endOfDayExpiry(dateStr)]);

    const row = rows[0];
    await sendPunchEmail(row);
    return { action: 'test_punch_created', testEmail, punchType, date: dateStr };
}

// ══════════════════════════════════════════════════════════════
// CONFIRMATION (public link → writes attendance_daily)
// ══════════════════════════════════════════════════════════════

async function confirmPunch(token) {
    await ensureRemoteAttendancePunchesTable();

    const { rows } = await global.attendancePool.query(`
        SELECT * FROM public.remote_attendance_punches WHERE token = $1
    `, [token]);
    const row = rows[0];
    if (!row) return { ok: false, error: 'invalid_token' };
    if (row.used_at) return { ok: false, error: 'already_used', row };
    if (moment(row.token_expires_at).isBefore(moment())) return { ok: false, error: 'expired' };

    const recordedTime = moment().tz(TIMEZONE).format('HH:mm');
    const workDate = row.work_date instanceof Date ? formatLocalDate(row.work_date) : String(row.work_date).split('T')[0];

    // Synthetic test punches never touch real attendance data.
    if (!row.is_test) {
        const { rows: empRows } = await global.attendancePool.query(`
            SELECT pointeuse_user_id, card_no FROM public.employees WHERE uid = $1
        `, [row.uid]);
        const emp = empRows[0] || {};

        await applyManualCorrection(global.attendancePool, {
            uid: row.uid,
            matricule: row.matricule,
            pointeuseUserId: emp.pointeuse_user_id || null,
            fullName: row.full_name,
            cardNo: emp.card_no || null,
            date: workDate,
            arrivalTime: row.punch_type === 'arrival' ? recordedTime : null,
            departureTime: row.punch_type === 'departure' ? recordedTime : null,
            comment: null,
            correctedBy: 'remote-attendance:self',
        });
    }

    const { rows: updatedRows } = await global.attendancePool.query(`
        UPDATE public.remote_attendance_punches
        SET used_at = now(), recorded_time = $2
        WHERE id = $1
        RETURNING *
    `, [row.id, recordedTime]);

    return { ok: true, row: updatedRows[0], recordedTime, workDate };
}

module.exports = {
    todayInTz,
    isRemoteWorkDay,
    addRemoteWorkDay,
    removeRemoteWorkDay,
    listRemoteWorkDays,
    sendPunchLinksForDate,
    createSyntheticTestPunch,
    getPunchByToken,
    confirmPunch,
};
