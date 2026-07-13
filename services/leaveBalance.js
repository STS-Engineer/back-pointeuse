const moment = require('moment-timezone');
const {
    formatLocalDate,
    enumerateWeekdays,
    fetchActiveReportEmployees,
    fetchApprovedRequests,
    buildApprovedRequestMap,
    fetchSpecialDays,
    computeDayResult,
} = require('../routes/attendance');

const TIMEZONE = 'Africa/Tunis';

// The accrual rate: 1.82 leave days earned per 173.33 credited hours.
// 173.33h/1.82d is the standard full-time monthly reference (40h/week average),
// applied continuously rather than in discrete monthly buckets — there's no
// fixed payroll-month cutoff in this system, so balances just advance day by
// day as credited hours accumulate.
const ACCRUAL_HOURS_PER_UNIT = 173.33;
const ACCRUAL_DAYS_PER_UNIT = 1.82;

let tableEnsured = false;

async function ensureLeaveBalanceTable() {
    if (tableEnsured) return;
    await global.attendancePool.query(`
        CREATE TABLE IF NOT EXISTS public.leave_balance (
            uid INTEGER PRIMARY KEY,
            matricule TEXT,
            full_name TEXT,
            accrual_start_date DATE NOT NULL,
            credited_hours NUMERIC(12,2) NOT NULL DEFAULT 0,
            accrued_days NUMERIC(12,3) NOT NULL DEFAULT 0,
            taken_days NUMERIC(12,3) NOT NULL DEFAULT 0,
            balance_days NUMERIC(12,3) NOT NULL DEFAULT 0,
            last_computed_date DATE,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);
    tableEnsured = true;
}

function yesterdayInTz() {
    return moment().tz(TIMEZONE).subtract(1, 'day').format('YYYY-MM-DD');
}

function addDaysStr(dateStr, n) {
    return moment(dateStr).add(n, 'day').format('YYYY-MM-DD');
}

function dateOnly(value) {
    if (!value) return null;
    return value instanceof Date ? formatLocalDate(value) : String(value).split('T')[0];
}

// A day's credited hours toward accrual = actual worked minutes plus approved
// congé valued at a full 8h. Half-day congé already contributes 4h via
// workedMinutes and 4h via congeDays*8 (computeDayResult returns
// workedMinutes:240, congeDays:0.5 for that case), so the two always sum to
// a full 8h day. Holidays (jours fériés) are intentionally NOT credited here
// — only actual work and approved congé count, per the accrual rule.
function creditedMinutesForDay(result) {
    return (result.workedMinutes || 0) + (result.congeDays || 0) * 8 * 60;
}

async function fetchEarliestAttendanceDate(uid) {
    const { rows } = await global.attendancePool.query(
        `SELECT MIN(work_date) AS start_date FROM public.attendance_daily WHERE uid = $1`,
        [uid]
    );
    return dateOnly(rows[0]?.start_date);
}

/**
 * Advances active employees' leave balances through asOfDate (default:
 * yesterday — "today" may still be in progress and shouldn't be credited
 * until it's actually complete).
 *
 * By default this is INCREMENTAL: each employee's last_computed_date means
 * already-processed days are never re-counted, so the daily cron can call
 * this repeatedly without double-crediting. The tradeoff is that a
 * retroactive correction to a PAST day (e.g. someone fixes a forgotten
 * punch from 3 days ago) will NOT be picked up automatically — that day has
 * already been locked into the running total.
 *
 * Pass { force: true } to instead fully rebuild an employee's balance from
 * their accrual_start_date forward, discarding whatever was stored before.
 * This is the manual "fix it now" path: call it (optionally scoped to
 * specific uids via { uids: [...] }) any time you know a correction landed,
 * and it becomes correct again from scratch — no need to know exactly which
 * days changed.
 */
async function recomputeLeaveBalances({ asOfDate, force = false, uids = null } = {}) {
    await ensureLeaveBalanceTable();
    const endDate = asOfDate || yesterdayInTz();

    const employees = await fetchActiveReportEmployees();
    let activeEmployees = employees.filter(e => e.uid !== null && e.uid !== undefined);
    if (Array.isArray(uids) && uids.length) {
        const uidSet = new Set(uids.map(Number));
        activeEmployees = activeEmployees.filter(e => uidSet.has(e.uid));
    }
    if (!activeEmployees.length) return { processed: 0, skipped: 0, asOfDate: endDate };

    const { rows: existingRows } = await global.attendancePool.query(
        `SELECT * FROM public.leave_balance WHERE uid = ANY($1::int[])`,
        [activeEmployees.map(e => e.uid)]
    );
    const existingByUid = new Map(existingRows.map(r => [r.uid, r]));

    // Work out each employee's [rangeStart, endDate] window first, and the
    // earliest rangeStart across everyone, so attendance/requests/special
    // days can be fetched once for the whole span instead of per employee.
    // In force mode, rangeStart always goes back to accrual_start_date (or
    // the earliest attendance record if there's no existing row yet) instead
    // of resuming from last_computed_date, and the previous stored totals
    // are treated as zero (full rebuild, not a delta on top of them).
    const plans = [];
    let overallStart = null;
    for (const emp of activeEmployees) {
        const existing = existingByUid.get(emp.uid);
        let rangeStart;
        if (existing && !force) {
            rangeStart = addDaysStr(dateOnly(existing.last_computed_date), 1);
        } else if (existing && force) {
            rangeStart = dateOnly(existing.accrual_start_date);
        } else {
            const earliest = await fetchEarliestAttendanceDate(emp.uid);
            if (!earliest) continue; // never punched in yet — nothing to accrue
            rangeStart = earliest;
        }
        if (rangeStart > endDate) continue; // already up to date

        plans.push({ emp, existing: force ? null : existing, rangeStart });
        if (overallStart === null || rangeStart < overallStart) overallStart = rangeStart;
    }

    if (!plans.length) return { processed: 0, skipped: activeEmployees.length, asOfDate: endDate };

    const weekDays = enumerateWeekdays(overallStart, endDate);
    const activeUids = plans.map(p => p.emp.uid);

    const { rows: attendanceRows } = await global.attendancePool.query(`
        SELECT uid, work_date, arrival_time, departure_time, entries
        FROM public.attendance_daily
        WHERE work_date BETWEEN $1 AND $2 AND uid = ANY($3::int[])
    `, [overallStart, endDate, activeUids]);
    const attendanceMap = new Map();
    attendanceRows.forEach(row => {
        attendanceMap.set(`${row.uid}__${dateOnly(row.work_date)}`, row);
    });

    const approvedRequests = await fetchApprovedRequests(overallStart, endDate);
    const approvedRequestMap = buildApprovedRequestMap(approvedRequests, overallStart, endDate);
    const specialDays = await fetchSpecialDays(overallStart, endDate);

    let processed = 0;
    for (const { emp, existing, rangeStart } of plans) {
        const daysForEmployee = weekDays.filter(d => d >= rangeStart && d <= endDate);

        let creditedMinutesDelta = 0;
        let takenDaysDelta = 0;

        for (const date of daysForEmployee) {
            const attRow = attendanceMap.get(`${emp.uid}__${date}`) || null;
            const requestsForDay = approvedRequestMap.get(`${emp.hrId}__${date}`) || [];
            const specialDaysForDate = specialDays.byDate.get(date) || [];
            const result = computeDayResult(attRow, requestsForDay, date, specialDaysForDate);

            creditedMinutesDelta += creditedMinutesForDay(result);
            takenDaysDelta += result.congeDays || 0;
        }

        const prevCreditedHours = existing ? Number(existing.credited_hours) : 0;
        const prevTakenDays = existing ? Number(existing.taken_days) : 0;
        const accrualStartDate = existing ? dateOnly(existing.accrual_start_date) : rangeStart;

        const creditedHours = prevCreditedHours + creditedMinutesDelta / 60;
        const takenDays = prevTakenDays + takenDaysDelta;
        const accruedDays = (creditedHours / ACCRUAL_HOURS_PER_UNIT) * ACCRUAL_DAYS_PER_UNIT;
        const balanceDays = accruedDays - takenDays;

        await global.attendancePool.query(`
            INSERT INTO public.leave_balance
                (uid, matricule, full_name, accrual_start_date, credited_hours, accrued_days, taken_days, balance_days, last_computed_date, updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
            ON CONFLICT (uid) DO UPDATE SET
                matricule = EXCLUDED.matricule,
                full_name = EXCLUDED.full_name,
                credited_hours = EXCLUDED.credited_hours,
                accrued_days = EXCLUDED.accrued_days,
                taken_days = EXCLUDED.taken_days,
                balance_days = EXCLUDED.balance_days,
                last_computed_date = EXCLUDED.last_computed_date,
                updated_at = now()
        `, [
            emp.uid, emp.matricule, emp.name, accrualStartDate,
            creditedHours.toFixed(2), accruedDays.toFixed(3), takenDays.toFixed(3), balanceDays.toFixed(3),
            endDate,
        ]);

        processed++;
    }

    return { processed, skipped: activeEmployees.length - processed, asOfDate: endDate };
}

async function getAllLeaveBalances() {
    await ensureLeaveBalanceTable();
    const { rows } = await global.attendancePool.query(
        `SELECT * FROM public.leave_balance ORDER BY full_name`
    );
    return rows;
}

async function getLeaveBalanceForUid(uid) {
    await ensureLeaveBalanceTable();
    const { rows } = await global.attendancePool.query(
        `SELECT * FROM public.leave_balance WHERE uid = $1`,
        [uid]
    );
    return rows[0] || null;
}

module.exports = {
    ensureLeaveBalanceTable,
    recomputeLeaveBalances,
    getAllLeaveBalances,
    getLeaveBalanceForUid,
    ACCRUAL_HOURS_PER_UNIT,
    ACCRUAL_DAYS_PER_UNIT,
};
