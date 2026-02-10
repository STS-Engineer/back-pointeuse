require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

// Import des routes
const attendanceRoutes = require('./routes/attendance');

// Configuration CORS étendue
const corsOptions = {
  origin: function (origin, callback) {
    // Liste des origines autorisées
    const allowedOrigins = [
      'http://localhost:8080',
      'http://localhost:3000',
      'http://localhost:5500',
      'http://127.0.0.1:8080',
      'http://127.0.0.1:3000',
      'http://localhost:8081',
      'https://votre-frontend.azurewebsites.net',
      'http://localhost:4200',
      'http://localhost:5173',
      'http://localhost:3001'
    ];
    
    // En développement, autoriser toutes les origines
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
    'Origin',
    'X-Requested-With',
    'Content-Type',
    'Accept',
    'Authorization',
    'X-Access-Token',
    'X-Key',
    'X-Forwarded-For',
    'X-Forwarded-Proto',
    'Cache-Control',
    'Pragma',
    'If-Modified-Since'
  ],
  exposedHeaders: [
    'Content-Range',
    'X-Content-Range',
    'X-Total-Count',
    'Link',
    'X-RateLimit-Limit',
    'X-RateLimit-Remaining',
    'X-RateLimit-Reset'
  ],
  credentials: true,
  preflightContinue: false,
  optionsSuccessStatus: 204,
  maxAge: 86400 // 24 heures
};

// Middlewares de sécurité
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

// Middleware CORS
app.use(cors(corsOptions));

// Gérer manuellement les pré-vérifications OPTIONS
app.options('*', cors(corsOptions));

// Middleware pour ajouter des headers CORS à toutes les réponses
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowedOrigins = corsOptions.origin;
  
  if (typeof allowedOrigins === 'function') {
    allowedOrigins(origin, (err, allowed) => {
      if (!err && allowed) {
        res.header('Access-Control-Allow-Origin', origin);
      }
    });
  } else if (Array.isArray(allowedOrigins) && allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  } else if (allowedOrigins === true) {
    res.header('Access-Control-Allow-Origin', origin || '*');
  }
  
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Access-Token');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Expose-Headers', 'Content-Range, X-Content-Range, X-Total-Count');
  res.header('Access-Control-Max-Age', '86400');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  next();
});

// Body parsers
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Routes
app.use('/api', attendanceRoutes);

// Routes de santé et d'information
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'ZKTeco Attendance API',
    version: '2.0.0',
    environment: process.env.NODE_ENV || 'development',
    uptime: process.uptime(),
    memory: process.memoryUsage()
  });
});

app.get('/api/info', (req, res) => {
  res.json({
    service: 'ZKTeco Attendance System API',
    version: '2.0.0',
    endpoints: {
      attendance: '/api/attendance',
      users: '/api/users',
      logs: '/api/logs',
      summary: '/api/summary',
      refresh: '/api/refresh',
      byDate: '/api/by-date/:date',
      byEmployee: '/api/by-employee/:uid',
      debug: '/api/debug/*'
    },
    cors: {
      enabled: true,
      allowedOrigins: corsOptions.origin,
      credentials: true
    }
  });
});

// Route 404
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Route not found',
    path: req.originalUrl,
    method: req.method,
    availableEndpoints: [
      '/health',
      '/api/info',
      '/api/attendance',
      '/api/users',
      '/api/logs',
      '/api/summary',
      '/api/refresh',
      '/api/by-date/:date',
      '/api/by-employee/:uid',
      '/api/debug/*'
    ]
  });
});

// Gestionnaire d'erreurs global
app.use((err, req, res, next) => {
  console.error('Global error handler:', err);
  
  if (err.name === 'CorsError') {
    return res.status(403).json({
      error: 'CORS Error',
      message: 'Origin not allowed',
      requestedOrigin: req.headers.origin
    });
  }
  
  res.status(err.status || 500).json({
    error: err.name || 'Internal Server Error',
    message: err.message || 'Something went wrong',
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
});

// Initialisation du service ZKTeco
let zktecoService;
try {
  const ZktecoService = require('./zkteco-service');
  zktecoService = new ZktecoService('10.10.205.10', 4370, 5200, 5000);
  
  // Planifier la récupération automatique toutes les 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    console.log('\n=== Récupération automatique des données de la pointeuse... ===');
    try {
      await zktecoService.fetchAllData();
      console.log('=== Récupération automatique terminée avec succès ===\n');
    } catch (error) {
      console.error('=== Erreur lors de la récupération automatique:', error.message, '===\n');
    }
  });
  
  // Initialiser la connexion au démarrage
  (async () => {
    console.log('=== Initialisation du service ZKTeco ===');
    try {
      await zktecoService.initialize();
      console.log('=== Service ZKTeco initialisé avec succès ===');
      
      // Attendre avant la première récupération
      setTimeout(async () => {
        try {
          console.log('=== Récupération des données initiales... ===');
          const result = await zktecoService.fetchAllData();
          console.log('=== Données initiales récupérées avec succès ===');
          console.log('Utilisateurs:', result.usersCount);
          console.log('Logs:', result.logsCount);
          console.log('Données traitées:', result.processedCount);
          console.log('Données réelles:', result.isRealData ? 'OUI' : 'NON (fictives)');
        } catch (error) {
          console.error('=== Erreur lors de la récupération des données initiales ===');
          console.error('Message:', error.message);
        }
      }, 3000);
    } catch (error) {
      console.error('=== Erreur lors de l\'initialisation ===');
      console.error('Message:', error.message);
    }
  })();
  
} catch (error) {
  console.error('=== Erreur lors du chargement du service ZKTeco ===');
  console.error('Message:', error.message);
  console.error('Stack:', error.stack);
}

// Gestion des erreurs non capturées
process.on('unhandledRejection', (reason, promise) => {
  console.error('=== Unhandled Rejection ===');
  console.error('Reason:', reason);
  console.error('Promise:', promise);
});

process.on('uncaughtException', (error) => {
  console.error('=== Uncaught Exception ===');
  console.error('Error:', error);
  console.error('Stack:', error.stack);
  process.exit(1);
});

// Démarrer le serveur
const server = app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║        BACKEND API ZKTECO ATTENDANCE SYSTEM          ║
╚══════════════════════════════════════════════════════╝
  
  📍 Server running on: http://localhost:${PORT}
  📡 API Base URL: http://localhost:${PORT}/api
  🩺 Health check: http://localhost:${PORT}/health
  🔧 Environment: ${process.env.NODE_ENV || 'development'}
  🕐 Started at: ${new Date().toISOString()}
  
  === Endpoints disponibles: ===
  📊 Health: http://localhost:${PORT}/health
  📋 Info: http://localhost:${PORT}/api/info
  👥 Users: http://localhost:${PORT}/api/users
  📝 Logs: http://localhost:${PORT}/api/logs
  📈 Summary: http://localhost:${PORT}/api/summary
  🔄 Refresh: http://localhost:${PORT}/api/refresh
  📅 By Date: http://localhost:${PORT}/api/by-date/:date
  👤 By Employee: http://localhost:${PORT}/api/by-employee/:uid
  🐛 Debug: http://localhost:${PORT}/api/debug/*
  🧪 CORS Test: http://localhost:${PORT}/api/cors-test
  
  === CORS Configuration ===
  ✅ CORS Enabled
  ✅ Credentials Allowed
  ✅ Multiple Origins Supported
  ✅ Preflight Handling
  
  ======================================
  `);
});

// Gestion de l'arrêt propre
const shutdown = (signal) => {
  console.log(`\n📴 Received ${signal}. Shutting down gracefully...`);
  
  if (zktecoService) {
    zktecoService.disconnect().then(() => {
      console.log('✅ ZKTeco service disconnected');
    }).catch(err => {
      console.error('❌ Error disconnecting ZKTeco:', err.message);
    });
  }
  
  server.close(() => {
    console.log('✅ HTTP server closed');
    process.exit(0);
  });
  
  // Force shutdown after 10 seconds
  setTimeout(() => {
    console.error('❌ Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = { app, server, zktecoService };