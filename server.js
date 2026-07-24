require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const { Pool } = require('pg');
const cron = require('node-cron');        // ← ADD
const { runOnce } = require('./ingestion/ingest'); // ← ADD

const app = express();
const PORT = process.env.PORT || 3000;

// ── Database Pools ─────────────────────────────────────────────
const pool = new Pool({
    connectionString: process.env.ATTENDANCE_DB_URL || 'postgresql://administrationSTS:St%24%400987@avo-adb-002.postgres.database.azure.com:5432/attendance?sslmode=require',
    ssl: { rejectUnauthorized: false },
});

const hrPool = new Pool({
    connectionString: process.env.HR_DB_URL || 'postgresql://administrationSTS:St%24%400987@avo-adb-002.postgres.database.azure.com:5432/rh_application?sslmode=require',
    ssl: { rejectUnauthorized: false },
});

global.attendancePool = pool;
global.hrPool = hrPool;

// ── Middlewares ────────────────────────────────────────────────
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH, HEAD');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, Cache-Control, Pragma');
    res.header('Access-Control-Allow-Credentials', 'false');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
});

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], credentials: false }));
app.use(helmet({
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: false,
}));
app.use(compression());
app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── Import routes ──────────────────────────────────────────────
const attendanceRoutes = require('./routes/attendance');
app.use('/api', attendanceRoutes);

const missingPointsRoutes = require('./routes/missingPoints');
app.use(missingPointsRoutes);

const leaveBalanceRoutes = require('./routes/leaveBalance');
app.use(leaveBalanceRoutes);

const remoteAttendanceRoutes = require('./routes/remoteAttendance');
app.use(remoteAttendanceRoutes);

const selfPointageRoutes = require('./routes/selfPointage');
app.use('/api/self-pointage', selfPointageRoutes);

// ── Health check ───────────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        service: 'Attendance API',
        version: '4.0.0',
        uptime: process.uptime(),
    });
});

// ── 404 handler ────────────────────────────────────────────────
app.use('*', (req, res) => {
    res.status(404).json({ error: 'Route not found', path: req.originalUrl });
});

// ── Error handler ──────────────────────────────────────────────
app.use((err, req, res, next) => {
    console.error('Global error:', err);
    res.header('Access-Control-Allow-Origin', '*');
    res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
});

// ── Server start ───────────────────────────────────────────────
const server = app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════╗
║              BACKEND ATTENDANCE API                 ║
║                    v4.0.0                            ║
╚══════════════════════════════════════════════════════╝

  📍 Server:      http://localhost:${PORT}
  🕐 Started:     ${new Date().toISOString()}

  === Endpoints ===
  🩺 Health:          GET  /health
  📋 All Attendance:  GET  /api/attendance
  👥 Employees:       GET  /api/employees
  📊 Summary:         GET  /api/summary
  📅 Last Syncs:      GET  /api/sync/history
    `);

    // ── Ingestion cron job (every hour) ───────────────────────
    cron.schedule('0 * * * *', async () => {
        console.log(`\n⏰ [CRON] Starting ingestion at ${new Date().toISOString()}`);
        try {
            await runOnce();
            console.log('✅ [CRON] Ingestion completed successfully');
        } catch (err) {
            console.error('❌ [CRON] Ingestion failed:', err.message);
            // ← never crashes the server, just logs the error
        }
    });

    console.log('⏰ Ingestion cron job scheduled — runs every hour');

    // ── Missing attendance-point reminder cron (daily, Mon-Fri 10:30 Tunis time) ──
    const { runDailySweep } = require('./services/missingPoints');
    const missingPointsCronExpr = process.env.MISSING_POINTS_CRON || '30 10 * * 1-5';
    cron.schedule(missingPointsCronExpr, async () => {
        console.log(`\n⏰ [CRON] Starting missing-points sweep at ${new Date().toISOString()}`);
        try {
            const result = await runDailySweep();
            console.log(`✅ [CRON] Missing-points sweep completed: ${JSON.stringify(result)}`);
        } catch (err) {
            console.error('❌ [CRON] Missing-points sweep failed:', err.message);
            // ← never crashes the server, just logs the error
        }
    }, { timezone: 'Africa/Tunis' });

    console.log(`⏰ Missing-points sweep cron job scheduled — "${missingPointsCronExpr}" (Africa/Tunis)`);

    // ── Leave-balance accrual cron (daily, after ingestion has settled) ──
    const { recomputeLeaveBalances } = require('./services/leaveBalance');
    const leaveBalanceCronExpr = process.env.LEAVE_BALANCE_CRON || '0 2 * * *';
    cron.schedule(leaveBalanceCronExpr, async () => {
        console.log(`\n⏰ [CRON] Starting leave-balance recompute at ${new Date().toISOString()}`);
        try {
            const result = await recomputeLeaveBalances();
            console.log(`✅ [CRON] Leave-balance recompute completed: ${JSON.stringify(result)}`);
        } catch (err) {
            console.error('❌ [CRON] Leave-balance recompute failed:', err.message);
            // ← never crashes the server, just logs the error
        }
    }, { timezone: 'Africa/Tunis' });

    console.log(`⏰ Leave-balance accrual cron job scheduled — "${leaveBalanceCronExpr}" (Africa/Tunis)`);

    // ── Remote-work attendance emails (daily, Mon-Fri; no-op unless the day ──
    // ── has been marked remote via POST /api/remote-days) ────────────────
    const remoteAttendance = require('./services/remoteAttendance');

    const remoteArrivalCronExpr = process.env.REMOTE_ATTENDANCE_ARRIVAL_CRON || '30 7 * * 1-5';
    cron.schedule(remoteArrivalCronExpr, async () => {
        try {
            const today = remoteAttendance.todayInTz();
            if (!(await remoteAttendance.isRemoteWorkDay(today))) return;
            console.log(`\n⏰ [CRON] Sending remote-attendance arrival emails for ${today}`);
            const result = await remoteAttendance.sendPunchLinksForDate(today, 'arrival', { dryRun: false });
            console.log(`✅ [CRON] Remote-attendance arrival emails sent: ${JSON.stringify(result)}`);
        } catch (err) {
            console.error('❌ [CRON] Remote-attendance arrival sweep failed:', err.message);
            // ← never crashes the server, just logs the error
        }
    }, { timezone: 'Africa/Tunis' });

    const remoteDepartureCronExpr = process.env.REMOTE_ATTENDANCE_DEPARTURE_CRON || '30 16 * * 1-5';
    cron.schedule(remoteDepartureCronExpr, async () => {
        try {
            const today = remoteAttendance.todayInTz();
            if (!(await remoteAttendance.isRemoteWorkDay(today))) return;
            console.log(`\n⏰ [CRON] Sending remote-attendance departure emails for ${today}`);
            const result = await remoteAttendance.sendPunchLinksForDate(today, 'departure', { dryRun: false });
            console.log(`✅ [CRON] Remote-attendance departure emails sent: ${JSON.stringify(result)}`);
        } catch (err) {
            console.error('❌ [CRON] Remote-attendance departure sweep failed:', err.message);
            // ← never crashes the server, just logs the error
        }
    }, { timezone: 'Africa/Tunis' });

    console.log(`⏰ Remote-attendance cron jobs scheduled — arrival "${remoteArrivalCronExpr}", departure "${remoteDepartureCronExpr}" (Africa/Tunis)`);
});

// ── Graceful shutdown ──────────────────────────────────────────
const shutdown = async (signal) => {
    console.log(`\n📴 ${signal} received. Shutting down...`);
    server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    process.exit(1);
});

module.exports = { app, server };
