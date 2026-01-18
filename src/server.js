// Server Entry Point
const http = require('http');

const app = require('./app');
const config = require('./config');
const { pool } = require('./db/pool');
const { connectRedis } = require('./db/redis');
const { initializeSocket } = require('./realtime/socket');
const { runMigrationsV2 } = require('./db/migrations_v2');

// Routes registered in app.js, just add tracking if not there
const trackingRoutes = require('./routes/tracking');
app.use('/api/tracking', trackingRoutes);

async function startServer() {
  try {
    // Test database connection
    console.log('[Server] Testing database connection...');
    await pool.query('SELECT 1');
    console.log('[Server] Database connected');

    // Run database migrations
    console.log('[Server] Running database migrations...');
    await runMigrationsV2();
    console.log('[Server] Migrations complete');

    // Connect to Redis
    console.log('[Server] Connecting to Redis...');
    await connectRedis();
    console.log('[Server] Redis connected');
    
    // Firebase initialized lazily in notificationService.js when needed
    
    // Create HTTP server
    const server = http.createServer(app);
    
    // Initialize WebSocket
    initializeSocket(server);
    console.log('[Server] WebSocket initialized');
    
    // Start listening
    server.listen(config.port, () => {
      console.log('\n========================================');
      console.log('  Hotshot API Server');
      console.log('  Port: ' + config.port);
      console.log('  Environment: ' + config.nodeEnv);
      console.log('========================================\n');
    });
    
    // Graceful shutdown
    const shutdown = async (signal) => {
      console.log('\n[Server] ' + signal + ' received, shutting down...');
      
      server.close(async () => {
        console.log('[Server] HTTP server closed');
        await pool.end();
        console.log('[Server] Database pool closed');
        process.exit(0);
      });
      
      setTimeout(() => {
        console.error('[Server] Forced shutdown');
        process.exit(1);
      }, 10000);
    };
    
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    
  } catch (error) {
    console.error('[Server] Failed to start:', error);
    process.exit(1);
  }
}

startServer();
