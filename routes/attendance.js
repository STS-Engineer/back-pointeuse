/*const express = require('express');
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

function normalizeTypeDemande(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase();
}

// Compute worked minutes after 1h lunch break deduction
function computeWorkedMinutes(arrivalTime, departureTime, lunchBreakMinutes = 60) {
    const arrival = toMinutesFromTime(arrivalTime);
    const departure = toMinutesFromTime(departureTime);
    if (arrival === null || departure === null || departure <= arrival) return null;
    const raw = departure - arrival;
    const deduction = raw > 240 ? lunchBreakMinutes : 0;
    return Math.max(0, raw - deduction);
}

// Late threshold: 08:30
const LATE_THRESHOLD = 8 * 60 + 30;

function isLate(arrivalTime) {
    const mins = toMinutesFromTime(arrivalTime);
    return mins !== null && mins > LATE_THRESHOLD;
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

// Enumerate weekdays (Mon-Fri) in a date range using LOCAL dates
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

// Get which dates in range a request covers
// Business rule:
// - autorisation = single-day
// - mission = range-based
// - conges = range-based
// - for range-based requests, date_retour is treated as RETURN day and excluded
function getRequestDatesInRange(request, startDateStr, endDateStr) {
    const result = [];
    const reportStart = parseLocalDate(startDateStr);
    const reportEnd = parseLocalDate(endDateStr);
    
    const type = normalizeTypeDemande(request.type_demande);
    const requestStart = parseLocalDate(request.date_depart);
    const requestEnd = parseLocalDate(request.date_retour || request.date_depart);
    
    // ⭐ Déterminer la plage réelle de la demande
    let effectiveStart = requestStart > reportStart ? requestStart : reportStart;
    let effectiveEnd = requestEnd < reportEnd ? requestEnd : reportEnd;
    
    // Pour les autorisations (toujours 1 jour)
    if (type === 'autorisation') {
        // Vérifier si la date de l'autorisation est dans la plage du rapport
        if (requestStart >= reportStart && requestStart <= reportEnd) {
            const day = requestStart.getDay();
            if (day >= 1 && day <= 5) {
                result.push(formatLocalDate(requestStart));
            }
        }
        return result;
    }
    
    // Pour les congés et missions (plage de dates)
    // ⭐ CRITIQUE: Ne pas inclure les jours en dehors de la demande
    const cursor = new Date(effectiveStart);
    
    while (cursor <= effectiveEnd) {
        const day = cursor.getDay();
        if (day >= 1 && day <= 5) { // Uniquement jours ouvrés
            result.push(formatLocalDate(cursor));
        }
        cursor.setDate(cursor.getDate() + 1);
    }
    
    return result;
}
function sameDateStr(a, b) {
    return String(a).split('T')[0] === String(b).split('T')[0];
}

function getMissionDayMinutes(req, currentDate) {
    const type = normalizeTypeDemande(req.type_demande);
    if (type !== 'mission') return 0;

    // ⭐ Vérifier que currentDate est dans la plage de la mission
    const startDate = String(req.date_depart).split('T')[0];
    const endDate = String(req.date_retour || req.date_depart).split('T')[0];
    
    if (currentDate < startDate || currentDate > endDate) {
        return 0; // Pas de mission ce jour
    }

    const startMin = toMinutesFromTime(req.heure_depart);
    const endMin = toMinutesFromTime(req.heure_retour);
    
    const WORK_START = 8 * 60 + 30;   // 08:30
    const WORK_END = 17 * 60 + 30;    // 17:30

    // Mission sur un seul jour
    if (startDate === endDate) {
        if (startMin !== null && endMin !== null && endMin > startMin) {
            return endMin - startMin;
        }
        // Si pas d'heures spécifiées, journée complète de mission
        return 8 * 60; // 8 heures
    }

    // Mission sur plusieurs jours
    // Premier jour
    if (currentDate === startDate) {
        if (startMin !== null && WORK_END > startMin) {
            return WORK_END - startMin;
        }
        return 8 * 60;
    }
    
    // Dernier jour
    if (currentDate === endDate) {
        if (endMin !== null && endMin > WORK_START) {
            return endMin - WORK_START;
        }
        return 8 * 60;
    }
    
    // Jour complet en mission
    return 8 * 60; // 8 heures
}
// Build map: "employeHrId__date" => [requests]
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

// Core day computation
function computeDayResult(attendanceRow, requestsForDay, currentDate) {
    const arrival = attendanceRow?.arrival_time ? formatTimeHHMM(attendanceRow.arrival_time) : null;
    const departure = attendanceRow?.departure_time ? formatTimeHHMM(attendanceRow.departure_time) : null;
    const hasAttendance = !!(arrival || departure);

    const conges = requestsForDay.filter(r => normalizeTypeDemande(r.type_demande) === 'conges');
    const autorisations = requestsForDay.filter(r => normalizeTypeDemande(r.type_demande) === 'autorisation');
    const missions = requestsForDay.filter(r => normalizeTypeDemande(r.type_demande) === 'mission');

    const conge = conges[0] || null;

    // ⭐ Priorité: Congé (si pas de pointage)
    if (conge && !hasAttendance) {
        if (conge.demi_journee) {
            return {
                workedMinutes: 240,
                displayText: '4h00 (congé ½J)',
                isLate: false,
                lateMinutes: 0,
                lateJustified: false,
                status: 'conge_demi',
                arrival: null,
                departure: null,
            };
        }
        return {
            workedMinutes: 0,
            displayText: 'Congé',
            isLate: false,
            lateMinutes: 0,
            lateJustified: false,
            status: 'conge',
            arrival: null,
            departure: null,
        };
    }

    // ⭐ Priorité: Mission complète (sans pointage)
    const hasMission = missions.length > 0;
    if (hasMission && !hasAttendance) {
        const totalMissionMins = missions.reduce((s, r) => s + getMissionDayMinutes(r, currentDate), 0);
        return {
            workedMinutes: totalMissionMins,
            displayText: totalMissionMins ? `${formatMinutesToHours(totalMissionMins)} (mission)` : 'Mission',
            isLate: false,
            lateMinutes: 0,
            lateJustified: false,
            status: 'mission',
            arrival: null,
            departure: null,
        };
    }

    // ⭐ Journée normale avec pointage
    const workedRaw = computeWorkedMinutes(arrival, departure, 60);
    const totalAuthMins = autorisations.reduce((s, r) => s + getAuthorizationMinutes(r), 0);
    const totalMissionMins = missions.reduce((s, r) => s + getMissionDayMinutes(r, currentDate), 0);
    
    const lateJustified = isLateJustified(arrival, requestsForDay);
    const late = arrival ? isLate(arrival) && !lateJustified : false;
    const lateMinutes = late ? getLateMinutes(arrival) : 0;

    if (workedRaw !== null) {
        let finalMinutes = workedRaw;
        let detail = `${arrival} → ${departure}`;
        const notes = [];

        if (totalAuthMins > 0) {
            finalMinutes = Math.max(0, finalMinutes - totalAuthMins);
            notes.push(`-${formatMinutesToHours(totalAuthMins)} autorisation`);
        }

        if (totalMissionMins > 0 && !hasAttendance) {
            // Ne pas ajouter mission si l'employé a pointé (sauf si mission partielle)
            // Pour l'instant, on ignore la mission si pointage présent
        }

        if (notes.length) {
            detail += ` (${notes.join(', ')})`;
        }

        return {
            workedMinutes: finalMinutes,
            displayText: `${formatMinutesToHours(finalMinutes)} (${detail})`,
            isLate: late,
            lateMinutes,
            lateJustified,
            status: late ? 'late' : 'present',
            arrival,
            departure,
        };
    }

    if (arrival || departure) {
        return {
            workedMinutes: 0,
            displayText: `${arrival || '?'} → ${departure || '?'} (incomplet)`,
            isLate: false,
            lateMinutes: 0,
            lateJustified: false,
            status: 'incomplete',
            arrival,
            departure,
        };
    }

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

// Fetch mapping: attendance uid → HR employee id (via matricule)
async function fetchUidToHrIdMap(uids) {
    if (!global.hrPool || !global.attendancePool || !uids.length) return new Map();

    try {
        const attResult = await global.attendancePool.query(
            `SELECT uid, matricule FROM employees WHERE uid = ANY($1::int[])`,
            [uids]
        );

        if (!attResult.rows.length) return new Map();

        const matricules = attResult.rows.map(r => r.matricule).filter(Boolean);
        if (!matricules.length) return new Map();

        const hrResult = await global.hrPool.query(
            `SELECT id, matricule FROM employees WHERE matricule = ANY($1::text[])`,
            [matricules]
        );

        const matriculeToHrId = new Map();
        hrResult.rows.forEach(r => matriculeToHrId.set(String(r.matricule).trim(), r.id));

        const map = new Map();
        attResult.rows.forEach(r => {
            const hrId = matriculeToHrId.get(String(r.matricule).trim());
            if (hrId) {
                map.set(r.uid, hrId);
            } else {
                console.warn(`⚠️ No HR employee match for attendance uid=${r.uid}, matricule=${r.matricule}`);
            }
        });

        return map;
    } catch (e) {
        console.warn('⚠️ Could not build uid→hrId map:', e.message);
        return new Map();
    }
}

// ══════════════════════════════════════════════════════════════
// GET /api/attendance
// ══════════════════════════════════════════════════════════════
router.get('/attendance', async (req, res) => {
    try {
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
            ORDER BY d.work_date DESC, d.full_name ASC
        `);

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
        const { rows } = await global.attendancePool.query(`
            SELECT
                uid,
                matricule,
                pointeuse_user_id AS "pointeuseUserId",
                full_name         AS name,
                card_no           AS "cardNo",
                updated_at        AS "updatedAt"
            FROM public.employees
            ORDER BY full_name ASC
        `);

        res.json({ success: true, count: rows.length, employees: rows });
    } catch (error) {
        console.error('❌ GET /employees error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ══════════════════════════════════════════════════════════════
// GET /api/summary
// ══════════════════════════════════════════════════════════════
router.get('/summary', async (req, res) => {
    try {
        const today = formatLocalDate(new Date());

        const [totalEmployees, todayStats, totalRecords, lastSync] = await Promise.all([
            global.attendancePool.query(`SELECT COUNT(*) AS count FROM public.employees`),
            global.attendancePool.query(`
                SELECT
                    COUNT(*) FILTER (WHERE status != 'Absent') AS present,
                    COUNT(*) FILTER (WHERE status = 'En retard') AS late,
                    COUNT(*) FILTER (WHERE status = 'En cours') AS in_progress,
                    COUNT(*) FILTER (WHERE status = 'Absent') AS absent
                FROM public.attendance_daily
                WHERE work_date = $1
            `, [today]),
            global.attendancePool.query(`SELECT COUNT(*) AS count FROM public.attendance_daily`),
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
                totalEmployees: parseInt(totalEmployees.rows[0].count, 10),
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

        // Default: current week Mon→today
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

        // 1. Fetch all employees from attendance DB
        const employeesResult = await global.attendancePool.query(`
            SELECT uid, matricule, full_name AS name, card_no AS "cardNo"
            FROM public.employees
            ORDER BY full_name ASC
        `);
        const employees = employeesResult.rows;
        const uids = employees.map(e => e.uid);

        // 2. Fetch attendance data for the range
        const attendanceResult = await global.attendancePool.query(`
            SELECT uid, full_name, work_date, arrival_time, departure_time, status
            FROM public.attendance_daily
            WHERE work_date BETWEEN $1 AND $2
              AND uid = ANY($3::int[])
            ORDER BY work_date, full_name
        `, [start, end, uids]);

        // Build map: "uid__date" => row
        const attendanceMap = new Map();
        attendanceResult.rows.forEach(row => {
            const date = row.work_date instanceof Date
                ? formatLocalDate(row.work_date)
                : String(row.work_date).split('T')[0];

            attendanceMap.set(`${row.uid}__${date}`, row);
        });

        // 3. Fetch HR approved requests + build uid→hrId map
        const [approvedRequests, uidToHrId] = await Promise.all([
            fetchApprovedRequests(start, end),
            fetchUidToHrIdMap(uids),
        ]);

        const approvedRequestMap = buildApprovedRequestMap(approvedRequests, start, end);

        // 4. Build per-employee report
        let totalWorkedMinutes = 0;
        let totalLateCount = 0;
        let totalLateMinutes = 0;

        const employeeReports = employees.map(emp => {
            let empTotalMinutes = 0;
            let empLateCount = 0;
            let empLateMinutes = 0;
            const hrId = uidToHrId.get(emp.uid);

            const days = weekDays.map(date => {
                const attRow = attendanceMap.get(`${emp.uid}__${date}`);
                const reqKey = hrId ? `${hrId}__${date}` : null;
                const requestsForDay = reqKey ? (approvedRequestMap.get(reqKey) || []) : [];

                const result = computeDayResult(attRow, requestsForDay, date);

                empTotalMinutes += result.workedMinutes;
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

            return {
                uid: emp.uid,
                name: emp.name,
                cardNo: emp.cardNo,
                matricule: emp.matricule,
                totalMinutes: empTotalMinutes,
                totalHours: formatMinutesToHours(empTotalMinutes),
                lateCount: empLateCount,
                lateMinutes: empLateMinutes,
                days,
            };
        });

        res.json({
            success: true,
            start,
            end,
            weekDays,
            employees: employeeReports,
            summary: {
                totalEmployees: employees.length,
                totalWorkedMinutes,
                totalWorkedHours: formatMinutesToHours(totalWorkedMinutes),
                totalLateCount,
                totalLateMinutes,
                employeesWithData: employeeReports.filter(e => e.totalMinutes > 0).length,
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

        // 1. Fetch only attendance rows where arrival is after 08:30
        const { rows: attRows } = await global.attendancePool.query(`
            SELECT uid, full_name, work_date, arrival_time, departure_time
            FROM public.attendance_daily
            WHERE work_date BETWEEN $1 AND $2
              AND arrival_time IS NOT NULL
              AND arrival_time > '08:30:00'
            ORDER BY work_date ASC, arrival_time ASC
        `, [start, end]);

        if (!attRows.length) {
            return res.json({ success: true, start, end, lateArrivals: [], summary: { totalLate: 0 } });
        }

        const uids = [...new Set(attRows.map(r => r.uid))];

        // 2. HR corrections
        const [approvedRequests, uidToHrId] = await Promise.all([
            fetchApprovedRequests(start, end),
            fetchUidToHrIdMap(uids),
        ]);
        const approvedRequestMap = buildApprovedRequestMap(approvedRequests, start, end);

        // 3. Filter out justified lates
        const lateArrivals = [];

        for (const row of attRows) {
            const date = row.work_date instanceof Date
                ? formatLocalDate(row.work_date)
                : String(row.work_date).split('T')[0];

            const hrId = uidToHrId.get(row.uid);
            const reqKey = hrId ? `${hrId}__${date}` : null;
            const requestsForDay = reqKey ? (approvedRequestMap.get(reqKey) || []) : [];

            // Skip if on approved congé and no attendance conflict resolution is desired
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

module.exports = router;*/
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

function computeWorkedMinutes(arrivalTime, departureTime, lunchBreakMinutes = 60) {
    const arrival = toMinutesFromTime(arrivalTime);
    const departure = toMinutesFromTime(departureTime);
    if (arrival === null || departure === null || departure <= arrival) return null;
    const raw = departure - arrival;
    const deduction = raw > 240 ? lunchBreakMinutes : 0;
    return Math.max(0, raw - deduction);
}

const LATE_THRESHOLD = 8 * 60 + 30;

function isLate(arrivalTime) {
    const mins = toMinutesFromTime(arrivalTime);
    return mins !== null && mins > LATE_THRESHOLD;
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

function getRequestDatesInRange(request, startDateStr, endDateStr) {
    const result = [];
    const reportStart = parseLocalDate(startDateStr);
    const reportEnd = parseLocalDate(endDateStr);

    const type = normalizeTypeDemande(request.type_demande);
    const requestStart = parseLocalDate(String(request.date_depart).split('T')[0]);
    const requestEnd = parseLocalDate(String(request.date_retour || request.date_depart).split('T')[0]);

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

function getMissionDayMinutes(req, currentDate) {
    const type = normalizeTypeDemande(req.type_demande);
    if (type !== 'mission') return 0;

    const startDate = String(req.date_depart).split('T')[0];
    const endDate = String(req.date_retour || req.date_depart).split('T')[0];

    if (currentDate < startDate || currentDate > endDate) return 0;

    const startMin = toMinutesFromTime(req.heure_depart);
    const endMin = toMinutesFromTime(req.heure_retour);

    const WORK_START = 8 * 60 + 30;
    const WORK_END = 17 * 60 + 30;

    if (startDate === endDate) {
        if (startMin !== null && endMin !== null && endMin > startMin) return endMin - startMin;
        return 8 * 60;
    }

    if (currentDate === startDate) {
        if (startMin !== null && WORK_END > startMin) return WORK_END - startMin;
        return 8 * 60;
    }

    if (currentDate === endDate) {
        if (endMin !== null && endMin > WORK_START) return endMin - WORK_START;
        return 8 * 60;
    }

    return 8 * 60;
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

function computeDayResult(attendanceRow, requestsForDay, currentDate) {
    const arrival = attendanceRow?.arrival_time ? formatTimeHHMM(attendanceRow.arrival_time) : null;
    const departure = attendanceRow?.departure_time ? formatTimeHHMM(attendanceRow.departure_time) : null;
    const hasAttendance = !!(arrival || departure);

    const conges = requestsForDay.filter(r => normalizeTypeDemande(r.type_demande) === 'conges');
    const autorisations = requestsForDay.filter(r => normalizeTypeDemande(r.type_demande) === 'autorisation');
    const missions = requestsForDay.filter(r => normalizeTypeDemande(r.type_demande) === 'mission');

    const conge = conges[0] || null;

    if (conge && !hasAttendance) {
        if (conge.demi_journee) {
            return {
                workedMinutes: 240,
                displayText: '4h00 (congé ½J)',
                isLate: false,
                lateMinutes: 0,
                lateJustified: false,
                status: 'conge_demi',
                arrival: null,
                departure: null,
            };
        }
        return {
            workedMinutes: 0,
            displayText: 'Congé',
            isLate: false,
            lateMinutes: 0,
            lateJustified: false,
            status: 'conge',
            arrival: null,
            departure: null,
        };
    }

    const hasMission = missions.length > 0;
    if (hasMission && !hasAttendance) {
        const totalMissionMins = missions.reduce((s, r) => s + getMissionDayMinutes(r, currentDate), 0);
        return {
            workedMinutes: totalMissionMins,
            displayText: totalMissionMins ? `${formatMinutesToHours(totalMissionMins)} (mission)` : 'Mission',
            isLate: false,
            lateMinutes: 0,
            lateJustified: false,
            status: 'mission',
            arrival: null,
            departure: null,
        };
    }

    const workedRaw = computeWorkedMinutes(arrival, departure, 60);
    const totalAuthMins = autorisations.reduce((s, r) => s + getAuthorizationMinutes(r), 0);

    const lateJustified = isLateJustified(arrival, requestsForDay);
    const late = arrival ? isLate(arrival) && !lateJustified : false;
    const lateMinutes = late ? getLateMinutes(arrival) : 0;

    if (workedRaw !== null) {
        let finalMinutes = workedRaw;
        let detail = `${arrival} → ${departure}`;
        const notes = [];

        if (totalAuthMins > 0) {
            finalMinutes = Math.max(0, finalMinutes - totalAuthMins);
            notes.push(`-${formatMinutesToHours(totalAuthMins)} autorisation`);
        }

        if (notes.length) detail += ` (${notes.join(', ')})`;

        return {
            workedMinutes: finalMinutes,
            displayText: `${formatMinutesToHours(finalMinutes)} (${detail})`,
            isLate: late,
            lateMinutes,
            lateJustified,
            status: late ? 'late' : 'present',
            arrival,
            departure,
        };
    }

    if (arrival || departure) {
        return {
            workedMinutes: 0,
            displayText: `${arrival || '?'} → ${departure || '?'} (incomplet)`,
            isLate: false,
            lateMinutes: 0,
            lateJustified: false,
            status: 'incomplete',
            arrival,
            departure,
        };
    }

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
// Same response shape as before, but only active HR employees are included.
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
// Same response shape as before, but employee list comes from active HR employees.
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
// Same return structure as before.
// Employee source changed: active HR employees -> attendance match by matricule.
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

        // 1. Fetch active employees from HR, then match attendance employees by matricule.
        const employees = await fetchActiveReportEmployees();
        const activeUids = getActiveUids(employees);

        // 2. Fetch attendance data only for active matched employees.
        const attendanceResult = activeUids.length
            ? await global.attendancePool.query(`
                SELECT uid, full_name, work_date, arrival_time, departure_time, status
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

        // 3. Fetch HR approved requests.
        const approvedRequests = await fetchApprovedRequests(start, end);
        const approvedRequestMap = buildApprovedRequestMap(approvedRequests, start, end);

        // 4. Build per-employee report, preserving the same returned fields.
        let totalWorkedMinutes = 0;
        let totalLateCount = 0;
        let totalLateMinutes = 0;

        const employeeReports = employees.map(emp => {
            let empTotalMinutes = 0;
            let empLateCount = 0;
            let empLateMinutes = 0;

            const days = weekDays.map(date => {
                const attRow = emp.uid !== null && emp.uid !== undefined
                    ? attendanceMap.get(`${emp.uid}__${date}`)
                    : null;

                const requestsForDay = approvedRequestMap.get(`${emp.hrId}__${date}`) || [];
                const result = computeDayResult(attRow, requestsForDay, date);

                empTotalMinutes += result.workedMinutes;
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

            return {
                uid: emp.uid,
                name: emp.name,
                cardNo: emp.cardNo,
                matricule: emp.matricule,
                totalMinutes: empTotalMinutes,
                totalHours: formatMinutesToHours(empTotalMinutes),
                lateCount: empLateCount,
                lateMinutes: empLateMinutes,
                days,
            };
        });

        res.json({
            success: true,
            start,
            end,
            weekDays,
            employees: employeeReports,
            summary: {
                totalEmployees: employees.length,
                totalWorkedMinutes,
                totalWorkedHours: formatMinutesToHours(totalWorkedMinutes),
                totalLateCount,
                totalLateMinutes,
                employeesWithData: employeeReports.filter(e => e.totalMinutes > 0).length,
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
// Same return structure as before, but only active HR employees are checked.
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

        // 1. Fetch only active employees with arrival after 08:30.
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

        // 2. HR corrections.
        const approvedRequests = await fetchApprovedRequests(start, end);
        const approvedRequestMap = buildApprovedRequestMap(approvedRequests, start, end);

        // 3. Filter out justified lates.
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
