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
// GET /api/attendance
// Returns ALL attendance history from DB
// Frontend fetches this ONCE and filters locally
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
// Returns all employees from attendance DB
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

        res.json({
            success: true,
            count: rows.length,
            employees: rows,
        });

    } catch (error) {
        console.error('❌ GET /employees error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ══════════════════════════════════════════════════════════════
// GET /api/summary
// Returns summary stats from DB
// ══════════════════════════════════════════════════════════════
router.get('/summary', async (req, res) => {
    try {
        const today = new Date().toISOString().split('T')[0];

        const [totalEmployees, todayStats, totalRecords, lastSync] = await Promise.all([
            // Total employees
            global.attendancePool.query(
                `SELECT COUNT(*) AS count FROM public.employees`
            ),
            // Today's stats
            global.attendancePool.query(`
                SELECT
                    COUNT(*) FILTER (WHERE status != 'Absent') AS present,
                    COUNT(*) FILTER (WHERE status = 'En retard') AS late,
                    COUNT(*) FILTER (WHERE status = 'En cours') AS in_progress,
                    COUNT(*) FILTER (WHERE status = 'Absent') AS absent
                FROM public.attendance_daily
                WHERE work_date = $1
            `, [today]),
            // Total records
            global.attendancePool.query(
                `SELECT COUNT(*) AS count FROM public.attendance_daily`
            ),
            // Last sync
            global.attendancePool.query(`
                SELECT started_at, finished_at, success, message
                FROM public.sync_runs
                ORDER BY started_at DESC
                LIMIT 1
            `),
        ]);

        const sync = lastSync.rows[0] || null;

        res.json({
            success: true,
            summary: {
                totalEmployees: parseInt(totalEmployees.rows[0].count),
                totalRecords: parseInt(totalRecords.rows[0].count),
                today: {
                    date: today,
                    present: parseInt(todayStats.rows[0].present),
                    late: parseInt(todayStats.rows[0].late),
                    inProgress: parseInt(todayStats.rows[0].in_progress),
                    absent: parseInt(todayStats.rows[0].absent),
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
// Returns last 10 sync runs
// ══════════════════════════════════════════════════════════════
router.get('/sync/history', async (req, res) => {
    try {
        const { rows } = await global.attendancePool.query(`
            SELECT id, started_at, finished_at, success, message, details
            FROM public.sync_runs
            ORDER BY started_at DESC
            LIMIT 10
        `);
        res.json({ success: true, history: rows });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ══════════════════════════════════════════════════════════════
// GET /api/health
// Quick health check
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

module.exports = router;
