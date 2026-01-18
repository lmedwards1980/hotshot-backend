const express = require('express');
const router = express.Router();
const { pool } = require('../db/pool');
const { authenticate } = require('../middleware/auth');

// Update driver location (called by driver app)
router.post('/location', authenticate, async (req, res) => {
  try {
    const driverId = req.user.id;
    const { latitude, longitude } = req.body;

    if (!latitude || !longitude) {
      return res.status(400).json({ error: 'Latitude and longitude required' });
    }

    // Update driver's current location
    await pool.query(
      `UPDATE users 
       SET current_lat = $1, 
           current_lng = $2, 
           last_location_update = NOW() 
       WHERE id = $3 AND role = 'driver'`,
      [latitude, longitude, driverId]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Update location error:', error);
    res.status(500).json({ error: 'Failed to update location' });
  }
});

// Get driver location for a specific load (called by shipper app)
router.get('/load/:loadId', authenticate, async (req, res) => {
  try {
    const { loadId } = req.params;
    const userId = req.user.id;

    // Get load with driver info
    const result = await pool.query(
      `SELECT 
        l.*,
        u.id as driver_user_id,
        u.first_name as driver_first_name,
        u.last_name as driver_last_name,
        u.phone as driver_phone,
        u.vehicle_type as driver_vehicle_type,
        u.license_plate as driver_license_plate,
        u.current_lat as driver_lat,
        u.current_lng as driver_lng,
        u.last_location_update as driver_last_update
       FROM loads l
       LEFT JOIN users u ON l.driver_id = u.id
       WHERE l.id = $1 AND l.shipper_id = $2`,
      [loadId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Load not found' });
    }

    const load = result.rows[0];
    
    // Format response
    const response = {
      id: load.id,
      status: load.status,
      pickup_address: load.pickup_address,
      pickup_city: load.pickup_city,
      pickup_state: load.pickup_state,
      pickup_lat: parseFloat(load.pickup_lat),
      pickup_lng: parseFloat(load.pickup_lng),
      delivery_address: load.delivery_address,
      delivery_city: load.delivery_city,
      delivery_state: load.delivery_state,
      delivery_lat: parseFloat(load.delivery_lat),
      delivery_lng: parseFloat(load.delivery_lng),
      distance_miles: load.distance_miles,
      price: parseFloat(load.price),
      driver_id: load.driver_id,
      driver: load.driver_id ? {
        id: load.driver_user_id,
        first_name: load.driver_first_name,
        last_name: load.driver_last_name,
        phone: load.driver_phone,
        vehicle_type: load.driver_vehicle_type,
        license_plate: load.driver_license_plate,
        current_lat: load.driver_lat ? parseFloat(load.driver_lat) : null,
        current_lng: load.driver_lng ? parseFloat(load.driver_lng) : null,
        last_location_update: load.driver_last_update,
      } : null,
    };

    res.json(response);
  } catch (error) {
    console.error('Get tracking info error:', error);
    res.status(500).json({ error: 'Failed to get tracking info' });
  }
});

// Get all active loads with driver locations (for shipper dashboard)
router.get('/active', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;

    let query;
    let params;

    if (userRole === 'shipper') {
      query = `
        SELECT 
          l.id, l.status, l.pickup_city, l.pickup_state, 
          l.delivery_city, l.delivery_state,
          u.first_name as driver_first_name,
          u.current_lat as driver_lat,
          u.current_lng as driver_lng,
          u.last_location_update
        FROM loads l
        LEFT JOIN users u ON l.driver_id = u.id
        WHERE l.shipper_id = $1 
        AND l.status IN ('assigned', 'en_route_pickup', 'picked_up', 'en_route_delivery')
        ORDER BY l.created_at DESC
      `;
      params = [userId];
    } else {
      query = `
        SELECT 
          l.id, l.status, l.pickup_city, l.pickup_state,
          l.pickup_lat, l.pickup_lng,
          l.delivery_city, l.delivery_state,
          l.delivery_lat, l.delivery_lng
        FROM loads l
        WHERE l.driver_id = $1 
        AND l.status IN ('assigned', 'en_route_pickup', 'picked_up', 'en_route_delivery')
        ORDER BY l.created_at DESC
        LIMIT 1
      `;
      params = [userId];
    }

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Get active tracking error:', error);
    res.status(500).json({ error: 'Failed to get active loads' });
  }
});

module.exports = router;
