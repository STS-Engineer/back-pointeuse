require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const cron = require('node-cron');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Database Pools ─────────────────────────────────────────────
// Attendance DB — stores raw logs, daily records, employees mirror
const pool = new Pool({
  connectionString: 'postgresql://administrationSTS:St$@0987@avo-adb-002.postgres.database.azure.com:5432/attendance?sslmode=require',
  ssl: { rejectUnauthorized: false },
});

// HR DB — source of truth for active employees (statut = 'actif')
const hrPool = new Pool({
  connectionString: 'postgresql://administrationSTS:St$@0987@avo-adb-002.postgres.database.azure.com:5432/rh_application?sslmode=require',
  ssl: { rejectUnauthorized: false },
});

// Make pools available to zkteco-service via global so no db.js needed
global.attendancePool = pool;
global.hrPool = hrPool;

// Import routes
const attendanceRoutes = require('./routes/attendance');
const { setZktecoService } = require('./routes/attendance');

// ============================================================
// CRITICAL FIX: CORS MUST BE ABSOLUTE FIRST
// ============================================================

// 1. RAW CORS HANDLER - MUST BE VERY FIRST MIDDLEWARE
app.use((req, res, next) => {
  const origin = req.headers.origin;
  
  // Define allowed origins
  const allowedOrigins = [
    'http://localhost:8080',
    'http://localhost:3000',
    'http://localhost:5500',
    'http://localhost:5173',
    'http://localhost:4200',
    'http://localhost:3001',
    'http://localhost:8081',
    'http://127.0.0.1:8080',
    'http://127.0.0.1:3000',
    'https://pointeuse-sts.azurewebsites.net',
    'https://avo-hr-managment.azurewebsites.net',
    'https://pointeuse-back.azurewebsites.net'
  ];
  
  // Check if origin is allowed
  if (origin && allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  } else if (!origin) {
    // Allow requests with no origin (like mobile apps, curl)
    res.header('Access-Control-Allow-Origin', '*');
  } else {
    // Default to frontend URL
    res.header('Access-Control-Allow-Origin', 'https://pointeuse-sts.azurewebsites.net');
  }
  
  // Set all CORS headers
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH, HEAD');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Access-Token, X-Key, X-Forwarded-For, X-Forwarded-Proto, Cache-Control, Pragma, If-Modified-Since');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Expose-Headers', 'Content-Range, X-Content-Range, X-Total-Count, Link, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset');
  res.header('Access-Control-Max-Age', '86400');
  
  // Handle preflight requests immediately
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  
  next();
});

// 2. CORS package configuration (backup)
const corsOptions = {
  origin: function (origin, callback) {
    const allowedOrigins = [
      'http://localhost:8080',
      'http://localhost:3000',
      'http://localhost:5500',
      'http://localhost:5173',
      'http://localhost:4200',
      'http://localhost:3001',
      'http://localhost:8081',
      'http://127.0.0.1:8080',
      'http://127.0.0.1:3000',
      'https://pointeuse-sts.azurewebsites.net',
      'https://avo-hr-managment.azurewebsites.net',
      'https://pointeuse-back.azurewebsites.net'
    ];
    
    // Allow requests with no origin
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.indexOf(origin) !== -1 || process.env.NODE_ENV === 'development') {
      callback(null, true);
    } else {
      console.log('❌ CORS blocked origin:', origin);
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

app.use(cors(corsOptions));

// 3. Security middlewares (configured to allow CORS)
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
      fontSrc: ["'self'", "https://cdnjs.cloudflare.com", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: [
        "'self'", 
        "http://localhost:3000", 
        "ws://localhost:*",
        "https://pointeuse-sts.azurewebsites.net",
        "https://pointeuse-back.azurewebsites.net",
        "https://avo-hr-managment.azurewebsites.net"
      ]
    }
  }
}));

// 4. Other middleware
app.use(compression());
app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ============================================================
// BACKWARD COMPATIBILITY MIDDLEWARE
// ============================================================
app.use((req, res, next) => {
  const originalJson = res.json;
  
  res.json = function(data) {
    // Transform arrays
    if (Array.isArray(data)) {
      data = data.map(item => {
        if (item && item.uid !== undefined) {
          return {
            userid: item.userid || item.userId || item.uid?.toString(),
            ...item,
            role: item.role ?? 0,
            password: item.password ?? '',
            deviceData: item.deviceData || null,
            timestamp: item.timestamp ? ensureDate(item.timestamp) : item.timestamp,
            entries: item.entries ? item.entries.map(e => ({
              ...e,
              timestamp: e.timestamp ? ensureDate(e.timestamp) : e.timestamp
            })) : item.entries
          };
        }
        return item;
      });
    }
    
    // Transform single objects
    if (data && data.uid !== undefined && !Array.isArray(data)) {
      data = {
        userid: data.userid || data.userId || data.uid?.toString(),
        ...data,
        role: data.role ?? 0,
        password: data.password ?? '',
        deviceData: data.deviceData || null,
        timestamp: data.timestamp ? ensureDate(data.timestamp) : data.timestamp,
        entries: data.entries ? data.entries.map(e => ({
          ...e,
          timestamp: e.timestamp ? ensureDate(e.timestamp) : e.timestamp
        })) : data.entries
      };
    }
    
    return originalJson.call(this, data);
  };
  
  next();
});

function ensureDate(date) {
  if (!date) return null;
  if (date instanceof Date) return date;
  if (typeof date === 'string' || typeof date === 'number') {
    const d = new Date(date);
    return isNaN(d.getTime()) ? null : d;
  }
  return date;
}

// Routes
app.use('/api', attendanceRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'ZKTeco Attendance API',
    version: '3.0.0',
    environment: process.env.NODE_ENV || 'development',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    device: {
      ip: process.env.ZK_IP || '10.10.205.10',
      port: process.env.ZK_PORT || 4370
    }
  });
});

app.get('/api/info', (req, res) => {
  res.json({
    service: 'ZKTeco Attendance System API',
    version: '3.0.0',
    device: {
      ip: process.env.ZK_IP || '10.10.205.10',
      port: process.env.ZK_PORT || 4370,
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

app.get('/api/debug/schema', (req, res) => {
  if (!zktecoService) return res.json({ error: 'Service not initialized' });
  
  const sample = zktecoService.getProcessedData()[0];
  const userSample = zktecoService.getUsers()[0];
  
  res.json({
    processedData: {
      hasUserid: 'userid' in (sample || {}),
      hasUserId: 'userId' in (sample || {}),
      timestampType: sample?.timestamp ? typeof sample.timestamp : 'missing',
      fields: Object.keys(sample || {}),
      sample: sample
    },
    users: {
      hasUserid: 'userid' in (userSample || {}),
      hasUserId: 'userId' in (userSample || {}),
      fields: Object.keys(userSample || {}),
      sample: userSample
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
  
  // Ensure CORS headers are set even for errors
  const origin = req.headers.origin;
  if (origin) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Credentials', 'true');
  }
  
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
let zktecoService;
try {
  const ZktecoService = require('./zkteco-service');
  const zktecoIp   = process.env.ZK_IP   || '10.10.205.10';
  const zktecoPort = parseInt(process.env.ZK_PORT) || 4370;

  zktecoService = new ZktecoService(zktecoIp, zktecoPort, 5200, 5000);
  setZktecoService(zktecoService);

  // Auto-sync from device every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    console.log('\n=== Auto-sync from ZKTeco device ===');
    try {
      await zktecoService.fetchAllData();
      console.log('=== Auto-sync completed successfully ===\n');
    } catch (error) {
      console.error('=== Auto-sync failed:', error.message, '===\n');
    }
  });

  // Startup sequence
  (async () => {
    console.log('=== Initializing ZKTeco service ===');
    console.log(`=== Device: ${zktecoIp}:${zktecoPort} ===`);

    // Step 1: Load cached data from DB so API is immediately available
    try {
      console.log('=== Loading cached data from DB... ===');
      await zktecoService.loadUsersFromDB();
      await zktecoService.loadProcessedDataFromDB();
      console.log(`=== Cache loaded: ${zktecoService.users.length} users, ${zktecoService.processedData.length} records ===`);
    } catch (err) {
      console.warn('⚠️ Could not load DB cache:', err.message);
    }

    // Step 2: Sync fresh data from device in background
    setTimeout(async () => {
      try {
        console.log('=== Fetching fresh data from device... ===');
        const result = await zktecoService.fetchAllData();
        console.log('=== Initial sync completed ===');
        console.log('Users:', result.usersCount);
        console.log('Logs:', result.logsCount);
        console.log('Processed:', result.processedCount);
        console.log('Real data:', result.isRealData ? 'YES ✅' : 'NO ❌');
      } catch (error) {
        console.error('=== Initial device sync failed (serving DB cache) ===');
        console.error('Message:', error.message);
        console.error('👉 Check port forwarding: router port 4370 → 10.10.205.10:4370');
      }
    }, 3000);

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
║                    v3.0.0                            ║
╚══════════════════════════════════════════════════════╝

  📍 Server:      http://localhost:${PORT}
  🔧 Environment: ${process.env.NODE_ENV || 'development'}
  🕐 Started:     ${new Date().toISOString()}
  📡 ZKTeco:      ${process.env.ZK_IP || '10.10.205.10'}:${process.env.ZK_PORT || 4370}

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
  🔍 Debug Schema: http://localhost:${PORT}/api/debug/schema
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
