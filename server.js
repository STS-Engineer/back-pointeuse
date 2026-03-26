require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const { Pool } = require('pg');

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

// ── Health check ───────────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        service: 'ZKTeco Attendance API',
        version: '4.0.0',
        uptime: process.uptime(),
        sync: zktecoService ? zktecoService.getStatus() : null,
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

// ══════════════════════════════════════════════════════════════
// BACKGROUND SYNC JOB
// - Completely independent from the API
// - Runs every 5 minutes
// - If device offline → retries next cycle
// - Never blocks or affects the API
// ══════════════════════════════════════════════════════════════

let zktecoService = null;
let syncIntervalHandle = null;
let isRetrying = false;

const SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const RETRY_INTERVAL_MS = 1 * 60 * 1000; // retry every 1 min if failing

async function runBackgroundSync() {
    if (!zktecoService) return;
    if (zktecoService.isSyncing) {
        console.log('⏭️ Sync already in progress, skipping this cycle');
        return;
    }

    console.log('\n🔄 [Background Sync] Starting...');
    try {
        const result = await zktecoService.runSync();
        console.log(`✅ [Background Sync] Done — ${result.newLogsInserted} new logs, ${result.dailyRecordsRecomputed} records updated`);
        isRetrying = false;
    } catch (error) {
        console.warn(`⚠️ [Background Sync] Failed: ${error.message}`);
        console.warn('⏳ Will retry next cycle automatically');
        isRetrying = true;
        // No throw — failure is silent, API keeps serving from DB
    }
}

function startBackgroundSync() {
    console.log(`⏰ Background sync scheduled every ${SYNC_INTERVAL_MS / 1000}s`);

    // Run immediately on startup
    setTimeout(async () => {
        console.log('🚀 Running initial sync on startup...');
        await runBackgroundSync();
    }, 5000); // wait 5s for server to fully start

    // Then run every 5 minutes
    syncIntervalHandle = setInterval(runBackgroundSync, SYNC_INTERVAL_MS);
}

// ── Initialize ZKTeco service ──────────────────────────────────
try {
    const ZktecoService = require('./zkteco-service');
    zktecoService = new ZktecoService(
        process.env.ZK_IP || '10.10.205.10',
        parseInt(process.env.ZK_PORT) || 4370,
        5200,
        5000
    );

    // Make service available to routes
    app.locals.zktecoService = zktecoService;

    // Start background sync
    startBackgroundSync();

} catch (error) {
    console.error('❌ Failed to initialize ZKTeco service:', error.message);
}

// ── Server start ───────────────────────────────────────────────
const server = app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════╗
║        BACKEND API ZKTECO ATTENDANCE SYSTEM          ║
║                    v4.0.0                            ║
╚══════════════════════════════════════════════════════╝

  📍 Server:      http://localhost:${PORT}
  🕐 Started:     ${new Date().toISOString()}
  📡 ZKTeco:      ${process.env.ZK_IP || '10.10.205.10'}:${process.env.ZK_PORT || 4370}

  === Endpoints ===
  🩺 Health:          GET  /health
  📋 All Attendance:  GET  /api/attendance
  👥 Employees:       GET  /api/employees
  📊 Summary:         GET  /api/summary
  🔄 Manual Sync:     POST /api/sync
  📅 Last Syncs:      GET  /api/sync/history
    `);
});

// ── Graceful shutdown ──────────────────────────────────────────
const shutdown = async (signal) => {
    console.log(`\n📴 ${signal} received. Shutting down...`);
    if (syncIntervalHandle) clearInterval(syncIntervalHandle);
    if (zktecoService) await zktecoService.disconnect().catch(() => {});
    server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));
process.on('uncaughtException', (error) => { console.error('Uncaught Exception:', error); process.exit(1); });

module.exports = { app, server };
