// backend_api/src/routes/drivers.js
// Driver routes including availability management

const express = require('express');
const router = express.Router();
const { pool } = require('../db/pool');
const { authenticate } = require('../middleware/auth');

// ============================================
// GET /api/drivers/profile
// Get driver's profile
// ============================================

router.get('/profile', authenticate, async (req, res) => {
  try {
    // Query only absolute minimum columns first
    const userResult = await pool.query(`
      SELECT *
      FROM users
      WHERE id = $1
    `, [req.user.id]);

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Driver not found' });
    }

    const user = userResult.rows[0];

    // Calculate total deliveries from loads table
    let totalDeliveries = 0;
    try {
      const statsResult = await pool.query(`
        SELECT COUNT(*) as total_deliveries
        FROM loads
        WHERE driver_id = $1 AND status = 'delivered'
      `, [req.user.id]);
      totalDeliveries = parseInt(statsResult.rows[0].total_deliveries) || 0;
    } catch (e) {
      console.log('[Drivers] Could not get delivery stats:', e.message);
    }

    // Build driver response with safe defaults
    const driver = {
      id: user.id,
      email: user.email,
      first_name: user.first_name,
      last_name: user.last_name,
      phone: user.phone,
      role: user.role,
      vehicle_type: user.vehicle_type || null,
      license_plate: user.license_plate || null,
      driver_lat: user.driver_lat || null,
      driver_lng: user.driver_lng || null,
      location_updated_at: user.location_updated_at || null,
      is_available: user.is_available || false,
      company_name: user.company_name || null,
      total_deliveries: totalDeliveries,
      rating: user.rating || 5.0,
      rating_count: user.rating_count || 0,
      is_verified: user.is_verified || false,
      profile_image_url: user.profile_image_url || null,
      created_at: user.created_at,
    };

    res.json({ driver });
  } catch (error) {
    console.error('[Drivers] Profile error:', error);
    res.status(500).json({ error: 'Failed to get profile', details: error.message });
  }
});

// ============================================
// GET /api/drivers/earnings
// Get driver's earnings summary
// ============================================

router.get('/earnings', authenticate, async (req, res) => {
  try {
    const { period = 'today' } = req.query;
    
    let dateFilter = '';
    
    switch (period) {
      case 'today':
        dateFilter = `AND DATE(delivered_at) = CURRENT_DATE`;
        break;
      case 'week':
        dateFilter = `AND delivered_at >= NOW() - INTERVAL '7 days'`;
        break;
      case 'month':
        dateFilter = `AND delivered_at >= NOW() - INTERVAL '30 days'`;
        break;
      case 'all':
      default:
        dateFilter = '';
    }

    const result = await pool.query(`
      SELECT 
        COALESCE(SUM(driver_payout), 0) as total_earnings,
        COUNT(*) as completed_loads,
        COALESCE(SUM(distance_miles), 0) as total_miles
      FROM loads
      WHERE driver_id = $1 
        AND status = 'delivered'
        ${dateFilter}
    `, [req.user.id]);

    const stats = result.rows[0];

    res.json({
      period,
      totalEarnings: parseFloat(stats.total_earnings) || 0,
      completedLoads: parseInt(stats.completed_loads) || 0,
      totalMiles: parseFloat(stats.total_miles) || 0,
    });
  } catch (error) {
    console.error('[Drivers] Earnings error:', error);
    // Return empty stats instead of error
    res.json({
      period: req.query.period || 'today',
      totalEarnings: 0,
      completedLoads: 0,
      totalMiles: 0,
    });
  }
});

// ============================================
// GET /api/drivers/active-job
// Get driver's currently active load
// ============================================

router.get('/active-job', authenticate, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        l.*,
        s.first_name as shipper_first_name,
        s.last_name as shipper_last_name,
        s.phone as shipper_phone,
        s.company_name as shipper_company
      FROM loads l
      JOIN users s ON l.shipper_id = s.id
      WHERE l.driver_id = $1 
        AND l.status IN ('assigned', 'en_route_pickup', 'at_pickup', 'picked_up', 'en_route_delivery', 'at_delivery')
      ORDER BY 
        CASE l.status
          WHEN 'en_route_delivery' THEN 1
          WHEN 'at_delivery' THEN 2
          WHEN 'picked_up' THEN 3
          WHEN 'at_pickup' THEN 4
          WHEN 'en_route_pickup' THEN 5
          WHEN 'assigned' THEN 6
        END
      LIMIT 1
    `, [req.user.id]);

    if (result.rows.length === 0) {
      return res.json({ activeJob: null });
    }

    const load = result.rows[0];
    
    res.json({
      activeJob: {
        id: load.id,
        status: load.status,
        loadType: load.load_type,
        description: load.description,
        pickupAddress: load.pickup_address,
        pickupCity: load.pickup_city,
        pickupState: load.pickup_state,
        pickupLat: load.pickup_lat,
        pickupLng: load.pickup_lng,
        pickupDate: load.pickup_date,
        pickupTimeStart: load.pickup_time_start,
        pickupTimeEnd: load.pickup_time_end,
        deliveryAddress: load.delivery_address,
        deliveryCity: load.delivery_city,
        deliveryState: load.delivery_state,
        deliveryLat: load.delivery_lat,
        deliveryLng: load.delivery_lng,
        deliveryDate: load.delivery_date,
        deliveryTimeStart: load.delivery_time_start,
        deliveryTimeEnd: load.delivery_time_end,
        distanceMiles: load.distance_miles,
        price: load.price,
        driverPayout: load.driver_payout,
        shipper: {
          firstName: load.shipper_first_name,
          lastName: load.shipper_last_name,
          phone: load.shipper_phone,
          company: load.shipper_company,
        },
      },
    });
  } catch (error) {
    console.error('[Drivers] Active job error:', error);
    res.json({ activeJob: null });
  }
});

// ============================================
// POST /api/drivers/location
// Update driver's current GPS coordinates
// ============================================

router.post('/location', authenticate, async (req, res) => {
  try {
    const { lat, lng } = req.body;

    if (!lat || !lng) {
      return res.status(400).json({ error: 'lat and lng required' });
    }

    await pool.query(`
      UPDATE users 
      SET driver_lat = $1, driver_lng = $2, location_updated_at = NOW()
      WHERE id = $3
    `, [lat, lng, req.user.id]);

    // Also update any active availability posts
    try {
      await pool.query(`
        UPDATE driver_availability
        SET current_lat = $1, current_lng = $2, updated_at = NOW()
        WHERE driver_id = $3 AND is_active = true
      `, [lat, lng, req.user.id]);
    } catch (e) {
      // Table might not exist yet, ignore
    }

    res.json({ message: 'Location updated' });
  } catch (error) {
    console.error('[Drivers] Location update error:', error);
    res.status(500).json({ error: 'Failed to update location' });
  }
});

// ============================================
// PUT /api/drivers/availability-status
// Toggle driver online/offline status
// ============================================

router.put('/availability-status', authenticate, async (req, res) => {
  try {
    const { isAvailable } = req.body;

    await pool.query(
      'UPDATE users SET is_available = $1 WHERE id = $2',
      [isAvailable, req.user.id]
    );

    res.json({ message: 'Availability updated', isAvailable });
  } catch (error) {
    console.error('[Drivers] Availability status error:', error);
    res.status(500).json({ error: 'Failed to update availability' });
  }
});

// ============================================
// AVAILABILITY POSTS (Route Intent)
// ============================================

// GET /api/drivers/availability - Get driver's availability posts
router.get('/availability', authenticate, async (req, res) => {
  try {
    const { active } = req.query;
    
    // Check if table exists first
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'driver_availability'
      )
    `);
    
    if (!tableCheck.rows[0].exists) {
      return res.json({ availability: [] });
    }
    
    let query = `
      SELECT * FROM driver_availability
      WHERE driver_id = $1
    `;
    const params = [req.user.id];
    
    if (active === 'true') {
      query += ' AND is_active = true';
    }
    
    query += ' ORDER BY created_at DESC';
    
    const result = await pool.query(query, params);
    
    res.json({ availability: result.rows });
  } catch (error) {
    console.error('[Drivers] Get availability error:', error);
    res.json({ availability: [] });
  }
});

// POST /api/drivers/availability - Create new availability post
router.post('/availability', authenticate, async (req, res) => {
  try {
    const {
      mode = 'backhaul_now',
      currentLat,
      currentLng,
      startCity,
      startState,
      destinationLat,
      destinationLng,
      destinationCity,
      destinationState,
      availableFrom,
      availableUntil,
      departureWindowStart,
      departureWindowEnd,
      equipmentType,
      maxWeightLbs,
      palletCapacity,
      maxDeadheadMiles = 100,
      maxDetourMiles = 50,
      serviceTypesAccepted = ['standard'],
      minPayout,
      minRatePerMile,
      isRecurring = false,
      recurrenceDays,
    } = req.body;

    // Validate required fields
    if (!destinationLat || !destinationLng || !equipmentType) {
      return res.status(400).json({ 
        error: 'destinationLat, destinationLng, and equipmentType are required' 
      });
    }

    // Get current location from user if not provided
    let lat = currentLat;
    let lng = currentLng;
    
    if (!lat || !lng) {
      const userResult = await pool.query(
        'SELECT driver_lat, driver_lng FROM users WHERE id = $1',
        [req.user.id]
      );
      if (userResult.rows[0]) {
        lat = userResult.rows[0].driver_lat;
        lng = userResult.rows[0].driver_lng;
      }
    }

    if (!lat || !lng) {
      return res.status(400).json({ 
        error: 'Current location required. Please update your location.' 
      });
    }

    // Check if table exists
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'driver_availability'
      )
    `);
    
    if (!tableCheck.rows[0].exists) {
      return res.status(400).json({ 
        error: 'Availability feature not yet enabled. Please run database migrations.' 
      });
    }

    const result = await pool.query(`
      INSERT INTO driver_availability (
        driver_id, mode,
        current_lat, current_lng, start_city, start_state,
        destination_lat, destination_lng, destination_city, destination_state,
        available_from, available_until,
        departure_window_start, departure_window_end,
        equipment_type, max_weight_lbs, pallet_capacity,
        max_deadhead_miles, max_detour_miles,
        service_types_accepted, min_payout, min_rate_per_mile,
        is_recurring, recurrence_days,
        is_active
      ) VALUES (
        $1, $2,
        $3, $4, $5, $6,
        $7, $8, $9, $10,
        $11, $12,
        $13, $14,
        $15, $16, $17,
        $18, $19,
        $20, $21, $22,
        $23, $24,
        true
      ) RETURNING *
    `, [
      req.user.id, mode,
      lat, lng, startCity, startState,
      destinationLat, destinationLng, destinationCity, destinationState,
      availableFrom || new Date(), availableUntil,
      departureWindowStart, departureWindowEnd,
      equipmentType, maxWeightLbs, palletCapacity,
      maxDeadheadMiles, maxDetourMiles,
      serviceTypesAccepted, minPayout, minRatePerMile,
      isRecurring, recurrenceDays,
    ]);

    res.status(201).json({
      message: 'Availability posted',
      availability: result.rows[0],
    });
  } catch (error) {
    console.error('[Drivers] Post availability error:', error);
    res.status(500).json({ error: 'Failed to post availability' });
  }
});

// PUT /api/drivers/availability/:id - Update availability post
router.put('/availability/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    // Verify ownership
    const check = await pool.query(
      'SELECT driver_id FROM driver_availability WHERE id = $1',
      [id]
    );

    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Availability not found' });
    }

    if (check.rows[0].driver_id !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    // Build dynamic update query
    const allowedFields = [
      'current_lat', 'current_lng', 'start_city', 'start_state',
      'destination_lat', 'destination_lng', 'destination_city', 'destination_state',
      'available_from', 'available_until',
      'departure_window_start', 'departure_window_end',
      'equipment_type', 'max_weight_lbs', 'pallet_capacity',
      'max_deadhead_miles', 'max_detour_miles',
      'service_types_accepted', 'min_payout', 'min_rate_per_mile',
      'is_active',
    ];

    const setClauses = [];
    const values = [];
    let paramIndex = 1;

    // Convert camelCase to snake_case and build query
    Object.entries(updates).forEach(([key, value]) => {
      const snakeKey = key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
      if (allowedFields.includes(snakeKey)) {
        setClauses.push(`${snakeKey} = $${paramIndex}`);
        values.push(value);
        paramIndex++;
      }
    });

    if (setClauses.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    setClauses.push('updated_at = NOW()');
    values.push(id);

    const result = await pool.query(`
      UPDATE driver_availability
      SET ${setClauses.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING *
    `, values);

    res.json({
      message: 'Availability updated',
      availability: result.rows[0],
    });
  } catch (error) {
    console.error('[Drivers] Update availability error:', error);
    res.status(500).json({ error: 'Failed to update availability' });
  }
});

// DELETE /api/drivers/availability/:id - Delete availability post
router.delete('/availability/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    // Verify ownership
    const check = await pool.query(
      'SELECT driver_id FROM driver_availability WHERE id = $1',
      [id]
    );

    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Availability not found' });
    }

    if (check.rows[0].driver_id !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    await pool.query('DELETE FROM driver_availability WHERE id = $1', [id]);

    res.json({ message: 'Availability deleted' });
  } catch (error) {
    console.error('[Drivers] Delete availability error:', error);
    res.status(500).json({ error: 'Failed to delete availability' });
  }
});

// ============================================
// GET /api/drivers/offers
// Get offers sent to this driver
// ============================================

router.get('/offers', authenticate, async (req, res) => {
  try {
    const { status = 'pending' } = req.query;

    // Check if table exists
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'load_offers'
      )
    `);
    
    if (!tableCheck.rows[0].exists) {
      return res.json({ offers: [] });
    }

    const result = await pool.query(`
      SELECT 
        o.*,
        l.pickup_city, l.pickup_state, l.delivery_city, l.delivery_state,
        l.pickup_date, l.pickup_time_start, l.pickup_time_end,
        l.delivery_date, l.delivery_time_start, l.delivery_time_end,
        l.distance_miles, l.load_type, l.vehicle_type_required,
        l.description, l.weight_lbs,
        s.first_name as shipper_first_name, s.last_name as shipper_last_name,
        s.company_name as shipper_company, s.phone as shipper_phone
      FROM load_offers o
      JOIN loads l ON o.load_id = l.id
      JOIN users s ON l.shipper_id = s.id
      WHERE o.driver_id = $1
        AND ($2 = 'all' OR o.status = $2)
        AND (o.expires_at > NOW() OR o.status != 'pending')
      ORDER BY 
        CASE WHEN o.status = 'pending' THEN 0 ELSE 1 END,
        o.created_at DESC
    `, [req.user.id, status]);

    res.json({ offers: result.rows });
  } catch (error) {
    console.error('[Drivers] Get offers error:', error);
    res.json({ offers: [] });
  }
});

// ============================================
// GET /api/drivers/stats
// Get driver stats summary
// ============================================

router.get('/stats', authenticate, async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT 
        (SELECT COUNT(*) FROM loads WHERE driver_id = $1 AND status = 'delivered') as completed_loads,
        (SELECT COUNT(*) FROM loads WHERE driver_id = $1 AND status IN ('assigned', 'en_route_pickup', 'picked_up', 'en_route_delivery')) as active_loads,
        (SELECT COALESCE(SUM(driver_payout), 0) FROM loads WHERE driver_id = $1 AND status = 'delivered') as total_earnings
    `, [req.user.id]);

    // Check availability table
    let activeAvailability = 0;
    let pendingOffers = 0;
    
    try {
      const availResult = await pool.query(
        'SELECT COUNT(*) FROM driver_availability WHERE driver_id = $1 AND is_active = true',
        [req.user.id]
      );
      activeAvailability = parseInt(availResult.rows[0].count) || 0;
    } catch (e) {}
    
    try {
      const offerResult = await pool.query(
        "SELECT COUNT(*) FROM load_offers WHERE driver_id = $1 AND status = 'pending' AND expires_at > NOW()",
        [req.user.id]
      );
      pendingOffers = parseInt(offerResult.rows[0].count) || 0;
    } catch (e) {}

    res.json({
      ...stats.rows[0],
      active_availability: activeAvailability,
      pending_offers: pendingOffers,
    });
  } catch (error) {
    console.error('[Drivers] Stats error:', error);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

module.exports = router;
