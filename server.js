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
