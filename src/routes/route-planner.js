// Route Planner Routes - Daisy-chain deliveries
const express = require('express');
const { pool } = require('../db/pool');
const { authenticate, requireUserType } = require('../middleware/auth');

const router = express.Router();

// All routes require driver authentication
router.use(authenticate, requireUserType('driver'));

/**
 * GET /route-planner/queue
 * Get driver's planned route (confirmed loads in sequence order)
 */
router.get('/queue', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT l.*,
        COALESCE(l.route_sequence, 999) as sequence
       FROM loads l
       WHERE l.driver_id = $1
         AND l.status IN ('assigned', 'confirmed', 'en_route_pickup', 'picked_up', 'en_route_delivery')
       ORDER BY COALESCE(l.route_sequence, 999) ASC, l.created_at ASC`,
      [req.user.id]
    );

    // Calculate totals
    let totalMiles = 0;
    let totalEarnings = 0;
    
    const loads = result.rows.map((load, index) => {
      totalMiles += parseFloat(load.distance_miles) || parseFloat(load.estimated_miles) || 0;
      totalEarnings += parseFloat(load.driver_payout) || 0;
      
      return {
        id: load.id,
        sequence: index + 1,
        status: load.status,
        scheduledDate: load.scheduled_date,
        pickupCity: load.pickup_city,
        pickupState: load.pickup_state,
        pickupAddress: load.pickup_address,
        pickupLat: parseFloat(load.pickup_lat),
        pickupLng: parseFloat(load.pickup_lng),
        pickupDate: load.pickup_date,
        deliveryCity: load.delivery_city,
        deliveryState: load.delivery_state,
        deliveryAddress: load.delivery_address,
        deliveryLat: parseFloat(load.delivery_lat),
        deliveryLng: parseFloat(load.delivery_lng),
        deliveryDate: load.delivery_date,
        distanceMiles: parseFloat(load.distance_miles) || parseFloat(load.estimated_miles) || 0,
        driverPayout: parseFloat(load.driver_payout) || 0,
        weightLbs: load.weight_lbs,
        vehicleTypeRequired: load.vehicle_type_required,
        description: load.description,
      };
    });

    res.json({
      queue: loads,
      summary: {
        totalLoads: loads.length,
        totalMiles: Math.round(totalMiles),
        totalEarnings: totalEarnings.toFixed(2),
      },
    });
  } catch (error) {
    console.error('[RoutePlanner] Get queue error:', error);
    res.status(500).json({ error: 'Failed to get route queue' });
  }
});

/**
 * POST /route-planner/queue
 * Add a load to the driver's planned route (by load_id in body)
 */
router.post('/queue', async (req, res) => {
  try {
    const { load_id, scheduled_date } = req.body;

    if (!load_id) {
      return res.status(400).json({ error: 'load_id is required' });
    }

    // Check if load is available
    const loadCheck = await pool.query(
      'SELECT * FROM loads WHERE id = $1',
      [load_id]
    );

    if (loadCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Load not found' });
    }

    const load = loadCheck.rows[0];

    if (load.status !== 'posted' && load.status !== 'available') {
      return res.status(409).json({ error: 'Load is no longer available' });
    }

    // Get next sequence number
    const seqResult = await pool.query(
      `SELECT COALESCE(MAX(route_sequence), 0) + 1 as next_seq
       FROM loads
       WHERE driver_id = $1 AND status IN ('assigned', 'confirmed')`,
      [req.user.id]
    );
    const nextSequence = seqResult.rows[0].next_seq;

    // Add to driver's queue
    await pool.query(
      `UPDATE loads
       SET driver_id = $1,
           status = 'confirmed',
           route_sequence = $2,
           scheduled_date = $3,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $4`,
      [req.user.id, nextSequence, scheduled_date || null, load_id]
    );

    res.json({
      success: true,
      message: 'Load added to route',
      sequence: nextSequence,
    });
  } catch (error) {
    console.error('[RoutePlanner] Add to queue error:', error);
    res.status(500).json({ error: 'Failed to add load to route' });
  }
});

/**
 * POST /route-planner/add/:loadId
 * Add a load to the driver's planned route
 */
router.post('/add/:loadId', async (req, res) => {
  try {
    const { loadId } = req.params;
    const { scheduledDate } = req.body;

    // Check if load is available
    const loadCheck = await pool.query(
      `SELECT * FROM loads WHERE id = $1 AND status = 'posted'`,
      [loadId]
    );

    if (loadCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Load not found or not available' });
    }

    // Get next sequence number
    const seqResult = await pool.query(
      `SELECT COALESCE(MAX(route_sequence), 0) + 1 as next_seq
       FROM loads WHERE driver_id = $1 AND status IN ('assigned', 'confirmed')`,
      [req.user.id]
    );
    const nextSeq = seqResult.rows[0].next_seq;

    // Assign load to driver with sequence
    const result = await pool.query(
      `UPDATE loads
       SET driver_id = $1,
           status = 'confirmed',
           route_sequence = $2,
           scheduled_date = $3,
           assigned_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $4
       RETURNING *`,
      [req.user.id, nextSeq, scheduledDate || null, loadId]
    );

    res.json({
      message: 'Load added to route',
      load: result.rows[0],
      sequence: nextSeq,
    });
  } catch (error) {
    console.error('[RoutePlanner] Add load error:', error);
    res.status(500).json({ error: 'Failed to add load to route' });
  }
});

/**
 * DELETE /route-planner/remove/:loadId
 * Remove a load from the planned route
 */
router.delete('/remove/:loadId', async (req, res) => {
  try {
    const { loadId } = req.params;

    // Verify driver owns this load
    const loadCheck = await pool.query(
      `SELECT * FROM loads WHERE id = $1 AND driver_id = $2 AND status = 'confirmed'`,
      [loadId, req.user.id]
    );

    if (loadCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Load not in your route queue' });
    }

    // Remove from queue (set back to posted)
    await pool.query(
      `UPDATE loads
       SET driver_id = NULL,
           status = 'posted',
           route_sequence = NULL,
           scheduled_date = NULL,
           assigned_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [loadId]
    );

    // Resequence remaining loads
    await pool.query(
      `WITH ranked AS (
         SELECT id, ROW_NUMBER() OVER (ORDER BY route_sequence) as new_seq
         FROM loads
         WHERE driver_id = $1 AND status IN ('assigned', 'confirmed')
       )
       UPDATE loads SET route_sequence = ranked.new_seq
       FROM ranked WHERE loads.id = ranked.id`,
      [req.user.id]
    );

    res.json({ message: 'Load removed from route' });
  } catch (error) {
    console.error('[RoutePlanner] Remove load error:', error);
    res.status(500).json({ error: 'Failed to remove load from route' });
  }
});

/**
 * PUT /route-planner/reorder
 * Reorder loads in the planned route
 */
router.put('/reorder', async (req, res) => {
  try {
    const { loadIds } = req.body; // Array of load IDs in new order

    if (!Array.isArray(loadIds)) {
      return res.status(400).json({ error: 'loadIds must be an array' });
    }

    // Update sequence for each load
    for (let i = 0; i < loadIds.length; i++) {
      await pool.query(
        `UPDATE loads
         SET route_sequence = $1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND driver_id = $3 AND status IN ('assigned', 'confirmed')`,
        [i + 1, loadIds[i], req.user.id]
      );
    }

    res.json({ message: 'Route reordered successfully' });
  } catch (error) {
    console.error('[RoutePlanner] Reorder error:', error);
    res.status(500).json({ error: 'Failed to reorder route' });
  }
});

/**
 * POST /route-planner/start
 * Start the first load in queue (move from confirmed to en_route_pickup)
 */
router.post('/start', async (req, res) => {
  try {
    // Get first confirmed load
    const result = await pool.query(
      `UPDATE loads
       SET status = 'en_route_pickup', updated_at = CURRENT_TIMESTAMP
       WHERE id = (
         SELECT id FROM loads
         WHERE driver_id = $1 AND status = 'confirmed'
         ORDER BY route_sequence ASC
         LIMIT 1
       )
       RETURNING *`,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No confirmed loads to start' });
    }

    res.json({
      message: 'Route started',
      activeLoad: result.rows[0],
    });
  } catch (error) {
    console.error('[RoutePlanner] Start route error:', error);
    res.status(500).json({ error: 'Failed to start route' });
  }
});

/**
 * GET /route-planner/suggestions
 * Get suggested loads near the driver's last delivery point
 */
router.get('/suggestions', async (req, res) => {
  try {
    // Get driver's last delivery location from queue
    const lastDelivery = await pool.query(
      `SELECT delivery_city, delivery_state
       FROM loads
       WHERE driver_id = $1 AND status IN ('assigned', 'confirmed')
       ORDER BY route_sequence DESC
       LIMIT 1`,
      [req.user.id]
    );

    let searchCity = 'Memphis'; // Default
    let searchState = 'TN';
    
    if (lastDelivery.rows.length > 0) {
      searchCity = lastDelivery.rows[0].delivery_city;
      searchState = lastDelivery.rows[0].delivery_state;
    }

    // Find available loads starting near that city
    const suggestions = await pool.query(
      `SELECT l.* FROM loads l
       WHERE l.status = 'posted'
         AND l.driver_id IS NULL
         AND (l.pickup_city = $1 OR l.pickup_state = $2)
       ORDER BY 
         CASE WHEN l.pickup_city = $1 THEN 0 ELSE 1 END,
         l.driver_payout DESC
       LIMIT 5`,
      [searchCity, searchState]
    );

    const loads = suggestions.rows.map(load => ({
      id: load.id,
      pickupCity: load.pickup_city,
      pickupState: load.pickup_state,
      deliveryCity: load.delivery_city,
      deliveryState: load.delivery_state,
      distanceMiles: parseFloat(load.distance_miles) || 0,
      driverPayout: parseFloat(load.driver_payout) || 0,
      description: load.description,
      matchReason: load.pickup_city === searchCity 
        ? `Pickup in ${searchCity}` 
        : `Pickup in ${searchState}`,
    }));

    res.json({
      suggestions: loads,
      basedOn: lastDelivery.rows.length > 0 
        ? `Your last drop-off: ${searchCity}, ${searchState}`
        : 'Your current location',
    });
  } catch (error) {
    console.error('[RoutePlanner] Suggestions error:', error);
    res.status(500).json({ error: 'Failed to get suggestions' });
  }
});

/**
 * GET /route-planner/map-data
 * Get all stops for map display
 */
router.get('/map-data', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, route_sequence,
        pickup_city, pickup_state, pickup_address,
        delivery_city, delivery_state, delivery_address,
        status
       FROM loads
       WHERE driver_id = $1 AND status IN ('assigned', 'confirmed')
       ORDER BY route_sequence ASC`,
      [req.user.id]
    );

    // Build list of stops in order
    const stops = [];
    result.rows.forEach((load, index) => {
      stops.push({
        type: 'pickup',
        loadId: load.id,
        sequence: index + 1,
        city: load.pickup_city,
        state: load.pickup_state,
        address: load.pickup_address,
        label: `P${index + 1}`,
      });
      stops.push({
        type: 'delivery',
        loadId: load.id,
        sequence: index + 1,
        city: load.delivery_city,
        state: load.delivery_state,
        address: load.delivery_address,
        label: `D${index + 1}`,
      });
    });

    res.json({ stops, totalLoads: result.rows.length });
  } catch (error) {
    console.error('[RoutePlanner] Map data error:', error);
    res.status(500).json({ error: 'Failed to get map data' });
  }
});

module.exports = router;
