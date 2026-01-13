// Load Routes - Updated with Shipper Features
const express = require('express');
const { pool } = require('../db/pool');
const { authenticate, requireUserType } = require('../middleware/auth');

const router = express.Router();
const notificationService = require('../services/notificationService');

/**
 * POST /loads/seed
 * Seed test loads for development
 */
router.post('/seed', async (req, res) => {
  try {
    // Get a shipper user (or use first user as shipper)
    const userResult = await pool.query(
      `SELECT id FROM users WHERE role = 'shipper' LIMIT 1`
    );
    
    let shipperId;
    if (userResult.rows.length > 0) {
      shipperId = userResult.rows[0].id;
    } else {
      // Use first user if no shipper exists
      const anyUser = await pool.query(`SELECT id FROM users LIMIT 1`);
      shipperId = anyUser.rows[0]?.id;
    }

    if (!shipperId) {
      return res.status(400).json({ error: 'No users exist. Create a user first.' });
    }

    const testLoads = [
      {
        description: 'Furniture delivery - 2 couches and dining table',
        pickup_city: 'Memphis', pickup_state: 'TN', pickup_zip: '38103',
        pickup_address: '123 Union Ave',
        delivery_city: 'Nashville', delivery_state: 'TN', delivery_zip: '37203',
        delivery_address: '456 Broadway',
        distance_miles: 210, weight_lbs: 800, price: 450,
        vehicle_type_required: 'Box Truck 24ft',
        load_type: 'standard',
      },
      {
        description: 'Auto parts - urgent same day',
        pickup_city: 'Memphis', pickup_state: 'TN', pickup_zip: '38118',
        pickup_address: '789 Airways Blvd',
        delivery_city: 'Little Rock', delivery_state: 'AR', delivery_zip: '72201',
        delivery_address: '321 Main St',
        distance_miles: 135, weight_lbs: 350, price: 325,
        vehicle_type_required: 'Cargo Van',
        load_type: 'hotshot',
        expedited_fee: 75,
      },
      {
        description: 'Medical equipment - handle with care',
        pickup_city: 'Nashville', pickup_state: 'TN', pickup_zip: '37203',
        pickup_address: '100 Medical Center Dr',
        delivery_city: 'Memphis', delivery_state: 'TN', delivery_zip: '38103',
        delivery_address: '200 Hospital Way',
        distance_miles: 210, weight_lbs: 150, price: 525,
        vehicle_type_required: 'Sprinter Van',
        is_fragile: true,
        load_type: 'emergency',
        expedited_fee: 150,
      },
      {
        description: 'Retail inventory - palletized goods',
        pickup_city: 'Jackson', pickup_state: 'MS', pickup_zip: '39201',
        pickup_address: '500 Distribution Pkwy',
        delivery_city: 'Memphis', delivery_state: 'TN', delivery_zip: '38118',
        delivery_address: '600 Warehouse Blvd',
        distance_miles: 210, weight_lbs: 2500, price: 680,
        vehicle_type_required: 'Dry Van 53ft',
        requires_liftgate: true,
        requires_pallet_jack: true,
        load_type: 'standard',
      },
      {
        description: 'Construction materials',
        pickup_city: 'Tupelo', pickup_state: 'MS', pickup_zip: '38801',
        pickup_address: '888 Industrial Rd',
        delivery_city: 'Memphis', delivery_state: 'TN', delivery_zip: '38116',
        delivery_address: '999 Construction Ave',
        distance_miles: 110, weight_lbs: 3500, price: 395,
        vehicle_type_required: 'Flatbed 48ft',
        load_type: 'standard',
      },
    ];

    const insertedLoads = [];

    for (const load of testLoads) {
      const driverPayout = load.price * 0.85;
      const platformFee = load.price * 0.15;

      const result = await pool.query(
        `INSERT INTO loads (
          shipper_id, description,
          pickup_address, pickup_city, pickup_state, pickup_zip,
          delivery_address, delivery_city, delivery_state, delivery_zip,
          distance_miles, weight_lbs, price, driver_payout, platform_fee,
          vehicle_type_required, is_fragile, requires_liftgate, requires_pallet_jack,
          load_type, expedited_fee,
          status, posted_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, 'posted', CURRENT_TIMESTAMP)
        RETURNING id`,
        [
          shipperId, load.description,
          load.pickup_address, load.pickup_city, load.pickup_state, load.pickup_zip,
          load.delivery_address, load.delivery_city, load.delivery_state, load.delivery_zip,
          load.distance_miles, load.weight_lbs, load.price, driverPayout, platformFee,
          load.vehicle_type_required, load.is_fragile || false, load.requires_liftgate || false, load.requires_pallet_jack || false,
          load.load_type || 'standard', load.expedited_fee || 0,
        ]
      );

      insertedLoads.push(result.rows[0].id);
    }

    res.status(201).json({
      message: `${insertedLoads.length} test loads created`,
      loadIds: insertedLoads,
    });
  } catch (error) {
    console.error('[Loads] Seed error:', error);
    res.status(500).json({ error: 'Failed to seed loads', details: error.message });
  }
});

/**
 * POST /loads
 * Create a new load (shipper only)
 * Updated to support loadType, expeditedFee, pieces, company names
 */
router.post('/',
  authenticate,
  requireUserType('shipper'),
  async (req, res) => {
    try {
      const {
        description,
        // Pickup fields
        pickupAddress, pickupCity, pickupState, pickupZip,
        pickupCompanyName, pickupContactName, pickupContactPhone,
        pickupDate, pickupTimeStart, pickupTimeEnd,
        pickupInstructions,
        // Delivery fields
        deliveryAddress, deliveryCity, deliveryState, deliveryZip,
        deliveryCompanyName, deliveryContactName, deliveryContactPhone,
        deliveryDate, deliveryTimeStart, deliveryTimeEnd,
        deliveryInstructions,
        // Cargo fields
        weightLbs, dimensions, pieces, vehicleTypeRequired,
        isFragile, requiresLiftgate, requiresPalletJack,
        specialRequirements,
        // Pricing & type
        price, loadType, expeditedFee,
      } = req.body;

      // Simple distance estimate (would use real geocoding in production)
      const distanceMiles = 100; // placeholder
      const basePrice = price || distanceMiles * 2.5;
      const totalExpedited = parseFloat(expeditedFee) || 0;
      const totalPrice = basePrice + totalExpedited;
      const driverPayout = totalPrice * 0.85;
      const platformFee = totalPrice * 0.15;

      const result = await pool.query(
        `INSERT INTO loads (
          shipper_id, description,
          pickup_address, pickup_city, pickup_state, pickup_zip,
          pickup_company_name, pickup_contact_name, pickup_contact_phone,
          pickup_date, pickup_time_start, pickup_time_end,
          pickup_instructions,
          delivery_address, delivery_city, delivery_state, delivery_zip,
          delivery_company_name, delivery_contact_name, delivery_contact_phone,
          delivery_date, delivery_time_start, delivery_time_end,
          delivery_instructions,
          weight_lbs, dimensions, pieces, vehicle_type_required,
          is_fragile, requires_liftgate, requires_pallet_jack,
          special_requirements,
          distance_miles, price, driver_payout, platform_fee,
          load_type, expedited_fee,
          status, posted_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38, 'posted', CURRENT_TIMESTAMP
        ) RETURNING *`,
        [
          req.user.id, description,
          pickupAddress, pickupCity, pickupState, pickupZip,
          pickupCompanyName, pickupContactName, pickupContactPhone,
          pickupDate, pickupTimeStart, pickupTimeEnd,
          pickupInstructions,
          deliveryAddress, deliveryCity, deliveryState, deliveryZip,
          deliveryCompanyName, deliveryContactName, deliveryContactPhone,
          deliveryDate, deliveryTimeStart, deliveryTimeEnd,
          deliveryInstructions,
          weightLbs, dimensions, pieces || 1, vehicleTypeRequired,
          isFragile || false, requiresLiftgate || false, requiresPalletJack || false,
          specialRequirements,
          distanceMiles, totalPrice, driverPayout, platformFee,
          loadType || 'standard', totalExpedited,
        ]
      );

      const load = result.rows[0];

      res.status(201).json({
        message: 'Load posted successfully',
        load: formatLoadResponse(load),
      });
    } catch (error) {
      console.error('[Loads] Create error:', error);
      res.status(500).json({ error: 'Failed to create load' });
    }
  }
);

/**
 * GET /loads
 * Get loads (filtered by user type)
 */
router.get('/', authenticate, async (req, res) => {
  try {
    const { status, limit = 20, offset = 0 } = req.query;

    let query;
    let params;

    if (req.user.role === 'shipper') {
      // Shippers see their own loads
      query = `
        SELECT l.*, 
          CONCAT(u.first_name, ' ', u.last_name) as driver_name,
          u.phone as driver_phone
        FROM loads l
        LEFT JOIN users u ON l.driver_id = u.id
        WHERE l.shipper_id = $1
        ${status ? 'AND l.status = $2' : ''}
        ORDER BY l.created_at DESC
        LIMIT $${status ? 3 : 2} OFFSET $${status ? 4 : 3}`;
      params = status
        ? [req.user.id, status, limit, offset]
        : [req.user.id, limit, offset];
    } else {
      // Drivers see available loads or their assigned loads
      if (status === 'available') {
        query = `
          SELECT l.*, 
            CONCAT(u.first_name, ' ', u.last_name) as shipper_name
          FROM loads l
          JOIN users u ON l.shipper_id = u.id
          WHERE l.status = 'posted'
          ORDER BY l.posted_at DESC
          LIMIT $1 OFFSET $2`;
        params = [limit, offset];
      } else {
        query = `
          SELECT l.*, 
            CONCAT(u.first_name, ' ', u.last_name) as shipper_name
          FROM loads l
          JOIN users u ON l.shipper_id = u.id
          WHERE l.driver_id = $1
          ${status ? 'AND l.status = $2' : ''}
          ORDER BY l.created_at DESC
          LIMIT $${status ? 3 : 2} OFFSET $${status ? 4 : 3}`;
        params = status
          ? [req.user.id, status, limit, offset]
          : [req.user.id, limit, offset];
      }
    }

    const result = await pool.query(query, params);

    res.json({
      loads: result.rows.map(formatLoadResponse),
      count: result.rows.length,
    });
  } catch (error) {
    console.error('[Loads] List error:', error);
    res.status(500).json({ error: 'Failed to get loads' });
  }
});

/**
 * GET /loads/available
 * Get available loads for drivers
 */
router.get('/available', authenticate, async (req, res) => {
  try {
    const { limit = 20, offset = 0 } = req.query;

    const result = await pool.query(
      `SELECT l.*, 
        CONCAT(u.first_name, ' ', u.last_name) as shipper_name
       FROM loads l
       JOIN users u ON l.shipper_id = u.id
       WHERE l.status = 'posted'
       ORDER BY l.posted_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    res.json({
      loads: result.rows.map(formatLoadResponse),
      count: result.rows.length,
    });
  } catch (error) {
    console.error('[Loads] Available error:', error);
    res.status(500).json({ error: 'Failed to get available loads' });
  }
});

/**
 * GET /loads/active
 * Get driver's currently active load
 * MUST BE BEFORE /:id route!
 */
router.get('/active', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT l.*,
        CONCAT(shipper.first_name, ' ', shipper.last_name) as shipper_name,
        shipper.phone as shipper_phone,
        shipper.company_name as shipper_company,
        shipper.id as shipper_user_id
       FROM loads l
       JOIN users shipper ON l.shipper_id = shipper.id
       WHERE l.driver_id = $1 
         AND l.status IN ('assigned', 'accepted', 'en_route_pickup', 'at_pickup', 'picked_up', 'en_route_delivery', 'at_delivery')
       ORDER BY l.assigned_at DESC
       LIMIT 1`,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No active load' });
    }

    const load = result.rows[0];
    
    res.json({
      load: {
        ...formatLoadResponse(load, true),
        shipper: {
          id: load.shipper_user_id,
          name: load.shipper_name,
          companyName: load.shipper_company,
          phone: load.shipper_phone,
        }
      }
    });
  } catch (error) {
    console.error('[Loads] Active load error:', error);
    res.status(500).json({ error: 'Failed to get active load' });
  }
});

/**
 * GET /loads/company
 * Get all loads for the user's company (team view)
 * MUST BE BEFORE /:id route!
 */
router.get('/company', authenticate, async (req, res) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;

    // Get user's company_id
    const userResult = await pool.query(
      'SELECT company_id FROM users WHERE id = $1',
      [req.user.id]
    );

    const companyId = userResult.rows[0]?.company_id;

    let query;
    let params;

    if (companyId) {
      // Get all loads from users in the same company
      query = `
        SELECT l.*, 
          CONCAT(shipper.first_name, ' ', shipper.last_name) as shipper_name,
          shipper.email as shipper_email,
          shipper.department as shipper_department,
          CONCAT(driver.first_name, ' ', driver.last_name) as driver_name,
          driver.phone as driver_phone
        FROM loads l
        JOIN users shipper ON l.shipper_id = shipper.id
        LEFT JOIN users driver ON l.driver_id = driver.id
        WHERE shipper.company_id = $1
        ${status ? 'AND l.status = $2' : ''}
        ORDER BY l.created_at DESC
        LIMIT $${status ? 3 : 2} OFFSET $${status ? 4 : 3}`;
      params = status
        ? [companyId, status, limit, offset]
        : [companyId, limit, offset];
    } else {
      // Solo user - just get their own loads
      query = `
        SELECT l.*, 
          CONCAT(shipper.first_name, ' ', shipper.last_name) as shipper_name,
          shipper.email as shipper_email,
          shipper.department as shipper_department,
          CONCAT(driver.first_name, ' ', driver.last_name) as driver_name,
          driver.phone as driver_phone
        FROM loads l
        JOIN users shipper ON l.shipper_id = shipper.id
        LEFT JOIN users driver ON l.driver_id = driver.id
        WHERE l.shipper_id = $1
        ${status ? 'AND l.status = $2' : ''}
        ORDER BY l.created_at DESC
        LIMIT $${status ? 3 : 2} OFFSET $${status ? 4 : 3}`;
      params = status
        ? [req.user.id, status, limit, offset]
        : [req.user.id, limit, offset];
    }

    const result = await pool.query(query, params);

    // Get stats
    let statsQuery;
    let statsParams;

    if (companyId) {
      statsQuery = `
        SELECT 
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE l.status NOT IN ('delivered', 'cancelled', 'completed')) as active,
          COUNT(*) FILTER (WHERE l.status IN ('delivered', 'completed')) as completed,
          COALESCE(SUM(l.price) FILTER (WHERE l.status IN ('delivered', 'completed')), 0) as total_spent
        FROM loads l
        JOIN users shipper ON l.shipper_id = shipper.id
        WHERE shipper.company_id = $1`;
      statsParams = [companyId];
    } else {
      statsQuery = `
        SELECT 
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status NOT IN ('delivered', 'cancelled', 'completed')) as active,
          COUNT(*) FILTER (WHERE status IN ('delivered', 'completed')) as completed,
          COALESCE(SUM(price) FILTER (WHERE status IN ('delivered', 'completed')), 0) as total_spent
        FROM loads
        WHERE shipper_id = $1`;
      statsParams = [req.user.id];
    }

    const statsResult = await pool.query(statsQuery, statsParams);
    const stats = statsResult.rows[0];

    res.json({
      loads: result.rows.map(load => ({
        ...formatLoadResponse(load),
        shipperName: load.shipper_name,
        shipperEmail: load.shipper_email,
        shipperDepartment: load.shipper_department,
      })),
      count: result.rows.length,
      stats: {
        total: parseInt(stats.total) || 0,
        active: parseInt(stats.active) || 0,
        completed: parseInt(stats.completed) || 0,
        totalSpent: parseFloat(stats.total_spent) || 0,
      }
    });
  } catch (error) {
    console.error('[Loads] Company loads error:', error);
    res.status(500).json({ error: 'Failed to get company loads' });
  }
});

/**
 * GET /loads/:id
 * Get single load details WITH driver location for tracking
 * FIXED: Now returns driver GPS coordinates for shipper tracking
 */
router.get('/:id', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT l.*,
        CONCAT(shipper.first_name, ' ', shipper.last_name) as shipper_name, 
        shipper.phone as shipper_phone,
        shipper.id as shipper_user_id,
        CONCAT(driver.first_name, ' ', driver.last_name) as driver_name, 
        driver.phone as driver_phone,
        driver.id as driver_user_id,
        driver.vehicle_type as driver_vehicle_type,
        driver.license_plate as driver_license_plate,
        driver.driver_lat as driver_current_lat,
        driver.driver_lng as driver_current_lng,
        driver.location_updated_at as driver_location_updated_at
       FROM loads l
       JOIN users shipper ON l.shipper_id = shipper.id
       LEFT JOIN users driver ON l.driver_id = driver.id
       WHERE l.id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Load not found' });
    }

    const load = result.rows[0];

    // Check authorization
    const isShipper = load.shipper_id === req.user.id;
    const isDriver = load.driver_id === req.user.id;
    const isAvailable = load.status === 'posted';

    if (!isShipper && !isDriver && !isAvailable) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Build response with driver object containing location
    const response = {
      ...formatLoadResponse(load, true),
      shipper: {
        id: load.shipper_user_id,
        name: load.shipper_name,
        phone: load.shipper_phone,
      },
    };

    // Include driver info with current location if driver is assigned
    if (load.driver_id) {
      response.driver = {
        id: load.driver_user_id,
        firstName: load.driver_name ? load.driver_name.split(' ')[0] : null,
        lastName: load.driver_name ? load.driver_name.split(' ').slice(1).join(' ') : null,
        name: load.driver_name,
        phone: load.driver_phone,
        vehicleType: load.driver_vehicle_type,
        licensePlate: load.driver_license_plate,
        currentLat: load.driver_current_lat ? parseFloat(load.driver_current_lat) : null,
        currentLng: load.driver_current_lng ? parseFloat(load.driver_current_lng) : null,
        lastLocationUpdate: load.driver_location_updated_at,
      };
    }

    res.json(response);
  } catch (error) {
    console.error('[Loads] Get error:', error);
    res.status(500).json({ error: 'Failed to get load' });
  }
});

/**
 * POST /loads/:id/cancel
 * Cancel a load (shipper only, before pickup)
 */
router.post('/:id/cancel',
  authenticate,
  async (req, res) => {
    try {
      const { reason } = req.body;

      // Get load and verify ownership
      const checkResult = await pool.query(
        'SELECT * FROM loads WHERE id = $1',
        [req.params.id]
      );

      if (checkResult.rows.length === 0) {
        return res.status(404).json({ error: 'Load not found' });
      }

      const load = checkResult.rows[0];

      // Only shipper can cancel
      if (load.shipper_id !== req.user.id) {
        return res.status(403).json({ error: 'Only the shipper can cancel this load' });
      }

      // Can only cancel if not yet picked up
      const cancelableStatuses = ['posted', 'assigned', 'accepted', 'en_route_pickup'];
      if (!cancelableStatuses.includes(load.status)) {
        return res.status(400).json({ 
          error: 'Cannot cancel load after pickup',
          currentStatus: load.status
        });
      }

      // Cancel the load
      const result = await pool.query(
        `UPDATE loads 
         SET status = 'cancelled', 
             cancelled_at = CURRENT_TIMESTAMP,
             cancelled_by = $1,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2
         RETURNING *`,
        [req.user.id, req.params.id]
      );

      // TODO: If driver was assigned, notify them
      // TODO: Handle any payment refunds

      res.json({
        message: 'Load cancelled successfully',
        load: formatLoadResponse(result.rows[0]),
      });
    } catch (error) {
      console.error('[Loads] Cancel error:', error);
      res.status(500).json({ error: 'Failed to cancel load' });
    }
  }
);

/**
 * POST /loads/:id/accept
 * Accept a load (driver only)
 */
router.post('/:id/accept',
  authenticate,
  requireUserType('driver'),
  async (req, res) => {
    try {
      // Check if load is available
      const checkResult = await pool.query(
        'SELECT * FROM loads WHERE id = $1 AND status = \'posted\'',
        [req.params.id]
      );

      if (checkResult.rows.length === 0) {
        return res.status(400).json({ error: 'Load not available' });
      }

      // Assign load to driver
      const result = await pool.query(
        `UPDATE loads 
         SET driver_id = $1, 
             status = 'assigned', 
             assigned_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2
         RETURNING *`,
        [req.user.id, req.params.id]
      );

      // Notify shipper that driver accepted
      const load = result.rows[0];
      const driverResult = await pool.query('SELECT first_name, last_name FROM users WHERE id = $1', [req.user.id]);
      const driverName = driverResult.rows[0] ? `${driverResult.rows[0].first_name} ${driverResult.rows[0].last_name || ''}`.trim() : 'Driver';
      
      notificationService.notifyShipperDriverAccepted(load.shipper_id, driverName, {
        loadId: load.id,
        deliveryCity: load.delivery_city,
      }).catch(err => console.error('[Notifications] Error:', err));

      res.json({
        message: 'Load accepted',
        load: formatLoadResponse(result.rows[0]),
      });
    } catch (error) {
      console.error('[Loads] Accept error:', error);
      res.status(500).json({ error: 'Failed to accept load' });
    }
  }
);

/**
 * PUT /loads/:id/status
 * Update load status
 */
router.put('/:id/status',
  authenticate,
  async (req, res) => {
    try {
      const { status } = req.body;

      const validStatuses = ['en_route_pickup', 'at_pickup', 'picked_up', 'en_route_delivery', 'at_delivery', 'delivered', 'completed', 'cancelled'];

      if (!validStatuses.includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
      }

      // Get current load
      const checkResult = await pool.query(
        'SELECT * FROM loads WHERE id = $1 AND (driver_id = $2 OR shipper_id = $2)',
        [req.params.id, req.user.id]
      );

      if (checkResult.rows.length === 0) {
        return res.status(404).json({ error: 'Load not found or access denied' });
      }

      // Update status with appropriate timestamp
      let updateQuery = 'UPDATE loads SET status = $1, updated_at = CURRENT_TIMESTAMP';
      
      if (status === 'picked_up') {
        updateQuery += ', picked_up_at = CURRENT_TIMESTAMP';
      } else if (status === 'delivered') {
        updateQuery += ', delivered_at = CURRENT_TIMESTAMP';
      } else if (status === 'completed') {
        updateQuery += ', completed_at = CURRENT_TIMESTAMP';
      } else if (status === 'cancelled') {
        updateQuery += ', cancelled_at = CURRENT_TIMESTAMP, cancelled_by = $3';
      }

      updateQuery += ' WHERE id = $2 RETURNING *';

      const params = status === 'cancelled' 
        ? [status, req.params.id, req.user.id]
        : [status, req.params.id];

      const result = await pool.query(updateQuery, params);

      // Notify shipper of status change
      const load = result.rows[0];
      if (load.shipper_id && req.user.role === 'driver') {
        const driverResult = await pool.query('SELECT first_name, last_name FROM users WHERE id = $1', [req.user.id]);
        const driverName = driverResult.rows[0] ? `${driverResult.rows[0].first_name} ${driverResult.rows[0].last_name || ''}`.trim() : 'Driver';
        
        notificationService.notifyShipperStatusChange(load.shipper_id, status, driverName, {
          loadId: load.id,
          deliveryCity: load.delivery_city,
          pickupCity: load.pickup_city,
        }).catch(err => console.error('[Notifications] Status change error:', err));
      }

      res.json({
        message: `Status updated to ${status}`,
        load: formatLoadResponse(result.rows[0]),
      });
    } catch (error) {
      console.error('[Loads] Status update error:', error);
      res.status(500).json({ error: 'Failed to update status' });
    }
  }
);

/**
 * PUT /loads/:id/location
 * Update driver location for a load
 */
router.put('/:id/location',
  authenticate,
  async (req, res) => {
    try {
      const { lat, lng } = req.body;

      // Verify driver owns this load
      const checkResult = await pool.query(
        'SELECT * FROM loads WHERE id = $1 AND driver_id = $2',
        [req.params.id, req.user.id]
      );

      if (checkResult.rows.length === 0) {
        return res.status(404).json({ error: 'Load not found or access denied' });
      }

      // Update driver location in driver_profiles
      await pool.query(
        `UPDATE driver_profiles 
         SET current_lat = $1, current_lng = $2, location_updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $3`,
        [lat, lng, req.user.id]
      );

      res.json({ message: 'Location updated' });
    } catch (error) {
      console.error('[Loads] Location update error:', error);
      res.status(500).json({ error: 'Failed to update location' });
    }
  }
);

// Helper: Format load response
function formatLoadResponse(load, detailed = false) {
  const response = {
    id: load.id,
    status: load.status,
    loadType: load.load_type || 'standard',
    description: load.description,
    weightLbs: load.weight_lbs,
    pieces: load.pieces || 1,
    pickupCity: load.pickup_city,
    pickupState: load.pickup_state,
    deliveryCity: load.delivery_city,
    deliveryState: load.delivery_state,
    distanceMiles: parseFloat(load.distance_miles) || 0,
    price: parseFloat(load.price) || 0,
    expeditedFee: parseFloat(load.expedited_fee) || 0,
    driverPayout: parseFloat(load.driver_payout) || 0,
    postedAt: load.posted_at,
    createdAt: load.created_at,
    shipperName: load.shipper_name,
    driverName: load.driver_name,
    driverPhone: load.driver_phone,
    shipperRated: load.shipper_rated || false,
    equipmentType: load.equipment_type || load.vehicle_type_required,
    vehicleTypeRequired: load.vehicle_type_required,
  };

  if (detailed) {
    Object.assign(response, {
      // Pickup details
      pickupAddress: load.pickup_address,
      pickupZip: load.pickup_zip,
      pickupLat: parseFloat(load.pickup_lat),
      pickupLng: parseFloat(load.pickup_lng),
      pickupCompanyName: load.pickup_company_name,
      pickupContactName: load.pickup_contact_name,
      pickupContactPhone: load.pickup_contact_phone,
      pickupDate: load.pickup_date,
      pickupTimeStart: load.pickup_time_start,
      pickupTimeEnd: load.pickup_time_end,
      pickupInstructions: load.pickup_instructions || load.pickup_notes,
      // Delivery details
      deliveryAddress: load.delivery_address,
      deliveryZip: load.delivery_zip,
      deliveryLat: parseFloat(load.delivery_lat),
      deliveryLng: parseFloat(load.delivery_lng),
      deliveryCompanyName: load.delivery_company_name,
      deliveryContactName: load.delivery_contact_name,
      deliveryContactPhone: load.delivery_contact_phone,
      deliveryDate: load.delivery_date,
      deliveryTimeStart: load.delivery_time_start,
      deliveryTimeEnd: load.delivery_time_end,
      deliveryInstructions: load.delivery_instructions || load.delivery_notes,
      // Cargo details
      dimensions: load.dimensions,
      isFragile: load.is_fragile,
      requiresLiftgate: load.requires_liftgate,
      requiresPalletJack: load.requires_pallet_jack,
      specialRequirements: load.special_requirements,
      // Pricing
      platformFee: parseFloat(load.platform_fee) || 0,
      // People
      shipperId: load.shipper_id,
      driverId: load.driver_id,
      shipperPhone: load.shipper_phone,
      // Timestamps
      assignedAt: load.assigned_at,
      pickedUpAt: load.picked_up_at,
      deliveredAt: load.delivered_at,
      completedAt: load.completed_at,
      cancelledAt: load.cancelled_at,
    });
  }

  return response;
}

module.exports = router;




