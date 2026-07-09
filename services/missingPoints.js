const crypto = require('crypto');
const moment = require('moment-timezone');
const {
    formatLocalDate,
    enumerateWeekdays,
    fetchActiveReportEmployees,
    fetchApprovedRequests,
    buildApprovedRequestMap,
    fetchSpecialDays,
    computeDayResult,
    normalizeMatricule,
} = require('../routes/attendance');
const { sendMail } = require('./mailer');
const { applyManualCorrection } = require('./attendanceCorrection');

const TIMEZONE = 'Africa/Tunis';
const TOKEN_TTL_DAYS = 14;
const FETHI_NOTIFICATION_EMAIL = process.env.FETHI_NOTIFICATION_EMAIL || 'fethi.chaouachi@avocarbon.com';
// Hardcoded production defaults — there's no Azure Portal access to set these
// as App Settings, so the app must work correctly with zero environment
// configuration. Both can still be overridden via env var if ever needed.
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://pointeuse-back.azurewebsites.net').replace(/\/+$/, '');
const TEST_OVERRIDE_EMAIL = (process.env.MISSING_POINTS_TEST_OVERRIDE_EMAIL || '').trim() || null;
const AUDIT_CC_EMAIL = (process.env.MISSING_POINTS_AUDIT_CC || 'rami.mejri@avocarbon.com').trim() || null;

// ══════════════════════════════════════════════════════════════
// TABLE BOOTSTRAP (additive; mirrors ensureManualCorrectionColumns
// / ensureSpecialDaysTable pattern already used in routes/attendance.js)
// ══════════════════════════════════════════════════════════════

let tableEnsured = false;

async function ensureMissingPointRequestsTable() {
    if (tableEnsured) return;
    await global.attendancePool.query(`
        CREATE TABLE IF NOT EXISTS public.missing_point_requests (
            id SERIAL PRIMARY KEY,
            uid INTEGER NOT NULL,
            matricule TEXT NOT NULL,
            full_name TEXT,
            work_date DATE NOT NULL,
            missing_type TEXT NOT NULL CHECK (missing_type IN ('arrival', 'departure', 'both')),
            status TEXT NOT NULL DEFAULT 'pending_employee'
                CHECK (status IN ('pending_employee', 'pending_responsable1', 'approved')),
            employee_email TEXT NOT NULL,
            responsable1_email TEXT NOT NULL,
            proposed_arrival_time TEXT,
            proposed_departure_time TEXT,
            employee_comment TEXT,
            rejection_comment TEXT,
            employee_token TEXT UNIQUE,
            employee_token_expires_at TIMESTAMPTZ,
            responsable_token TEXT UNIQUE,
            responsable_token_expires_at TIMESTAMPTZ,
            employee_notified_at TIMESTAMPTZ,
            employee_notified_count INTEGER NOT NULL DEFAULT 0,
            responsable_notified_at TIMESTAMPTZ,
            responsable_notified_count INTEGER NOT NULL DEFAULT 0,
            fethi_notified_at TIMESTAMPTZ,
            resolved_at TIMESTAMPTZ,
            is_test BOOLEAN NOT NULL DEFAULT false,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (uid, work_date)
        )
    `);
    // Additive safety net in case the table was already created by an
    // earlier version of this file before these columns existed.
    await global.attendancePool.query(`
        ALTER TABLE public.missing_point_requests
            ADD COLUMN IF NOT EXISTS fethi_notified_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false
    `);
    tableEnsured = true;
}

// Reserved uid for synthetic test requests — real employee uids are always
// positive, so this can never collide with a real record.
const TEST_UID = -1;

// ══════════════════════════════════════════════════════════════
// AUTOMATION PAUSE SWITCH — controllable via curl, no Azure access needed.
// Starts PAUSED by default so the real daily cron does nothing until
// explicitly resumed. Only gates real detection/reminders, never the
// synthetic test-request flow.
// ══════════════════════════════════════════════════════════════

let automationStateEnsured = false;

async function ensureAutomationStateTable() {
    if (automationStateEnsured) return;
    await global.attendancePool.query(`
        CREATE TABLE IF NOT EXISTS public.missing_point_automation_state (
            id INTEGER PRIMARY KEY DEFAULT 1,
            paused BOOLEAN NOT NULL DEFAULT true,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CHECK (id = 1)
        )
    `);
    await global.attendancePool.query(`
        INSERT INTO public.missing_point_automation_state (id, paused) VALUES (1, true)
        ON CONFLICT (id) DO NOTHING
    `);
    automationStateEnsured = true;
}

async function isAutomationPaused() {
    await ensureAutomationStateTable();
    const { rows } = await global.attendancePool.query(`SELECT paused FROM public.missing_point_automation_state WHERE id = 1`);
    return rows[0] ? rows[0].paused : true;
}

async function setAutomationPaused(paused) {
    await ensureAutomationStateTable();
    await global.attendancePool.query(`
        UPDATE public.missing_point_automation_state SET paused = $1, updated_at = now() WHERE id = 1
    `, [!!paused]);
    return { paused: !!paused };
}

// ══════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════

function todayInTz() {
    return moment().tz(TIMEZONE).format('YYYY-MM-DD');
}

// The previous business day: a plain calendar "yesterday" would resolve to
// Sunday when run on a Monday, and weekends are skipped entirely — silently
// dropping Friday's missing points. Roll back over the weekend instead.
function previousBusinessDayInTz() {
    let d = moment().tz(TIMEZONE).subtract(1, 'day');
    while (d.day() === 0 || d.day() === 6) { // Sunday=0, Saturday=6
        d.subtract(1, 'day');
    }
    return d.format('YYYY-MM-DD');
}

function isSameLocalDay(timestamp) {
    if (!timestamp) return false;
    return moment(timestamp).tz(TIMEZONE).format('YYYY-MM-DD') === todayInTz();
}

function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

function tokenExpiry() {
    return moment().add(TOKEN_TTL_DAYS, 'days').toDate();
}

function resolveRecipient(realEmail) {
    return TEST_OVERRIDE_EMAIL || realEmail;
}

// Always appends the permanent audit CC (if configured) on top of whatever
// real/overridden recipients apply, so it stays informed regardless of
// test-override mode.
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

async function fetchHrContactsByMatricules(matricules) {
    if (!matricules.length) return new Map();
    const { rows } = await global.hrPool.query(`
        SELECT matricule, adresse_mail, mail_responsable1
        FROM employees
        WHERE matricule = ANY($1::text[])
    `, [matricules]);

    const byMatricule = new Map();
    rows.forEach(row => {
        const key = normalizeMatricule(row.matricule);
        if (key) byMatricule.set(key, row);
    });
    return byMatricule;
}

function missingTypeLabel(missingType) {
    if (missingType === 'arrival') return "l'heure d'arrivée";
    if (missingType === 'departure') return "l'heure de départ";
    return "l'heure d'arrivée et l'heure de départ";
}

// ══════════════════════════════════════════════════════════════
// DETECTION — reuses the exact same logic as GET /api/report
// ══════════════════════════════════════════════════════════════

async function findMissingPointsForDate(dateStr) {
    if (enumerateWeekdays(dateStr, dateStr).length === 0) {
        return []; // weekend — nothing to check
    }

    const employees = await fetchActiveReportEmployees();
    const activeUids = employees.filter(e => e.uid !== null && e.uid !== undefined).map(e => e.uid);
    if (!activeUids.length) return [];

    const { rows: attendanceRows } = await global.attendancePool.query(`
        SELECT uid, arrival_time, departure_time, entries
        FROM public.attendance_daily
        WHERE work_date = $1 AND uid = ANY($2::int[])
    `, [dateStr, activeUids]);

    const attendanceByUid = new Map(attendanceRows.map(row => [row.uid, row]));

    const approvedRequests = await fetchApprovedRequests(dateStr, dateStr);
    const approvedRequestMap = buildApprovedRequestMap(approvedRequests, dateStr, dateStr);
    const specialDays = await fetchSpecialDays(dateStr, dateStr);
    const specialDaysForDate = specialDays.byDate.get(dateStr) || [];

    const missing = [];
    for (const emp of employees) {
        if (emp.uid === null || emp.uid === undefined) continue;
        const attRow = attendanceByUid.get(emp.uid) || null;
        const requestsForDay = approvedRequestMap.get(`${emp.hrId}__${dateStr}`) || [];
        const result = computeDayResult(attRow, requestsForDay, dateStr, specialDaysForDate);

        // Only "punched once" days (exactly one of arrival/departure recorded).
        // Full absences (status 'absent', no punch at all) are intentionally
        // excluded — this workflow is for forgotten badges, not unrecorded
        // absences, which are a separate HR matter.
        if (result.status !== 'incomplete') continue;

        const hasArrival = !!result.arrival;
        const missingType = hasArrival ? 'departure' : 'arrival';

        missing.push({
            uid: emp.uid,
            matricule: normalizeMatricule(emp.matricule),
            fullName: emp.name,
            cardNo: emp.cardNo,
            pointeuseUserId: emp.pointeuseUserId,
            workDate: dateStr,
            missingType,
        });
    }
    return missing;
}

// ══════════════════════════════════════════════════════════════
// EMAIL SENDERS
// ══════════════════════════════════════════════════════════════

async function sendEmployeeRequestEmail(row) {
    const link = `${PUBLIC_BASE_URL}/missing-point/correct/${row.employee_token}`;
    const reasonBlock = row.rejection_comment
        ? `<p style="color:#b91c1c"><strong>Votre correction précédente a été refusée par votre responsable :</strong><br/>${row.rejection_comment}</p>`
        : '';

    await sendMail({
        to: resolveRecipient(row.employee_email),
        cc: withAuditCc(resolveRecipient(row.responsable1_email)),
        subject: `Pointage manquant le ${row.work_date} — action requise`,
        html: `
            <p>Bonjour ${row.full_name || ''},</p>
            <p>Il manque ${missingTypeLabel(row.missing_type)} pour la journée du <strong>${row.work_date}</strong>.</p>
            ${reasonBlock}
            <p>Merci de renseigner l'heure manquante via ce lien :</p>
            <p><a href="${link}">${link}</a></p>
            <p>Ce lien expire dans ${TOKEN_TTL_DAYS} jours.</p>
        `,
    });
}

async function sendResponsableReviewEmail(row) {
    const link = `${PUBLIC_BASE_URL}/missing-point/review/${row.responsable_token}`;
    await sendMail({
        to: resolveRecipient(row.responsable1_email),
        cc: withAuditCc(),
        subject: `Correction de pointage à valider — ${row.full_name} — ${row.work_date}`,
        html: `
            <p>Bonjour,</p>
            <p><strong>${row.full_name}</strong> a proposé une correction pour le ${row.work_date} :</p>
            <ul>
                <li>Arrivée : ${row.proposed_arrival_time || '(inchangée)'}</li>
                <li>Départ : ${row.proposed_departure_time || '(inchangée)'}</li>
                <li>Commentaire : ${row.employee_comment || '—'}</li>
            </ul>
            <p>Merci de valider ou refuser cette correction :</p>
            <p><a href="${link}">${link}</a></p>
            <p>Ce lien expire dans ${TOKEN_TTL_DAYS} jours.</p>
        `,
    });
}

async function sendFethiNotification(row) {
    // Synthetic test requests must never reach the real Fethi address —
    // redirect to whichever test email this request was created for.
    const recipient = row.is_test ? row.employee_email : resolveRecipient(FETHI_NOTIFICATION_EMAIL);
    await sendMail({
        to: recipient,
        cc: withAuditCc(),
        subject: `Pointage corrigé et validé — ${row.full_name} — ${row.work_date}`,
        html: `
            <p>La correction de pointage suivante a été validée par le responsable et appliquée :</p>
            <ul>
                <li>Employé : ${row.full_name} (matricule ${row.matricule})</li>
                <li>Date : ${row.work_date}</li>
                <li>Arrivée : ${row.proposed_arrival_time || '(inchangée)'}</li>
                <li>Départ : ${row.proposed_departure_time || '(inchangée)'}</li>
            </ul>
        `,
    });
}

// ══════════════════════════════════════════════════════════════
// REQUEST LIFECYCLE
// ══════════════════════════════════════════════════════════════

async function getOpenRequestForDay(uid, workDate) {
    const { rows } = await global.attendancePool.query(`
        SELECT * FROM public.missing_point_requests WHERE uid = $1 AND work_date = $2
    `, [uid, workDate]);
    return rows[0] || null;
}

// Marks the notified_at/count columns only AFTER the email has actually
// been sent — if send fails partway through a sweep, the row is left in a
// "not notified" state so the next sweep retries it automatically, instead
// of silently losing the reminder while the DB thinks it went out.
async function markEmployeeNotified(id) {
    await global.attendancePool.query(`
        UPDATE public.missing_point_requests
        SET employee_notified_at = now(), employee_notified_count = employee_notified_count + 1, updated_at = now()
        WHERE id = $1
    `, [id]);
}

async function markResponsableNotified(id) {
    await global.attendancePool.query(`
        UPDATE public.missing_point_requests
        SET responsable_notified_at = now(), responsable_notified_count = responsable_notified_count + 1, updated_at = now()
        WHERE id = $1
    `, [id]);
}

async function createRequestAndNotify(missingEmp, contact, { dryRun }) {
    if (dryRun) {
        return { action: 'would_create', uid: missingEmp.uid, workDate: missingEmp.workDate };
    }

    const employeeToken = generateToken();
    const { rows } = await global.attendancePool.query(`
        INSERT INTO public.missing_point_requests
            (uid, matricule, full_name, work_date, missing_type, status,
             employee_email, responsable1_email,
             employee_token, employee_token_expires_at)
        VALUES ($1,$2,$3,$4,$5,'pending_employee',$6,$7,$8,$9)
        RETURNING *
    `, [
        missingEmp.uid, missingEmp.matricule, missingEmp.fullName, missingEmp.workDate, missingEmp.missingType,
        contact.adresse_mail, contact.mail_responsable1,
        employeeToken, tokenExpiry(),
    ]);

    const row = rows[0];
    try {
        await sendEmployeeRequestEmail(row);
        await markEmployeeNotified(row.id);
        return { action: 'created', uid: row.uid, workDate: row.work_date };
    } catch (err) {
        console.error(`❌ [missing-points] failed to email employee uid=${row.uid} ${row.work_date}:`, err.message);
        return { action: 'created_but_send_failed', uid: row.uid, workDate: row.work_date, error: err.message };
    }
}

async function resendEmployeeReminder(row, { dryRun }) {
    if (dryRun) return { action: 'would_remind_employee', uid: row.uid, workDate: row.work_date };

    let employeeToken = row.employee_token;
    let expiresAt = row.employee_token_expires_at;
    if (!employeeToken || moment(expiresAt).isBefore(moment())) {
        employeeToken = generateToken();
        expiresAt = tokenExpiry();
        const { rows } = await global.attendancePool.query(`
            UPDATE public.missing_point_requests
            SET employee_token = $2, employee_token_expires_at = $3, updated_at = now()
            WHERE id = $1
            RETURNING *
        `, [row.id, employeeToken, expiresAt]);
        row = rows[0];
    }

    try {
        await sendEmployeeRequestEmail(row);
        await markEmployeeNotified(row.id);
        return { action: 'reminded_employee', uid: row.uid, workDate: row.work_date };
    } catch (err) {
        console.error(`❌ [missing-points] failed to remind employee uid=${row.uid} ${row.work_date}:`, err.message);
        return { action: 'remind_employee_failed', uid: row.uid, workDate: row.work_date, error: err.message };
    }
}

async function resendResponsableReminder(row, { dryRun }) {
    if (dryRun) return { action: 'would_remind_responsable', uid: row.uid, workDate: row.work_date };

    try {
        await sendResponsableReviewEmail(row);
        await markResponsableNotified(row.id);
        return { action: 'reminded_responsable', uid: row.uid, workDate: row.work_date };
    } catch (err) {
        console.error(`❌ [missing-points] failed to remind responsable uid=${row.uid} ${row.work_date}:`, err.message);
        return { action: 'remind_responsable_failed', uid: row.uid, workDate: row.work_date, error: err.message };
    }
}

async function resendFethiNotificationIfNeeded(row, { dryRun }) {
    if (dryRun) return { action: 'would_notify_fethi', uid: row.uid, workDate: row.work_date };

    try {
        await sendFethiNotification(row);
        await global.attendancePool.query(`
            UPDATE public.missing_point_requests SET fethi_notified_at = now(), updated_at = now() WHERE id = $1
        `, [row.id]);
        return { action: 'notified_fethi', uid: row.uid, workDate: row.work_date };
    } catch (err) {
        console.error(`❌ [missing-points] failed to notify Fethi uid=${row.uid} ${row.work_date}:`, err.message);
        return { action: 'notify_fethi_failed', uid: row.uid, workDate: row.work_date, error: err.message };
    }
}

/**
 * Detects missing points for one day and creates/notifies new requests,
 * then sweeps ALL still-open requests (any day) that haven't been nudged
 * today so nothing goes silently stale.
 */
async function runDailySweep({ targetDate, dryRun = false } = {}) {
    await ensureMissingPointRequestsTable();

    if (await isAutomationPaused()) {
        return { paused: true, message: 'Automation is paused — no detection or reminders were run.' };
    }

    const dateStr = targetDate || previousBusinessDayInTz();
    const actions = [];
    const skipped = [];

    const missing = await findMissingPointsForDate(dateStr);
    const matricules = missing.map(m => m.matricule).filter(Boolean);
    const contacts = await fetchHrContactsByMatricules(matricules);

    for (const emp of missing) {
        const existing = await getOpenRequestForDay(emp.uid, emp.workDate);
        if (existing) continue; // handled by the open-requests sweep below

        const contact = contacts.get(emp.matricule);
        if (!contact || !contact.adresse_mail || !contact.mail_responsable1) {
            skipped.push({ uid: emp.uid, matricule: emp.matricule, reason: 'missing employee or responsable1 email in HR record' });
            continue;
        }

        actions.push(await createRequestAndNotify(emp, contact, { dryRun }));
    }

    const { rows: openRows } = await global.attendancePool.query(`
        SELECT * FROM public.missing_point_requests
        WHERE is_test = false
          AND (status IN ('pending_employee', 'pending_responsable1')
               OR (status = 'approved' AND fethi_notified_at IS NULL))
    `);

    for (const row of openRows) {
        if (row.status === 'pending_employee' && !isSameLocalDay(row.employee_notified_at)) {
            actions.push(await resendEmployeeReminder(row, { dryRun }));
        } else if (row.status === 'pending_responsable1' && !isSameLocalDay(row.responsable_notified_at)) {
            actions.push(await resendResponsableReminder(row, { dryRun }));
        } else if (row.status === 'approved' && !row.fethi_notified_at) {
            actions.push(await resendFethiNotificationIfNeeded(row, { dryRun }));
        }
    }

    return { date: dateStr, dryRun, found: missing.length, skipped, actions };
}

/**
 * Creates a fully synthetic request (fake employee, reserved uid, never
 * touching real HR/attendance data) so the whole loop — employee email,
 * correction form, responsable review, approve/reject, Fethi notification —
 * can be safely tested end-to-end against a single real inbox. Approving a
 * test request never writes to attendance_daily (see approveRequest below).
 */
async function createSyntheticTestRequest(testEmail) {
    await ensureMissingPointRequestsTable();

    await global.attendancePool.query(`DELETE FROM public.missing_point_requests WHERE is_test = true`);

    const employeeToken = generateToken();
    const { rows } = await global.attendancePool.query(`
        INSERT INTO public.missing_point_requests
            (uid, matricule, full_name, work_date, missing_type, status,
             employee_email, responsable1_email,
             employee_token, employee_token_expires_at, is_test)
        VALUES ($1,'TEST','Test (bac a sable)',$2,'departure','pending_employee',$3,$3,$4,$5,true)
        RETURNING *
    `, [TEST_UID, todayInTz(), testEmail, employeeToken, tokenExpiry()]);

    const row = rows[0];
    await sendEmployeeRequestEmail(row);
    await markEmployeeNotified(row.id);
    return { action: 'test_request_created', testEmail };
}

// ══════════════════════════════════════════════════════════════
// PUBLIC-LINK ACTIONS (employee submission, responsable approve/reject)
// ══════════════════════════════════════════════════════════════

async function getRequestByEmployeeToken(token) {
    const { rows } = await global.attendancePool.query(`
        SELECT * FROM public.missing_point_requests
        WHERE employee_token = $1 AND status = 'pending_employee'
    `, [token]);
    const row = rows[0];
    if (!row || moment(row.employee_token_expires_at).isBefore(moment())) return null;
    return row;
}

async function getRequestByResponsableToken(token) {
    const { rows } = await global.attendancePool.query(`
        SELECT * FROM public.missing_point_requests
        WHERE responsable_token = $1 AND status = 'pending_responsable1'
    `, [token]);
    const row = rows[0];
    if (!row || moment(row.responsable_token_expires_at).isBefore(moment())) return null;
    return row;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

async function submitEmployeeCorrection(token, { arrivalTime, departureTime, comment }) {
    const row = await getRequestByEmployeeToken(token);
    if (!row) return { ok: false, error: 'invalid_or_expired' };

    if (arrivalTime && !TIME_RE.test(arrivalTime)) return { ok: false, error: 'bad_arrival_time' };
    if (departureTime && !TIME_RE.test(departureTime)) return { ok: false, error: 'bad_departure_time' };
    if (!arrivalTime && !departureTime) return { ok: false, error: 'time_required' };

    const responsableToken = generateToken();
    const { rows } = await global.attendancePool.query(`
        UPDATE public.missing_point_requests
        SET status = 'pending_responsable1',
            proposed_arrival_time = $2, proposed_departure_time = $3, employee_comment = $4,
            employee_token = NULL, employee_token_expires_at = NULL,
            responsable_token = $5, responsable_token_expires_at = $6,
            updated_at = now()
        WHERE id = $1
        RETURNING *
    `, [row.id, arrivalTime || null, departureTime || null, comment || null, responsableToken, tokenExpiry()]);

    const updated = rows[0];
    // The employee's submission is already saved regardless of what happens
    // next — if this send fails, don't lose it: leave responsable_notified_at
    // unset so the daily sweep's safety net retries it automatically.
    try {
        await sendResponsableReviewEmail(updated);
        await markResponsableNotified(updated.id);
    } catch (err) {
        console.error(`❌ [missing-points] failed to email responsable for uid=${updated.uid} ${updated.work_date}:`, err.message);
    }
    return { ok: true, row: updated };
}

async function approveRequest(token) {
    const row = await getRequestByResponsableToken(token);
    if (!row) return { ok: false, error: 'invalid_or_expired' };

    // Synthetic test requests never touch real attendance data.
    if (!row.is_test) {
        await applyManualCorrection(global.attendancePool, {
            uid: row.uid,
            matricule: row.matricule,
            pointeuseUserId: null,
            fullName: row.full_name,
            cardNo: null,
            date: row.work_date instanceof Date ? formatLocalDate(row.work_date) : String(row.work_date).split('T')[0],
            arrivalTime: row.proposed_arrival_time,
            departureTime: row.proposed_departure_time,
            comment: row.employee_comment,
            correctedBy: `responsable1:${row.responsable1_email}`,
        });
    }

    const { rows } = await global.attendancePool.query(`
        UPDATE public.missing_point_requests
        SET status = 'approved', resolved_at = now(),
            responsable_token = NULL, responsable_token_expires_at = NULL,
            updated_at = now()
        WHERE id = $1
        RETURNING *
    `, [row.id]);

    const updated = rows[0];
    // The correction is already applied to attendance_daily above — that's
    // the part that matters. If notifying Fethi fails, leave fethi_notified_at
    // unset so the daily sweep retries the notification automatically.
    try {
        await sendFethiNotification(updated);
        await global.attendancePool.query(`
            UPDATE public.missing_point_requests SET fethi_notified_at = now(), updated_at = now() WHERE id = $1
        `, [updated.id]);
    } catch (err) {
        console.error(`❌ [missing-points] failed to notify Fethi for uid=${updated.uid} ${updated.work_date}:`, err.message);
    }
    return { ok: true, row: updated };
}

async function rejectRequest(token, rejectionComment) {
    const row = await getRequestByResponsableToken(token);
    if (!row) return { ok: false, error: 'invalid_or_expired' };

    const employeeToken = generateToken();
    const { rows } = await global.attendancePool.query(`
        UPDATE public.missing_point_requests
        SET status = 'pending_employee',
            rejection_comment = $2,
            responsable_token = NULL, responsable_token_expires_at = NULL,
            employee_token = $3, employee_token_expires_at = $4,
            updated_at = now()
        WHERE id = $1
        RETURNING *
    `, [row.id, rejectionComment || null, employeeToken, tokenExpiry()]);

    const updated = rows[0];
    // Same reasoning as above: the rejection is already saved; if the
    // re-notification email fails, the daily sweep will retry it.
    try {
        await sendEmployeeRequestEmail(updated);
        await markEmployeeNotified(updated.id);
    } catch (err) {
        console.error(`❌ [missing-points] failed to email employee after rejection uid=${updated.uid} ${updated.work_date}:`, err.message);
    }
    return { ok: true, row: updated };
}

module.exports = {
    ensureMissingPointRequestsTable,
    runDailySweep,
    createSyntheticTestRequest,
    isAutomationPaused,
    setAutomationPaused,
    getRequestByEmployeeToken,
    getRequestByResponsableToken,
    submitEmployeeCorrection,
    approveRequest,
    rejectRequest,
};
