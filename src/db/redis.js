// Fixed Redis Client with Upstash TLS support
const { createClient } = require('redis');

// Use REDIS_URL directly (includes TLS via rediss://)
const redisUrl = process.env.REDIS_URL;

let redisClient = null;

if (redisUrl) {
  redisClient = createClient({
    url: redisUrl,
  });

  redisClient.on('error', (err) => {
    console.error('[Redis] Error:', err.message);
  });

  redisClient.on('connect', () => {
    console.log('[Redis] Connected');
  });

  redisClient.on('ready', () => {
    console.log('[Redis] Ready');
  });
} else {
  console.warn('[Redis] REDIS_URL not configured - Redis features disabled');
}

// Helper: Cache driver location for real-time matching
const cacheDriverLocation = async (driverId, lat, lon) => {
  if (!redisClient || !redisClient.isOpen) return;
  
  const key = `driver:location:${driverId}`;
  await redisClient.geoAdd('driver:locations', {
    longitude: lon,
    latitude: lat,
    member: driverId,
  });
  await redisClient.set(key, JSON.stringify({ lat, lon, updatedAt: Date.now() }), {
    EX: 300, // Expire after 5 minutes of inactivity
  });
};

// Helper: Find nearby drivers
const findNearbyDrivers = async (lat, lon, radiusMiles = 25) => {
  if (!redisClient || !redisClient.isOpen) return [];
  
  const results = await redisClient.geoSearch('driver:locations', {
    longitude: lon,
    latitude: lat,
  }, {
    radius: radiusMiles,
    unit: 'mi',
  }, {
    WITHDIST: true,
    WITHCOORD: true,
    SORT: 'ASC',
    COUNT: 50,
  });
  return results;
};

const connectRedis = async () => {
  if (!redisClient) {
    console.log('[Redis] Skipping - not configured');
    return;
  }
  
  if (!redisClient.isOpen) {
    await redisClient.connect();
  }
};

module.exports = {
  redisClient,
  connectRedis,
  cacheDriverLocation,
  findNearbyDrivers,
};
