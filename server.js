require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

// Import routes
const attendanceRoutes = require('./routes/attendance');
const { setZktecoService } = require('./routes/attendance');

// CORS configuration
const corsOptions = {
  origin: function (origin, callback) {
    const allowedOrigins = [
      'http://localhost:8080',
      'http://localhost:3000',
      'http://localhost:5500',
      'http://127.0.0.1:8080',
      'http://127.0.0.1:3000',
      'http://localhost:8081',
      'https://pointeuse-sts.azurewebsites.net',
      'http://localhost:4200',
      'http://localhost:5173',
      'http://localhost:3001'
    ];
    if (process.env.NODE_ENV === 'development') {
      callback(null, true);
    } else if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH', 'HEAD'],
  allowedHeaders: [
    'Origin', 'X-Requested-With', 'Content-Type', 'Accept',
    'Authorization', 'X-Access-Token', 'X-Key', 'X-Forwarded-For',
    'X-Forwarded-Proto', 'Cache-Control', 'Pragma', 'If-Modified-Since'
  ],
  exposedHeaders: [
    'Content-Range', 'X-Content-Range', 'X-Total-Count',
    'Link', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'
  ],
  credentials: true,
  preflightContinue: false,
  optionsSuccessStatus: 204,
  maxAge: 86400
};

// Security middlewares
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
      fontSrc: ["'self'", "https://cdnjs.cloudflare.com", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "http://localhost:3000", "ws://localhost:*"]
    }
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

app.use(compression());
app.use(morgan('dev'));
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

app.use((req, res, next) => {
  const origin = req.headers.origin;
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Access-Token');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Expose-Headers', 'Content-Range, X-Content-Range, X-Total-Count');
  res.header('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Routes
app.use('/api', attendanceRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'ZKTeco Attendance API',
    version: '2.1.0',
    environment: process.env.NODE_ENV || 'development',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    device: {
      ip: process.env.ZKTECO_IP || '41.224.4.231',
      port: process.env.ZKTECO_PORT || 4370
    }
  });
});

app.get('/api/info', (req, res) => {
  res.json({
    service: 'ZKTeco Attendance System API',
    version: '2.1.0',
    device: {
      ip: process.env.ZKTECO_IP || '41.224.4.231',
      port: process.env.ZKTECO_PORT || 4370,
      note: 'Requires port forwarding: router port 4370 → 10.10.205.10:4370'
    },
    endpoints: {
      attendance: '/api/attendance',
      users: '/api/users',
      logs: '/api/logs',
      summary: '/api/summary',
      refresh: '/api/refresh',
      byDate: '/api/by-date/:date',
      byEmployee: '/api/by-employee/:uid',
    }
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Route not found',
    path: req.originalUrl,
    method: req.method
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Global error handler:', err);
  if (err.name === 'CorsError') {
    return res.status(403).json({ error: 'CORS Error', message: 'Origin not allowed' });
  }
  res.status(err.status || 500).json({
    error: err.name || 'Internal Server Error',
    message: err.message || 'Something went wrong',
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
});

// ── ZKTeco Service initialization ─────────────────────────────
// Uses public IP — requires port forwarding on office router:
//   port 4370 → 10.10.205.10:4370
// ──────────────────────────────────────────────────────────────
let zktecoService;
try {
  const ZktecoService = require('./zkteco-service');
  const zktecoIp   = process.env.ZKTECO_IP   || '41.224.4.231';
  const zktecoPort = parseInt(process.env.ZKTECO_PORT) || 4370;

  zktecoService = new ZktecoService(zktecoIp, zktecoPort, 5200, 5000);

  // ✅ Share the single instance with routes (no duplicate connections)
  setZktecoService(zktecoService);

  // Auto-fetch every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    console.log('\n=== Auto-fetch from ZKTeco device ===');
    try {
      await zktecoService.fetchAllData();
      console.log('=== Auto-fetch completed successfully ===\n');
    } catch (error) {
      console.error('=== Auto-fetch failed:', error.message, '===\n');
    }
  });

  // Initial connection
  (async () => {
    console.log('=== Initializing ZKTeco service ===');
    console.log(`=== Device: ${zktecoIp}:${zktecoPort} ===`);
    try {
      await zktecoService.initialize();
      console.log('=== ZKTeco service initialized ===');

      setTimeout(async () => {
        try {
          console.log('=== Fetching initial data... ===');
          const result = await zktecoService.fetchAllData();
          console.log('=== Initial data fetched ===');
          console.log('Users:', result.usersCount);
          console.log('Logs:', result.logsCount);
          console.log('Processed:', result.processedCount);
          console.log('Real data:', result.isRealData ? 'YES ✅' : 'NO ❌');
        } catch (error) {
          console.error('=== Initial fetch failed ===');
          console.error('Message:', error.message);
          console.error('👉 Check port forwarding: router port 4370 → 10.10.205.10:4370');
        }
      }, 3000);

    } catch (error) {
      console.error('=== ZKTeco initialization failed ===');
      console.error('Message:', error.message);
      console.error('👉 Check port forwarding: router port 4370 → 10.10.205.10:4370');
    }
  })();

} catch (error) {
  console.error('=== Failed to load ZKTeco service ===');
  console.error('Message:', error.message);
}

// Unhandled errors
process.on('unhandledRejection', (reason) => {
  console.error('=== Unhandled Rejection ===', reason);
});
process.on('uncaughtException', (error) => {
  console.error('=== Uncaught Exception ===', error);
  process.exit(1);
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║        BACKEND API ZKTECO ATTENDANCE SYSTEM          ║
║                    v2.1.0                            ║
╚══════════════════════════════════════════════════════╝

  📍 Server: http://localhost:${PORT}
  🔧 Environment: ${process.env.NODE_ENV || 'development'}
  🕐 Started: ${new Date().toISOString()}
  📡 ZKTeco device: ${process.env.ZKTECO_IP || '41.224.4.231'}:${process.env.ZKTECO_PORT || 4370}

  ⚠️  REQUIRES: Port forwarding on office router
      Router port 4370 → 10.10.205.10:4370

  === Endpoints ===
  🩺 Health:       http://localhost:${PORT}/health
  👥 Users:        http://localhost:${PORT}/api/users
  📝 Logs:         http://localhost:${PORT}/api/logs
  📈 Summary:      http://localhost:${PORT}/api/summary
  🔄 Refresh:      http://localhost:${PORT}/api/refresh
  📅 By Date:      http://localhost:${PORT}/api/by-date/:date
  👤 By Employee:  http://localhost:${PORT}/api/by-employee/:uid
  `);
});

// Graceful shutdown
const shutdown = (signal) => {
  console.log(`\n📴 ${signal} received. Shutting down...`);
  if (zktecoService) {
    zktecoService.disconnect().catch(err => {
      console.error('❌ Disconnect error:', err.message);
    });
  }
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

module.exports = { app, server, zktecoService };
