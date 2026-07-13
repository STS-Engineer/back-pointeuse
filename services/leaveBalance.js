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

// 1.82 leave days earned per 173.33 credited hours (real work + approved
// conge valued at 8h/day; holidays not credited), applied continuously.
const ACCRUAL_HOURS_PER_UNIT = 173.33;
const ACCRUAL_DAYS_PER_UNIT = 1.82;

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
// congé valued at a full 8h (half-day congé already contributes 4h via
// workedMinutes and 4h via congeDays*8, per computeDayResult). Holidays are
// intentionally NOT credited — only actual work and approved congé count.
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
 * Advances the REAL rh_application.leave_balances table (employee_id,
 * balance, updated_at — a pre-existing table, not created by this
 * codebase) through asOfDate (default: yesterday, since "today" may still
 * be in progress).
 *
 * Each row's own updated_at IS the resume checkpoint — there is no separate
 * bookkeeping table. Whatever balance is currently stored is trusted as
 * correct as of that timestamp; only newly credited hours / newly taken
 * congé since then get added on top. Employees with no existing row yet
 * start from their earliest attendance record with balance 0.
 *
 * Idempotent per employee: once updated_at reaches asOfDate, re-running is
 * a no-op for that employee (nothing to add), so this is safe to run daily
 * via cron or re-trigger manually without double-crediting.
 *
 * Pass { employeeIds, sinceDate } to force a manual rewind: re-checks the
 * window from sinceDate forward even for employees already marked past it,
 * and ADDS the freshly computed delta on top of their current balance. This
 * is for the case where attendance data arrived AFTER the cron already ran
 * for that window (e.g. the ZKTeco device was down and data got backfilled
 * later) — the earlier pass genuinely credited 0 for those days since there
 * was nothing to see yet, so adding the now-available delta on top is
 * correct. It is NOT a general "redo any window" tool — if a window already
 * contributed a non-zero delta, rewinding it would double-count that part.
 */
async function recomputeLeaveBalances({ asOfDate, employeeIds = null, sinceDate = null } = {}) {
    const endDate = asOfDate || yesterdayInTz();

    const employees = await fetchActiveReportEmployees();
    let eligible = employees.filter(e =>
        e.uid !== null && e.uid !== undefined && e.hrId !== null && e.hrId !== undefined
    );
    if (Array.isArray(employeeIds) && employeeIds.length) {
        const idSet = new Set(employeeIds.map(Number));
        eligible = eligible.filter(e => idSet.has(e.hrId));
    }
    if (!eligible.length) return { processed: 0, skipped: 0, asOfDate: endDate };

    const { rows: existingRows } = await global.hrPool.query(
        `SELECT employee_id, balance, updated_at FROM public.leave_balances WHERE employee_id = ANY($1::int[])`,
        [eligible.map(e => e.hrId)]
    );
    const existingByHrId = new Map(existingRows.map(r => [r.employee_id, r]));

    // Work out each employee's [rangeStart, endDate] window first, and the
    // earliest rangeStart across everyone, so attendance/requests/special
    // days can be fetched once for the whole span instead of per employee.
    const plans = [];
    let overallStart = null;
    for (const emp of eligible) {
        const existing = existingByHrId.get(emp.hrId);
        let rangeStart;
        if (sinceDate) {
            rangeStart = sinceDate;
        } else if (existing) {
            rangeStart = addDaysStr(dateOnly(existing.updated_at), 1);
        } else {
            const earliest = await fetchEarliestAttendanceDate(emp.uid);
            if (!earliest) continue; // never punched in yet — nothing to accrue
            rangeStart = earliest;
        }
        if (rangeStart > endDate) continue; // already up to date

        plans.push({ emp, existing, rangeStart });
        if (overallStart === null || rangeStart < overallStart) overallStart = rangeStart;
    }

    if (!plans.length) return { processed: 0, skipped: eligible.length, asOfDate: endDate };

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

        const accruedDelta = (creditedMinutesDelta / 60 / ACCRUAL_HOURS_PER_UNIT) * ACCRUAL_DAYS_PER_UNIT;
        const prevBalance = existing ? Number(existing.balance) : 0;
        const newBalance = prevBalance + accruedDelta - takenDaysDelta;

        await global.hrPool.query(`
            INSERT INTO public.leave_balances (employee_id, balance, updated_at)
            VALUES ($1, $2, now())
            ON CONFLICT (employee_id) DO UPDATE SET
                balance = EXCLUDED.balance,
                updated_at = EXCLUDED.updated_at
        `, [emp.hrId, newBalance.toFixed(3)]);

        processed++;
    }

    return { processed, skipped: eligible.length - processed, asOfDate: endDate };
}

async function getAllLeaveBalances() {
    const { rows } = await global.hrPool.query(
        `SELECT * FROM public.leave_balances ORDER BY employee_id`
    );
    return rows;
}

async function getLeaveBalanceForEmployeeId(employeeId) {
    const { rows } = await global.hrPool.query(
        `SELECT * FROM public.leave_balances WHERE employee_id = $1`,
        [employeeId]
    );
    return rows[0] || null;
}

module.exports = {
    recomputeLeaveBalances,
    getAllLeaveBalances,
    getLeaveBalanceForEmployeeId,
    ACCRUAL_HOURS_PER_UNIT,
    ACCRUAL_DAYS_PER_UNIT,
};
