const express = require('express');
const router = express.Router();

// ── CORS ───────────────────────────────────────────────────────
router.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
});

// ══════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ══════════════════════════════════════════════════════════════

function toMinutesFromTime(value) {
    if (!value) return null;
    const s = typeof value === 'string' ? value : String(value);
    const match = s.match(/^(\d{1,2}):(\d{2})/);
    if (!match) return null;
    return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
}

function formatMinutesToHours(minutes) {
    if (minutes === null || minutes === undefined || isNaN(minutes) || minutes < 0) return '0h00';
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return `${h}h${String(m).padStart(2, '0')}`;
}

function formatTimeHHMM(value) {
    if (!value) return null;
    return String(value).slice(0, 5);
}

function pad2(n) {
    return String(n).padStart(2, '0');
}

function formatLocalDate(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function parseLocalDate(dateStr) {
    const [y, m, d] = String(dateStr).split('-').map(Number);
    return new Date(y, m - 1, d);
}

// ✅ FIX 1: Safe date string extraction — handles PostgreSQL Date objects correctly
// String(dateObject) gives "Mon Apr 20 2026 ..." which is wrong
// dateObject.toISOString() gives "2026-04-20T00:00:00.000Z" which is correct
function safeDateStr(value) {
    if (!value) return null;
    if (value instanceof Date) return value.toISOString().split('T')[0];
    return String(value).split('T')[0];
}

function normalizeTypeDemande(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase();
}

function normalizeMatricule(value) {
    return String(value || '').trim();
}

// ✅ FIX (overpayment bug): compute worked minutes from the raw arrival/departure SPAN only.
// This is now used ONLY to decide whether the lunch deduction applies (span > 4h),
// NOT as the actual worked-time total. Actual worked time comes from
// computePhysicalPresentMinutes() below, which accounts for mid-day gaps
// (e.g. an "autorisation" where the employee badges out and back in).
function computeWorkedMinutes(arrivalTime, departureTime, lunchBreakMinutes = 60) {
    const arrival = toMinutesFromTime(arrivalTime);
    const departure = toMinutesFromTime(departureTime);
    if (arrival === null || departure === null || departure <= arrival) return null;
    const raw = departure - arrival;
    const deduction = raw > 240 ? lunchBreakMinutes : 0;
    return Math.max(0, raw - deduction);
}

// ✅ NEW: sums ACTUAL physical presence time using every punch as alternating IN/OUT pairs,
// instead of only the first (arrival) and last (departure) punch.
//
// Why this matters: previously, hours worked were computed as simply
// (departure - arrival), which silently includes any mid-day gap (e.g. an
// employee badging out for a 2-hour authorized absence and badging back in).
// That gap was then ALSO added on top via the authorization-minutes bonus,
// double-counting the absence and overpaying the employee.
//
// By pairing punches (1st→2nd = present, 2nd→3rd = absent/gap, 3rd→4th = present, ...),
// any gap between badge-out and badge-in is automatically excluded from worked time,
// so adding back approved authorization minutes afterward is now correct instead of
// double-counted.
function computePhysicalPresentMinutes(entries) {
    if (!Array.isArray(entries) || entries.length < 2) return 0;

    const sorted = [...entries]
        .map(e => ({ ...e, _min: toMinutesFromTime(e.time) }))
        .filter(e => e._min !== null)
        .sort((a, b) => a._min - b._min);

    let total = 0;
    for (let i = 0; i + 1 < sorted.length; i += 2) {
        const inMin = sorted[i]._min;
        const outMin = sorted[i + 1]._min;
        if (outMin > inMin) total += (outMin - inMin);
    }
    return total;
}

// ✅ FIX (threshold unification): single source of truth for "late", confirmed at 08:30.
// This same constant is now also used in sync.js / zkteco-service.js when writing
// attendance_daily.status, so the dashboard and the report never disagree again.
const LATE_THRESHOLD = 8 * 60 + 30;

function isLate(arrivalTime) {
    const mins = toMinutesFromTime(arrivalTime);
    return mins !== null && mins > LATE_THRESHOLD;
}

function getWeekKey(dateStr) {
    const date = parseLocalDate(dateStr);
    const monday = new Date(date);
    const day = monday.getDay();
    monday.setDate(date.getDate() - (day === 0 ? 6 : day - 1));
    return formatLocalDate(monday);
}

function groupDatesByWeek(dates) {
    const weeks = [];
    const byKey = new Map();

    dates.forEach(date => {
        const key = getWeekKey(date);
        if (!byKey.has(key)) {
            byKey.set(key, {
                key,
                start: date,
                end: date,
                weekDays: [],
            });
            weeks.push(byKey.get(key));
        }

        const week = byKey.get(key);
        week.weekDays.push(date);
        if (date < week.start) week.start = date;
        if (date > week.end) week.end = date;
    });

    return weeks;
}

function getLateMinutes(arrivalTime) {
    const mins = toMinutesFromTime(arrivalTime);
    if (mins === null || mins <= LATE_THRESHOLD) return 0;
    return mins - LATE_THRESHOLD;
}

function isLateJustified(arrivalTime, requestsForDay) {
    const arrival = toMinutesFromTime(arrivalTime);
    if (arrival === null || arrival <= LATE_THRESHOLD) return false;

    return requestsForDay.some(req => {
        const type = normalizeTypeDemande(req.type_demande);
        if (type !== 'autorisation') return false;

        const start = toMinutesFromTime(req.heure_depart);
        const end = toMinutesFromTime(req.heure_retour);
        if (start === null || end === null) return false;

        return start <= LATE_THRESHOLD && end >= arrival;
    });
}

function getAuthorizationMinutes(req) {
    const start = toMinutesFromTime(req.heure_depart);
    const end = toMinutesFromTime(req.heure_retour);
    if (start === null || end === null || end <= start) return 0;
    return end - start;
}

function enumerateWeekdays(startDateStr, endDateStr) {
    const dates = [];
    const current = parseLocalDate(startDateStr);
    const end = parseLocalDate(endDateStr);

    while (current <= end) {
        const day = current.getDay();
        if (day >= 1 && day <= 5) {
            dates.push(formatLocalDate(current));
        }
        current.setDate(current.getDate() + 1);
    }

    return dates;
}

// ✅ FIX 1 APPLIED: Use safeDateStr() instead of String(...).split('T')[0]
// String(postgresDateObject) returns "Mon Apr 20 2026 02:00:00 GMT+0200"
// which makes parseLocalDate() produce NaN → effectiveEnd = NaN → cursor runs forever
function getRequestDatesInRange(request, startDateStr, endDateStr) {
    const result = [];
    const reportStart = parseLocalDate(startDateStr);
    const reportEnd = parseLocalDate(endDateStr);

    const type = normalizeTypeDemande(request.type_demande);

    const departStr = safeDateStr(request.date_depart);
    const retourStr = safeDateStr(request.date_retour);

    if (!departStr) return result;

    const requestStart = parseLocalDate(departStr);
    const requestEnd = parseLocalDate(retourStr || departStr);

    const effectiveStart = requestStart > reportStart ? requestStart : reportStart;
    const effectiveEnd = requestEnd < reportEnd ? requestEnd : reportEnd;

    if (type === 'autorisation') {
        if (requestStart >= reportStart && requestStart <= reportEnd) {
            const day = requestStart.getDay();
            if (day >= 1 && day <= 5) {
                result.push(formatLocalDate(requestStart));
            }
        }
        return result;
    }

    // Guard: if no overlap, return empty
    if (effectiveStart > effectiveEnd) return result;

    const cursor = new Date(effectiveStart);
    while (cursor <= effectiveEnd) {
        const day = cursor.getDay();
        if (day >= 1 && day <= 5) {
            result.push(formatLocalDate(cursor));
        }
        cursor.setDate(cursor.getDate() + 1);
    }

    return result;
}

// ✅ FIX 1 APPLIED here too: safeDateStr() for date comparisons
function getMissionDayMinutes(req, currentDate) {
    const type = normalizeTypeDemande(req.type_demande);
    if (type !== 'mission') return 0;

    const startDate = safeDateStr(req.date_depart);
    const endDate = safeDateStr(req.date_retour) || startDate;

    if (!startDate) return 0;
    if (currentDate < startDate || currentDate > endDate) return 0;

    const startMin = toMinutesFromTime(req.heure_depart);
    const endMin = toMinutesFromTime(req.heure_retour);

    const WORK_START = 8 * 60 + 30;
    const WORK_END = 17 * 60 + 30;
    const FULL_DAY_MINUTES = 8 * 60;
    const capMissionDay = (minutes) => Math.min(FULL_DAY_MINUTES, Math.max(0, minutes || 0));

    if (startDate === endDate) {
        if (startMin !== null && endMin !== null && endMin > startMin) return capMissionDay(endMin - startMin);
        return FULL_DAY_MINUTES;
    }

    if (currentDate === startDate) {
        if (startMin !== null && WORK_END > startMin) return capMissionDay(WORK_END - startMin);
        return FULL_DAY_MINUTES;
    }

    if (currentDate === endDate) {
        if (endMin !== null && endMin > WORK_START) return capMissionDay(endMin - WORK_START);
        return FULL_DAY_MINUTES;
    }

    return FULL_DAY_MINUTES;
}

function buildApprovedRequestMap(requestRows, startDateStr, endDateStr) {
    const map = new Map();

    for (const req of requestRows) {
        const coveredDates = getRequestDatesInRange(req, startDateStr, endDateStr);
        for (const date of coveredDates) {
            const key = `${req.employe_id}__${date}`;
            if (!map.has(key)) map.set(key, []);
            map.get(key).push(req);
        }
    }

    return map;
}

async function ensureSpecialDaysTable() {
    await global.attendancePool.query(`
        CREATE TABLE IF NOT EXISTS public.attendance_special_days (
            id SERIAL PRIMARY KEY,
            day_date DATE NOT NULL,
            type TEXT NOT NULL CHECK (type IN ('jour_ferie', 'conge_paye_global')),
            label TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (day_date, type)
        )
    `);
}

async function fetchSpecialDays(startDate, endDate) {
    try {
        await ensureSpecialDaysTable();
        const { rows } = await global.attendancePool.query(`
            SELECT id, day_date::text AS date, type, label
            FROM public.attendance_special_days
            WHERE day_date BETWEEN $1 AND $2
            ORDER BY day_date ASC, type ASC
        `, [startDate, endDate]);

        const byDate = new Map();
        rows.forEach(row => {
            if (!byDate.has(row.date)) byDate.set(row.date, []);
            byDate.get(row.date).push(row);
        });

        return { rows, byDate };
    } catch (e) {
        console.warn('Could not fetch special days:', e.message);
        return { rows: [], byDate: new Map() };
    }
}

function computeDayResult(attendanceRow, requestsForDay, currentDate, specialDaysForDate = []) {
    const arrival = attendanceRow?.arrival_time ? formatTimeHHMM(attendanceRow.arrival_time) : null;
    const departure = attendanceRow?.departure_time ? formatTimeHHMM(attendanceRow.departure_time) : null;
    const hasAttendance = !!(arrival || departure);

    const holiday = specialDaysForDate.find(d => d.type === 'jour_ferie');
    if (holiday) {
        return {
            workedMinutes: 0,
            displayText: holiday.label ? `Ferie (${holiday.label})` : 'Jour ferie',
            isLate: false,
            lateMinutes: 0,
            lateJustified: false,
            status: 'ferie',
            arrival: null,
            departure: null,
            congeDays: 0,
            isHoliday: true,
            isGlobalPaidLeave: false,
        };
    }

    const globalPaidLeave = specialDaysForDate.find(d => d.type === 'conge_paye_global');
    if (globalPaidLeave && !hasAttendance) {
        return {
            workedMinutes: 0,
            displayText: globalPaidLeave.label ? `Conge paye (${globalPaidLeave.label})` : 'Conge paye',
            isLate: false,
            lateMinutes: 0,
            lateJustified: false,
            status: 'conge_global',
            arrival: null,
            departure: null,
            congeDays: 1,
            isHoliday: false,
            isGlobalPaidLeave: true,
        };
    }

    const conges = requestsForDay.filter(r => normalizeTypeDemande(r.type_demande) === 'conges');
    const autorisations = requestsForDay.filter(r => normalizeTypeDemande(r.type_demande) === 'autorisation');
    const missions = requestsForDay.filter(r => normalizeTypeDemande(r.type_demande) === 'mission');

    const conge = conges[0] || null;

    // Half-day congé always shows regardless of attendance
    // (employee badges in for the other half, so hasAttendance=true — we must not skip it)
    //
    // Full-day congé: CONFIRMED RULE — if the employee has any attendance punch that day,
    // the congé is overridden and the day is treated as a normal worked day instead.
    // (i.e. we intentionally fall through to the worked-time logic below when hasAttendance
    // is true; this is NOT a bug, it's the confirmed business rule.)
    if (conge) {
        if (conge.demi_journee) {
            return {
                workedMinutes: 240,
                displayText: '4h00 (conge 1/2J)',
                isLate: false,
                lateMinutes: 0,
                lateJustified: false,
                status: 'conge_demi',
                arrival: null,
                departure: null,
                congeDays: 0.5,
                isHoliday: false,
                isGlobalPaidLeave: false,
            };
        }
        // Full-day congé: only show if no attendance record
        if (!hasAttendance) {
            return {
                workedMinutes: 0,
                displayText: 'Congé',
                isLate: false,
                lateMinutes: 0,
                lateJustified: false,
                status: 'conge',
                arrival: null,
                departure: null,
                congeDays: 1,
                isHoliday: false,
                isGlobalPaidLeave: false,
            };
        }
        // else: fall through — employee badged in despite approved congé,
        // treat the day as worked (confirmed rule).
    }

    const hasMission = missions.length > 0;
    const totalMissionMins = Math.min(8 * 60, missions.reduce((s, r) => s + getMissionDayMinutes(r, currentDate), 0));
    if (hasMission && !hasAttendance) {
        return {
            workedMinutes: totalMissionMins,
            displayText: totalMissionMins ? `${formatMinutesToHours(totalMissionMins)} (mission)` : 'Mission',
            isLate: false,
            lateMinutes: 0,
            lateJustified: false,
            status: 'mission',
            arrival: null,
            departure: null,
            congeDays: 0,
            isHoliday: false,
            isGlobalPaidLeave: false,
        };
    }

    // ✅ FIX (overpayment bug): worked time is now based on ACTUAL physical presence
    // (every punch pair), not just first-arrival → last-departure. The lunch deduction
    // is still applied once, based on whether the overall span exceeds 4h (unchanged rule).
    const physicalMinutes = computePhysicalPresentMinutes(attendanceRow?.entries);
    const rawSpan = computeWorkedMinutes(arrival, departure, 0); // span only, no deduction, just to decide lunch
    const lunchDeduction = (rawSpan !== null && rawSpan > 240) ? 60 : 0;
    const workedRaw = physicalMinutes > 0 ? Math.max(0, physicalMinutes - lunchDeduction) : null;

    const totalAuthMins = autorisations.reduce((s, r) => s + getAuthorizationMinutes(r), 0);

    const lateJustified = isLateJustified(arrival, requestsForDay);
    const late = arrival ? isLate(arrival) && !lateJustified : false;
    const lateMinutes = late ? getLateMinutes(arrival) : 0;

    if (workedRaw !== null) {
        // Approved mission/authorisation time fills missing work time up to a normal
        // 8h day, but does not inflate an already complete pointage day.
        let finalMinutes = workedRaw;
        let detail = `${arrival} → ${departure}`;
        const notes = [];
        let correctionMinutes = 0;

        if (totalAuthMins > 0) {
            correctionMinutes += totalAuthMins;
            notes.push(`autorisation ${formatMinutesToHours(totalAuthMins)}`);
        }

        if (totalMissionMins > 0) {
            correctionMinutes += totalMissionMins;
            notes.push(`mission ${formatMinutesToHours(totalMissionMins)}`);
        }

        if (correctionMinutes > 0) {
            finalMinutes = Math.max(workedRaw, Math.min(8 * 60, workedRaw + correctionMinutes));
        }

        if (notes.length) detail += ` (${notes.join(', ')})`;

        return {
            workedMinutes: finalMinutes,
            displayText: `${formatMinutesToHours(finalMinutes)} (${detail})`,
            isLate: late,
            lateMinutes,
            lateJustified,
            status: hasMission ? 'mission' : (late ? 'late' : 'present'),
            arrival,
            departure,
            congeDays: 0,
            isHoliday: false,
            isGlobalPaidLeave: false,
        };
    }

    if (arrival || departure) {
        const notes = [];
        if (totalAuthMins > 0) notes.push(`autorisation ${formatMinutesToHours(totalAuthMins)}`);
        if (totalMissionMins > 0) notes.push(`mission ${formatMinutesToHours(totalMissionMins)}`);
        const detail = notes.length ? ` (${notes.join(', ')})` : '';
        const correctedMinutes = totalMissionMins > 0 ? totalMissionMins : 0;

        return {
            workedMinutes: correctedMinutes,
            displayText: `${arrival || '?'} → ${departure || '?'} (incomplet${detail})`,
            isLate: false,
            lateMinutes: 0,
            lateJustified: false,
            status: hasMission ? 'mission' : 'incomplete',
            arrival,
            departure,
            congeDays: 0,
            isHoliday: false,
            isGlobalPaidLeave: false,
        };
    }

    // No attendance, no requests
    return {
        workedMinutes: 0,
        displayText: '—',
        isLate: false,
        lateMinutes: 0,
        lateJustified: false,
        status: 'absent',
        arrival: null,
        departure: null,
    };
}

// ══════════════════════════════════════════════════════════════
// ACTIVE EMPLOYEE SOURCE OF TRUTH
// ══════════════════════════════════════════════════════════════

async function fetchActiveHrEmployees() {
    if (!global.hrPool) {
        throw new Error('global.hrPool is required to filter active employees');
    }

    const { rows } = await global.hrPool.query(`
        SELECT id, matricule, nom, prenom
        FROM employees
        WHERE date_depart IS NULL
          AND COALESCE(statut, 'actif') = 'actif'
        ORDER BY nom, prenom
    `);

    return rows;
}

async function fetchActiveReportEmployees() {
    const activeHrEmployees = await fetchActiveHrEmployees();
    const matricules = activeHrEmployees
        .map(e => normalizeMatricule(e.matricule))
        .filter(Boolean);

    if (!matricules.length) return [];

    const { rows: attendanceEmployees } = await global.attendancePool.query(`
        SELECT uid, matricule, pointeuse_user_id, full_name, card_no, updated_at
        FROM public.employees
        WHERE matricule = ANY($1::text[])
    `, [matricules]);

    const attendanceByMatricule = new Map();
    attendanceEmployees.forEach(row => {
        const key = normalizeMatricule(row.matricule);
        if (key) attendanceByMatricule.set(key, row);
    });

    return activeHrEmployees.map(hrEmp => {
        const matricule = normalizeMatricule(hrEmp.matricule);
        const attEmp = attendanceByMatricule.get(matricule) || null;
        const hrName = `${hrEmp.prenom || ''} ${hrEmp.nom || ''}`.trim();

        return {
            hrId: hrEmp.id,
            uid: attEmp?.uid ?? null,
            matricule: hrEmp.matricule,
            name: attEmp?.full_name || hrName,
            cardNo: attEmp?.card_no || null,
            pointeuseUserId: attEmp?.pointeuse_user_id || null,
            updatedAt: attEmp?.updated_at || null,
        };
    });
}

function getActiveUids(employees) {
    return employees
        .filter(e => e.uid !== null && e.uid !== undefined)
        .map(e => e.uid);
}

// ══════════════════════════════════════════════════════════════
// FETCH HR APPROVED REQUESTS
// ══════════════════════════════════════════════════════════════

async function fetchApprovedRequests(startDate, endDate) {
    if (!global.hrPool) return [];

    try {
        const { rows } = await global.hrPool.query(`
            SELECT id, employe_id, type_demande, titre,
                   date_depart, date_retour,
                   heure_depart, heure_retour,
                   demi_journee, type_conge
            FROM demande_rh
            WHERE statut = 'approuve'
              AND date_depart <= $2
              AND COALESCE(date_retour, date_depart) >= $1
        `, [startDate, endDate]);

        return rows;
    } catch (e) {
        console.warn('⚠️ Could not fetch HR requests:', e.message);
        return [];
    }
}

// ══════════════════════════════════════════════════════════════
// GET /api/attendance
// ══════════════════════════════════════════════════════════════

router.get('/attendance', async (req, res) => {
    try {
        const employees = await fetchActiveReportEmployees();
        const activeUids = getActiveUids(employees);

        if (!activeUids.length) {
            return res.json({ success: true, count: 0, data: [], fetchedAt: new Date().toISOString() });
        }

        const { rows } = await global.attendancePool.query(`
            SELECT
                d.uid,
                d.user_id            AS "userId",
                d.pointeuse_user_id  AS "pointeuseUserId",
                d.full_name          AS name,
                d.card_no            AS "cardNo",
                d.work_date::text    AS date,
                d.day_name           AS "dayName",
                to_char(d.arrival_time,   'HH24:MI') AS "arrivalTime",
                to_char(d.departure_time, 'HH24:MI') AS "departureTime",
                d.hours_worked::text AS "hoursWorked",
                d.status,
                d.entries,
                d.last_update        AS "lastUpdate"
            FROM public.attendance_daily d
            WHERE d.uid = ANY($1::int[])
            ORDER BY d.work_date DESC, d.full_name ASC
        `, [activeUids]);

        res.json({
            success: true,
            count: rows.length,
            data: rows,
            fetchedAt: new Date().toISOString(),
        });

    } catch (error) {
        console.error('❌ GET /attendance error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ══════════════════════════════════════════════════════════════
// GET /api/employees
// ══════════════════════════════════════════════════════════════

router.get('/employees', async (req, res) => {
    try {
        const activeEmployees = await fetchActiveReportEmployees();

        const employees = activeEmployees.map(emp => ({
            uid: emp.uid,
            matricule: emp.matricule,
            pointeuseUserId: emp.pointeuseUserId,
            name: emp.name,
            cardNo: emp.cardNo,
            updatedAt: emp.updatedAt,
        }));

        res.json({ success: true, count: employees.length, employees });
    } catch (error) {
        console.error('❌ GET /employees error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/special-days', async (req, res) => {
    try {
        const start = req.query.start || formatLocalDate(new Date());
        const end = req.query.end || start;
        const data = await fetchSpecialDays(start, end);
        res.json({ success: true, days: data.rows });
    } catch (error) {
        console.error('❌ GET /special-days error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/special-days', async (req, res) => {
    try {
        const { date, type, label } = req.body || {};
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
            return res.status(400).json({ success: false, error: 'date must be YYYY-MM-DD' });
        }
        if (!['jour_ferie', 'conge_paye_global'].includes(type)) {
            return res.status(400).json({ success: false, error: 'invalid type' });
        }

        await ensureSpecialDaysTable();
        const { rows } = await global.attendancePool.query(`
            INSERT INTO public.attendance_special_days (day_date, type, label)
            VALUES ($1, $2, $3)
            ON CONFLICT (day_date, type)
            DO UPDATE SET label = EXCLUDED.label
            RETURNING id, day_date::text AS date, type, label
        `, [date, type, label || null]);

        res.json({ success: true, day: rows[0] });
    } catch (error) {
        console.error('❌ POST /special-days error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.delete('/special-days/:id', async (req, res) => {
    try {
        await ensureSpecialDaysTable();
        const { rowCount } = await global.attendancePool.query(
            'DELETE FROM public.attendance_special_days WHERE id = $1',
            [req.params.id]
        );
        res.json({ success: true, deleted: rowCount });
    } catch (error) {
        console.error('❌ DELETE /special-days error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ══════════════════════════════════════════════════════════════
// GET /api/summary
// ══════════════════════════════════════════════════════════════

router.get('/summary', async (req, res) => {
    try {
        const today = formatLocalDate(new Date());
        const employees = await fetchActiveReportEmployees();
        const activeUids = getActiveUids(employees);

        const [todayStats, totalRecords, lastSync] = await Promise.all([
            activeUids.length
                ? global.attendancePool.query(`
                    SELECT
                        COUNT(*) FILTER (WHERE status != 'Absent') AS present,
                        COUNT(*) FILTER (WHERE status = 'En retard') AS late,
                        COUNT(*) FILTER (WHERE status = 'En cours') AS in_progress,
                        COUNT(*) FILTER (WHERE status = 'Absent') AS absent
                    FROM public.attendance_daily
                    WHERE work_date = $1
                      AND uid = ANY($2::int[])
                `, [today, activeUids])
                : { rows: [{ present: 0, late: 0, in_progress: 0, absent: 0 }] },
            activeUids.length
                ? global.attendancePool.query(`
                    SELECT COUNT(*) AS count
                    FROM public.attendance_daily
                    WHERE uid = ANY($1::int[])
                `, [activeUids])
                : { rows: [{ count: 0 }] },
            global.attendancePool.query(`
                SELECT started_at, finished_at, success, message
                FROM public.sync_runs
                ORDER BY started_at DESC LIMIT 1
            `),
        ]);

        const sync = lastSync.rows[0] || null;

        res.json({
            success: true,
            summary: {
                totalEmployees: employees.length,
                totalRecords: parseInt(totalRecords.rows[0].count, 10),
                today: {
                    date: today,
                    present: parseInt(todayStats.rows[0].present, 10),
                    late: parseInt(todayStats.rows[0].late, 10),
                    inProgress: parseInt(todayStats.rows[0].in_progress, 10),
                    absent: parseInt(todayStats.rows[0].absent, 10),
                },
                lastSync: sync ? {
                    startedAt: sync.started_at,
                    finishedAt: sync.finished_at,
                    success: sync.success,
                    message: sync.message,
                } : null,
                fetchedAt: new Date().toISOString(),
            },
        });
    } catch (error) {
        console.error('❌ GET /summary error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ══════════════════════════════════════════════════════════════
// GET /api/sync/history
// ══════════════════════════════════════════════════════════════

router.get('/sync/history', async (req, res) => {
    try {
        const { rows } = await global.attendancePool.query(`
            SELECT id, started_at, finished_at, success, message, details
            FROM public.sync_runs
            ORDER BY started_at DESC LIMIT 10
        `);

        res.json({ success: true, history: rows });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ══════════════════════════════════════════════════════════════
// GET /api/health
// ══════════════════════════════════════════════════════════════

router.get('/health', async (req, res) => {
    try {
        await global.attendancePool.query('SELECT 1');
        if (global.hrPool) await global.hrPool.query('SELECT 1');
        res.json({
            success: true,
            status: 'healthy',
            database: 'connected',
            timestamp: new Date().toISOString(),
        });
    } catch (error) {
        res.status(500).json({ success: false, status: 'unhealthy', error: error.message });
    }
});

// ══════════════════════════════════════════════════════════════
// GET /api/report?start=YYYY-MM-DD&end=YYYY-MM-DD
// ══════════════════════════════════════════════════════════════

router.get('/report', async (req, res) => {
    try {
        let { start, end } = req.query;

        if (!start || !end) {
            const today = new Date();
            const day = today.getDay();
            const monday = new Date(today);
            monday.setDate(today.getDate() - (day === 0 ? 6 : day - 1));

            start = formatLocalDate(monday);
            end = formatLocalDate(today);
        }

        const weekDays = enumerateWeekdays(start, end);
        if (weekDays.length === 0) {
            return res.json({ success: true, start, end, weekDays: [], employees: [], summary: {} });
        }

        // 1. Fetch active employees from HR, match to attendance by matricule
        const employees = await fetchActiveReportEmployees();
        const activeUids = getActiveUids(employees);

        // 2. Fetch attendance data for active employees only
        const attendanceResult = activeUids.length
            ? await global.attendancePool.query(`
                SELECT uid, full_name, work_date, arrival_time, departure_time, status, entries
                FROM public.attendance_daily
                WHERE work_date BETWEEN $1 AND $2
                  AND uid = ANY($3::int[])
                ORDER BY work_date, full_name
            `, [start, end, activeUids])
            : { rows: [] };

        const attendanceMap = new Map();
        attendanceResult.rows.forEach(row => {
            const date = row.work_date instanceof Date
                ? formatLocalDate(row.work_date)
                : String(row.work_date).split('T')[0];

            attendanceMap.set(`${row.uid}__${date}`, row);
        });

        // 3. Fetch HR approved requests
        const approvedRequests = await fetchApprovedRequests(start, end);
        const approvedRequestMap = buildApprovedRequestMap(approvedRequests, start, end);
        const specialDays = await fetchSpecialDays(start, end);

        // 4. Build per-employee report
        let totalWorkedMinutes = 0;
        let totalLateCount = 0;
        let totalLateMinutes = 0;
        let totalCongeDays = 0;
        let totalHolidayDays = 0;

        const employeeReports = employees.map(emp => {
            let empTotalMinutes = 0;
            let empLateCount = 0;
            let empLateMinutes = 0;
            let empCongeDays = 0;
            let empHolidayDays = 0;

            const days = weekDays.map(date => {
                const attRow = emp.uid !== null && emp.uid !== undefined
                    ? attendanceMap.get(`${emp.uid}__${date}`)
                    : null;

                const requestsForDay = approvedRequestMap.get(`${emp.hrId}__${date}`) || [];
                const specialDaysForDate = specialDays.byDate.get(date) || [];
                const result = computeDayResult(attRow, requestsForDay, date, specialDaysForDate);

                empTotalMinutes += result.workedMinutes;
                empCongeDays += result.congeDays || 0;
                empHolidayDays += result.status === 'ferie' ? 1 : 0;
                if (result.isLate) {
                    empLateCount++;
                    empLateMinutes += result.lateMinutes;
                }

                return {
                    date,
                    ...result,
                    arrival: result.arrival || formatTimeHHMM(attRow?.arrival_time) || null,
                    departure: result.departure || formatTimeHHMM(attRow?.departure_time) || null,
                };
            });

            totalWorkedMinutes += empTotalMinutes;
            totalLateCount += empLateCount;
            totalLateMinutes += empLateMinutes;
            totalCongeDays += empCongeDays;
            totalHolidayDays += empHolidayDays;

            return {
                uid: emp.uid,
                name: emp.name,
                cardNo: emp.cardNo,
                matricule: emp.matricule,
                totalMinutes: empTotalMinutes,
                totalHours: formatMinutesToHours(empTotalMinutes),
                lateCount: empLateCount,
                lateMinutes: empLateMinutes,
                congeDays: empCongeDays,
                holidayDays: empHolidayDays,
                days,
            };
        });

        const weeks = groupDatesByWeek(weekDays).map((week, index) => {
            let weekWorkedMinutes = 0;
            let weekLateCount = 0;
            let weekLateMinutes = 0;
            let weekCongeDays = 0;
            let weekHolidayDays = 0;

            const weekEmployees = employeeReports.map(emp => {
                const days = emp.days.filter(day => week.weekDays.includes(day.date));
                const totalMinutes = days.reduce((sum, day) => sum + day.workedMinutes, 0);
                const lateCount = days.filter(day => day.isLate).length;
                const lateMinutes = days.reduce((sum, day) => sum + (day.lateMinutes || 0), 0);
                const congeDays = days.reduce((sum, day) => sum + (day.congeDays || 0), 0);
                const holidayDays = days.filter(day => day.status === 'ferie').length;

                weekWorkedMinutes += totalMinutes;
                weekLateCount += lateCount;
                weekLateMinutes += lateMinutes;
                weekCongeDays += congeDays;
                weekHolidayDays += holidayDays;

                return {
                    uid: emp.uid,
                    name: emp.name,
                    cardNo: emp.cardNo,
                    matricule: emp.matricule,
                    totalMinutes,
                    totalHours: formatMinutesToHours(totalMinutes),
                    lateCount,
                    lateMinutes,
                    congeDays,
                    holidayDays,
                    days,
                };
            });

            const holidayDates = week.weekDays.filter(date =>
                (specialDays.byDate.get(date) || []).some(day => day.type === 'jour_ferie')
            );

            return {
                index: index + 1,
                start: week.start,
                end: week.end,
                weekDays: week.weekDays,
                employees: weekEmployees,
                summary: {
                    workingDays: week.weekDays.length,
                    holidayDays: holidayDates.length,
                    holidayDates,
                    totalWorkedMinutes: weekWorkedMinutes,
                    totalWorkedHours: formatMinutesToHours(weekWorkedMinutes),
                    totalLateCount: weekLateCount,
                    totalLateMinutes: weekLateMinutes,
                    totalCongeDays: weekCongeDays,
                    totalHolidayDays: weekHolidayDays,
                    employeesWithData: weekEmployees.filter(e => e.totalMinutes > 0 || e.congeDays > 0).length,
                },
            };
        });

        const holidayDates = weekDays.filter(date =>
            (specialDays.byDate.get(date) || []).some(day => day.type === 'jour_ferie')
        );

        res.json({
            success: true,
            start,
            end,
            weekDays,
            specialDays: specialDays.rows,
            weeks,
            employees: employeeReports,
            summary: {
                totalEmployees: employees.length,
                workingDays: weekDays.length,
                holidayDays: holidayDates.length,
                holidayDates,
                totalWorkedMinutes,
                totalWorkedHours: formatMinutesToHours(totalWorkedMinutes),
                totalLateCount,
                totalLateMinutes,
                totalCongeDays,
                totalHolidayDays,
                employeesWithData: employeeReports.filter(e => e.totalMinutes > 0 || e.congeDays > 0).length,
            },
            generatedAt: new Date().toISOString(),
        });

    } catch (error) {
        console.error('❌ GET /report error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ══════════════════════════════════════════════════════════════
// GET /api/report/late?start=YYYY-MM-DD&end=YYYY-MM-DD
// ══════════════════════════════════════════════════════════════

router.get('/report/late', async (req, res) => {
    try {
        let { start, end } = req.query;

        if (!start || !end) {
            const today = new Date();
            const day = today.getDay();
            const monday = new Date(today);
            monday.setDate(today.getDate() - (day === 0 ? 6 : day - 1));
            start = formatLocalDate(monday);
            end = formatLocalDate(today);
        }

        const weekDays = enumerateWeekdays(start, end);
        if (!weekDays.length) {
            return res.json({ success: true, start, end, lateArrivals: [], summary: {} });
        }

        const employees = await fetchActiveReportEmployees();
        const activeUids = getActiveUids(employees);

        if (!activeUids.length) {
            return res.json({ success: true, start, end, lateArrivals: [], summary: { totalLate: 0 } });
        }

        const hrIdByUid = new Map();
        employees.forEach(emp => {
            if (emp.uid !== null && emp.uid !== undefined) hrIdByUid.set(emp.uid, emp.hrId);
        });

        // 1. Fetch only active employees with arrival after 08:30 (unified LATE_THRESHOLD)
        const { rows: attRows } = await global.attendancePool.query(`
            SELECT uid, full_name, work_date, arrival_time, departure_time
            FROM public.attendance_daily
            WHERE work_date BETWEEN $1 AND $2
              AND uid = ANY($3::int[])
              AND arrival_time IS NOT NULL
              AND arrival_time > '08:30:00'
            ORDER BY work_date ASC, arrival_time ASC
        `, [start, end, activeUids]);

        if (!attRows.length) {
            return res.json({ success: true, start, end, lateArrivals: [], summary: { totalLate: 0 } });
        }

        // 2. HR corrections
        const approvedRequests = await fetchApprovedRequests(start, end);
        const approvedRequestMap = buildApprovedRequestMap(approvedRequests, start, end);

        // 3. Filter out justified lates
        const lateArrivals = [];

        for (const row of attRows) {
            const date = row.work_date instanceof Date
                ? formatLocalDate(row.work_date)
                : String(row.work_date).split('T')[0];

            const hrId = hrIdByUid.get(row.uid);
            const requestsForDay = hrId ? (approvedRequestMap.get(`${hrId}__${date}`) || []) : [];

            const hasConge = requestsForDay.some(r => normalizeTypeDemande(r.type_demande) === 'conges');
            if (hasConge) continue;

            const arrival = formatTimeHHMM(row.arrival_time);
            const justified = isLateJustified(arrival, requestsForDay);
            if (justified) continue;

            const lateMinutes = getLateMinutes(arrival);

            lateArrivals.push({
                uid: row.uid,
                name: row.full_name,
                date,
                arrival,
                departure: formatTimeHHMM(row.departure_time),
                lateMinutes,
                lateDisplay: formatMinutesToHours(lateMinutes),
            });
        }

        const byDate = {};
        lateArrivals.forEach(r => {
            if (!byDate[r.date]) byDate[r.date] = [];
            byDate[r.date].push(r);
        });

        const byEmployee = {};
        lateArrivals.forEach(r => {
            if (!byEmployee[r.name]) {
                byEmployee[r.name] = { name: r.name, count: 0, totalLateMinutes: 0 };
            }
            byEmployee[r.name].count++;
            byEmployee[r.name].totalLateMinutes += r.lateMinutes;
        });

        res.json({
            success: true,
            start,
            end,
            lateArrivals,
            byDate,
            byEmployee: Object.values(byEmployee).sort((a, b) => b.count - a.count),
            summary: {
                totalLate: lateArrivals.length,
                uniqueEmployees: Object.keys(byEmployee).length,
                totalLateMinutes: lateArrivals.reduce((s, r) => s + r.lateMinutes, 0),
                daysChecked: weekDays.length,
            },
            generatedAt: new Date().toISOString(),
        });

    } catch (error) {
        console.error('❌ GET /report/late error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
