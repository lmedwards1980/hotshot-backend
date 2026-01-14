// Load Routes - Updated with Org Context for 5-Role Model
const express = require('express');
const { pool } = require('../db/pool');
const { authenticate, requireUserType } = require('../middleware/auth');

const router = express.Router();
const notificationService = require('../services/notificationService');

/**
 * Helper: Get user's primary org and role
 */
const getUserPrimaryOrg = async (userId) => {
  const result = await pool.query(`
    SELECT 
      o.id as org_id,
      o.org_type,
      o.name as org_name,
      o.verification_status,
      m.role,
      m.permissions
    FROM memberships m
    JOIN orgs o ON m.org_id = o.id
    WHERE m.user_id = $1 AND m.is_active = true AND o.is_active = true
    ORDER BY m.is_primary DESC, m.joined_at ASC
    LIMIT 1
  `, [userId]);
  
  return result.rows[0] || null;
};

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

    // Get user's org if exists
    const userOrg = await getUserPrimaryOrg(shipperId);

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
          shipper_id, posted_by_user_id, posted_by_org_id,
          description,
          pickup_address, pickup_city, pickup_state, pickup_zip,
          delivery_address, delivery_city, delivery_state, delivery_zip,
          distance_miles, weight_lbs, price, driver_payout, platform_fee,
          vehicle_type_required, is_fragile, requires_liftgate, requires_pallet_jack,
          load_type, expedited_fee,
          status, posted_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, 'posted', CURRENT_TIMESTAMP)
        RETURNING id`,
        [
          shipperId, shipperId, userOrg?.org_id || null,
          load.description,
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
 * Create a new load (shipper/broker only)
 * Updated with org context and broker fields
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
        pickupLat, pickupLng,
        pickupCompanyName, pickupContactName, pickupContactPhone,
        pickupDate, pickupTimeStart, pickupTimeEnd,
        pickupInstructions,
        // Delivery fields
        deliveryAddress, deliveryCity, deliveryState, deliveryZip,
        deliveryLat, deliveryLng,
        deliveryCompanyName, deliveryContactName, deliveryContactPhone,
        deliveryDate, deliveryTimeStart, deliveryTimeEnd,
        deliveryInstructions,
        // Cargo fields
        weightLbs, dimensions, pieces, vehicleTypeRequired,
        isFragile, requiresLiftgate, requiresPalletJack,
        specialRequirements,
        // Pricing & type
        price, loadType, expeditedFee,
        distanceMiles,
        // NEW: Broker fields
        customerName,        // Broker's customer name
        customerLoadNumber,  // Customer's load reference
        customerPo,          // Customer PO number
        customerRate,        // What broker charges customer
        carrierPay,          // What broker pays carrier (their margin)
        // NEW: Booking options
        allowOffers,         // Allow carriers to submit offers
        allowBookNow,        // Allow instant booking at posted rate
        minOffer,            // Minimum acceptable offer
        verifiedOnly,        // Only verified carriers can book
        trackingRequired,    // Require tracking
      } = req.body;

      // Get user's org context
      const userOrg = await getUserPrimaryOrg(req.user.id);
      const isBroker = userOrg?.org_type === 'broker';

      // Calculate pricing
      const distance = parseFloat(distanceMiles) || 100;
      const basePrice = parseFloat(price) || distance * 2.5;
      const totalExpedited = parseFloat(expeditedFee) || 0;
      const totalPrice = basePrice + totalExpedited;
      
      // For brokers: carrier_pay is what they pay carrier, price is what customer pays
      // For shippers: carrier_pay = driver_payout (85% of price)
      let finalCarrierPay;
      let finalCustomerRate;
      
      if (isBroker && carrierPay) {
        finalCarrierPay = parseFloat(carrierPay);
        finalCustomerRate = parseFloat(customerRate) || totalPrice;
      } else {
        finalCarrierPay = totalPrice * 0.85;
        finalCustomerRate = null;
      }
      
      const driverPayout = finalCarrierPay * 0.85; // Driver gets 85% of carrier pay
      const platformFee = totalPrice * 0.15;

      const result = await pool.query(
        `INSERT INTO loads (
          shipper_id, posted_by_user_id, posted_by_org_id,
          description,
          pickup_address, pickup_city, pickup_state, pickup_zip,
          pickup_lat, pickup_lng,
          pickup_company_name, pickup_contact_name, pickup_contact_phone,
          pickup_date, pickup_time_start, pickup_time_end,
          pickup_instructions,
          delivery_address, delivery_city, delivery_state, delivery_zip,
          delivery_lat, delivery_lng,
          delivery_company_name, delivery_contact_name, delivery_contact_phone,
          delivery_date, delivery_time_start, delivery_time_end,
          delivery_instructions,
          weight_lbs, dimensions, pieces, vehicle_type_required,
          is_fragile, requires_liftgate, requires_pallet_jack,
          special_requirements,
          distance_miles, price, driver_payout, platform_fee,
          load_type, expedited_fee,
          customer_name, customer_load_number, customer_po, customer_rate,
          carrier_pay,
          allow_offers, allow_book_now, min_offer,
          verified_only, tracking_required,
          status, posted_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38, $39, $40, $41, $42, $43, $44, $45, $46, $47, $48, $49, $50, $51, $52, $53, $54,
          'posted', CURRENT_TIMESTAMP
        ) RETURNING *`,
        [
          req.user.id, req.user.id, userOrg?.org_id || null,
          description,
          pickupAddress, pickupCity, pickupState, pickupZip,
          pickupLat || null, pickupLng || null,
          pickupCompanyName, pickupContactName, pickupContactPhone,
          pickupDate, pickupTimeStart, pickupTimeEnd,
          pickupInstructions,
          deliveryAddress, deliveryCity, deliveryState, deliveryZip,
          deliveryLat || null, deliveryLng || null,
          deliveryCompanyName, deliveryContactName, deliveryContactPhone,
          deliveryDate, deliveryTimeStart, deliveryTimeEnd,
          deliveryInstructions,
          weightLbs, dimensions, pieces || 1, vehicleTypeRequired,
          isFragile || false, requiresLiftgate || false, requiresPalletJack || false,
          specialRequirements,
          distance, totalPrice, driverPayout, platformFee,
          loadType || 'standard', totalExpedited,
          isBroker ? customerName : null,
          isBroker ? customerLoadNumber : null,
          isBroker ? customerPo : null,
          finalCustomerRate,
          finalCarrierPay,
          allowOffers !== false, // default true
          allowBookNow !== false, // default true
          minOffer || null,
          verifiedOnly || false,
          trackingRequired !== false, // default true
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
 * Get loads (filtered by user type and org)
 * - Shippers/Brokers: See all loads from their org
 * - Drivers: See their assigned loads
 * - Carriers/Dispatchers: See available loads to bid on
 */
router.get('/', authenticate, async (req, res) => {
  try {
    const { status, limit = 20, offset = 0 } = req.query;

    // Get user's org context
    const userOrg = await getUserPrimaryOrg(req.user.id);

    let query;
    let params;

    if (req.user.role === 'shipper') {
      // Shippers/Brokers see loads from their org (team visibility)
      if (userOrg?.org_id) {
        // Org member - see all org loads
        query = `
          SELECT l.*, 
            CONCAT(u.first_name, ' ', u.last_name) as driver_name,
            u.phone as driver_phone,
            CONCAT(poster.first_name, ' ', poster.last_name) as posted_by_name,
            o.name as org_name,
            o.org_type
          FROM loads l
          LEFT JOIN users u ON l.driver_id = u.id
          LEFT JOIN users poster ON l.posted_by_user_id = poster.id
          LEFT JOIN orgs o ON l.posted_by_org_id = o.id
          WHERE l.posted_by_org_id = $1
          ${status ? 'AND l.status = $2' : ''}
          ORDER BY l.created_at DESC
          LIMIT $${status ? 3 : 2} OFFSET $${status ? 4 : 3}`;
        params = status
          ? [userOrg.org_id, status, limit, offset]
          : [userOrg.org_id, limit, offset];
      } else {
        // Solo shipper - see only their loads
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
      }
    } else {
      // Drivers/Carriers/Dispatchers
      if (status === 'available') {
        query = `
          SELECT l.*, 
            CONCAT(u.first_name, ' ', u.last_name) as shipper_name,
            o.name as shipper_org_name,
            o.org_type as shipper_org_type,
            o.verification_status as shipper_verification
          FROM loads l
          JOIN users u ON l.shipper_id = u.id
          LEFT JOIN orgs o ON l.posted_by_org_id = o.id
          WHERE l.status = 'posted'
          ORDER BY l.posted_at DESC
          LIMIT $1 OFFSET $2`;
        params = [limit, offset];
      } else {
        // Driver's assigned loads
        query = `
          SELECT l.*, 
            CONCAT(u.first_name, ' ', u.last_name) as shipper_name,
            o.name as shipper_org_name
          FROM loads l
          JOIN users u ON l.shipper_id = u.id
          LEFT JOIN orgs o ON l.posted_by_org_id = o.id
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
      org: userOrg ? {
        id: userOrg.org_id,
        name: userOrg.org_name,
        type: userOrg.org_type,
        role: userOrg.role,
      } : null,
    });
  } catch (error) {
    console.error('[Loads] List error:', error);
    res.status(500).json({ error: 'Failed to get loads' });
  }
});

/**
 * GET /loads/available
 * Get available loads for carriers/dispatchers/drivers
 */
router.get('/available', authenticate, async (req, res) => {
  try {
    const { limit = 20, offset = 0 } = req.query;

    // Get user's org to check verification status for priority matching
    const userOrg = await getUserPrimaryOrg(req.user.id);

    const result = await pool.query(
      `SELECT l.*, 
        CONCAT(u.first_name, ' ', u.last_name) as shipper_name,
        o.name as shipper_org_name,
        o.org_type as shipper_org_type,
        o.verification_status as shipper_verification
       FROM loads l
       JOIN users u ON l.shipper_id = u.id
       LEFT JOIN orgs o ON l.posted_by_org_id = o.id
       WHERE l.status = 'posted'
       ORDER BY l.posted_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    res.json({
      loads: result.rows.map(load => ({
        ...formatLoadResponse(load),
        shipperOrgName: load.shipper_org_name,
        shipperOrgType: load.shipper_org_type,
        shipperVerified: load.shipper_verification === 'verified',
      })),
      count: result.rows.length,
      userOrg: userOrg ? {
        id: userOrg.org_id,
        name: userOrg.org_name,
        type: userOrg.org_type,
        verified: userOrg.verification_status === 'verified',
      } : null,
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
        shipper.id as shipper_user_id,
        o.name as shipper_org_name,
        o.org_type as shipper_org_type
       FROM loads l
       JOIN users shipper ON l.shipper_id = shipper.id
       LEFT JOIN orgs o ON l.posted_by_org_id = o.id
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
          companyName: load.shipper_company || load.shipper_org_name,
          orgName: load.shipper_org_name,
          orgType: load.shipper_org_type,
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
 * DEPRECATED: Use GET /loads with org context instead
 * Kept for backward compatibility
 */
router.get('/company', authenticate, async (req, res) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;

    // Get user's org
    const userOrg = await getUserPrimaryOrg(req.user.id);
    
    // Also check legacy company_id
    const userResult = await pool.query(
      'SELECT company_id FROM users WHERE id = $1',
      [req.user.id]
    );
    const companyId = userResult.rows[0]?.company_id;

    let query;
    let params;

    if (userOrg?.org_id) {
      // New org model - get all loads from org
      query = `
        SELECT l.*, 
          CONCAT(shipper.first_name, ' ', shipper.last_name) as shipper_name,
          shipper.email as shipper_email,
          shipper.department as shipper_department,
          CONCAT(driver.first_name, ' ', driver.last_name) as driver_name,
          driver.phone as driver_phone,
          CONCAT(poster.first_name, ' ', poster.last_name) as posted_by_name
        FROM loads l
        JOIN users shipper ON l.shipper_id = shipper.id
        LEFT JOIN users driver ON l.driver_id = driver.id
        LEFT JOIN users poster ON l.posted_by_user_id = poster.id
        WHERE l.posted_by_org_id = $1
        ${status ? 'AND l.status = $2' : ''}
        ORDER BY l.created_at DESC
        LIMIT $${status ? 3 : 2} OFFSET $${status ? 4 : 3}`;
      params = status
        ? [userOrg.org_id, status, limit, offset]
        : [userOrg.org_id, limit, offset];
    } else if (companyId) {
      // Legacy company model
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

    if (userOrg?.org_id) {
      statsQuery = `
        SELECT 
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE l.status NOT IN ('delivered', 'cancelled', 'completed')) as active,
          COUNT(*) FILTER (WHERE l.status IN ('delivered', 'completed')) as completed,
          COALESCE(SUM(l.price) FILTER (WHERE l.status IN ('delivered', 'completed')), 0) as total_spent
        FROM loads l
        WHERE l.posted_by_org_id = $1`;
      statsParams = [userOrg.org_id];
    } else if (companyId) {
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
        postedByName: load.posted_by_name,
      })),
      count: result.rows.length,
      stats: {
        total: parseInt(stats.total) || 0,
        active: parseInt(stats.active) || 0,
        completed: parseInt(stats.completed) || 0,
        totalSpent: parseFloat(stats.total_spent) || 0,
      },
      org: userOrg ? {
        id: userOrg.org_id,
        name: userOrg.org_name,
        type: userOrg.org_type,
      } : null,
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
        driver.location_updated_at as driver_location_updated_at,
        poster_org.name as poster_org_name,
        poster_org.org_type as poster_org_type,
        poster_org.verification_status as poster_verification
       FROM loads l
       JOIN users shipper ON l.shipper_id = shipper.id
       LEFT JOIN users driver ON l.driver_id = driver.id
       LEFT JOIN orgs poster_org ON l.posted_by_org_id = poster_org.id
       WHERE l.id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Load not found' });
    }

    const load = result.rows[0];

    // Check authorization - also check org membership
    const userOrg = await getUserPrimaryOrg(req.user.id);
    const isShipper = load.shipper_id === req.user.id;
    const isDriver = load.driver_id === req.user.id;
    const isOrgMember = userOrg?.org_id && load.posted_by_org_id === userOrg.org_id;
    const isAvailable = load.status === 'posted';

    if (!isShipper && !isDriver && !isOrgMember && !isAvailable) {
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
      posterOrg: load.posted_by_org_id ? {
        id: load.posted_by_org_id,
        name: load.poster_org_name,
        type: load.poster_org_type,
        verified: load.poster_verification === 'verified',
      } : null,
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

      // Get load and verify ownership (including org membership)
      const checkResult = await pool.query(
        'SELECT * FROM loads WHERE id = $1',
        [req.params.id]
      );

      if (checkResult.rows.length === 0) {
        return res.status(404).json({ error: 'Load not found' });
      }

      const load = checkResult.rows[0];

      // Check authorization - owner or org member with permission
      const userOrg = await getUserPrimaryOrg(req.user.id);
      const isOwner = load.shipper_id === req.user.id;
      const isOrgAdmin = userOrg?.org_id === load.posted_by_org_id && 
                         ['shipper_admin', 'broker_admin'].includes(userOrg.role);

      if (!isOwner && !isOrgAdmin) {
        return res.status(403).json({ error: 'Only the shipper or org admin can cancel this load' });
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

      const load = checkResult.rows[0];

      // Check if load requires verified carrier
      if (load.verified_only) {
        const userOrg = await getUserPrimaryOrg(req.user.id);
        if (!userOrg || userOrg.verification_status !== 'verified') {
          return res.status(403).json({ 
            error: 'This load requires a verified carrier',
            code: 'VERIFICATION_REQUIRED'
          });
        }
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
      const updatedLoad = result.rows[0];
      const driverResult = await pool.query('SELECT first_name, last_name FROM users WHERE id = $1', [req.user.id]);
      const driverName = driverResult.rows[0] ? `${driverResult.rows[0].first_name} ${driverResult.rows[0].last_name || ''}`.trim() : 'Driver';
      
      notificationService.notifyShipperDriverAccepted(updatedLoad.shipper_id, driverName, {
        loadId: updatedLoad.id,
        deliveryCity: updatedLoad.delivery_city,
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

      // Update driver location in users table (not driver_profiles)
      await pool.query(
        `UPDATE users 
         SET driver_lat = $1, driver_lng = $2, location_updated_at = CURRENT_TIMESTAMP
         WHERE id = $3`,
        [lat, lng, req.user.id]
      );

      res.json({ message: 'Location updated' });
    } catch (error) {
      console.error('[Loads] Location update error:', error);
      res.status(500).json({ error: 'Failed to update location' });
    }
  }
);

/**
 * POST /loads/:id/rate
 * Rate a driver (shipper only)
 */
router.post('/:id/rate',
  authenticate,
  async (req, res) => {
    try {
      const { rating, comment, ratingType } = req.body;
      const loadId = req.params.id;
      const shipperId = req.user.id;

      // Validate rating
      if (!rating || rating < 1 || rating > 5) {
        return res.status(400).json({ error: 'Rating must be between 1 and 5' });
      }

      // Verify load exists and belongs to shipper (or shipper's org)
      const userOrg = await getUserPrimaryOrg(req.user.id);
      
      let loadCheck;
      if (userOrg?.org_id) {
        loadCheck = await pool.query(
          `SELECT * FROM loads 
           WHERE id = $1 
           AND (shipper_id = $2 OR posted_by_org_id = $3)
           AND status IN ('delivered', 'completed')`,
          [loadId, shipperId, userOrg.org_id]
        );
      } else {
        loadCheck = await pool.query(
          `SELECT * FROM loads WHERE id = $1 AND shipper_id = $2 AND status IN ('delivered', 'completed')`,
          [loadId, shipperId]
        );
      }

      if (loadCheck.rows.length === 0) {
        return res.status(404).json({ error: 'Load not found or not eligible for rating' });
      }

      const load = loadCheck.rows[0];
      
      if (!load.driver_id) {
        return res.status(400).json({ error: 'No driver assigned to this load' });
      }

      // Check if already rated
      if (load.driver_rated) {
        return res.status(409).json({ error: 'Driver already rated for this load' });
      }

      // Update load with rating
      await pool.query(
        `UPDATE loads 
         SET driver_rated = true, 
             driver_rating = $1, 
             driver_review = $2,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $3`,
        [rating, comment || null, loadId]
      );

      // Update driver's average rating
      await pool.query(`
        UPDATE users
        SET
          rating = (
            SELECT COALESCE(ROUND(AVG(driver_rating)::numeric, 2), 5.00)
            FROM loads
            WHERE driver_id = $1 AND driver_rated = true
          ),
          rating_count = (
            SELECT COUNT(*)
            FROM loads
            WHERE driver_id = $1 AND driver_rated = true
          )
        WHERE id = $1
      `, [load.driver_id]);

      // Notify driver of rating
      notificationService.notifyDriverRating(load.driver_id, req.user.firstName || 'Shipper', rating >= 4, loadId)
        .catch(err => console.error('[Notifications] Rating error:', err));

      res.json({
        message: 'Rating submitted successfully',
        rating: rating,
      });
    } catch (error) {
      console.error('[Loads] Rate error:', error);
      res.status(500).json({ error: 'Failed to submit rating' });
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
    carrierPay: parseFloat(load.carrier_pay) || null,
    postedAt: load.posted_at,
    createdAt: load.created_at,
    shipperName: load.shipper_name,
    driverName: load.driver_name,
    driverPhone: load.driver_phone,
    shipperRated: load.shipper_rated || false,
    equipmentType: load.equipment_type || load.vehicle_type_required,
    vehicleTypeRequired: load.vehicle_type_required,
    // NEW: Org context
    postedByOrgId: load.posted_by_org_id,
    postedByUserId: load.posted_by_user_id,
    // NEW: Booking options
    allowOffers: load.allow_offers !== false,
    allowBookNow: load.allow_book_now !== false,
    minOffer: load.min_offer ? parseFloat(load.min_offer) : null,
    verifiedOnly: load.verified_only || false,
    trackingRequired: load.tracking_required !== false,
  };

  // Broker fields (only if present)
  if (load.customer_name) {
    response.customerName = load.customer_name;
    response.customerLoadNumber = load.customer_load_number;
    response.customerPo = load.customer_po;
    response.customerRate = load.customer_rate ? parseFloat(load.customer_rate) : null;
  }

  if (detailed) {
    Object.assign(response, {
      // Pickup details
      pickupAddress: load.pickup_address,
      pickupZip: load.pickup_zip,
      pickupLat: load.pickup_lat ? parseFloat(load.pickup_lat) : null,
      pickupLng: load.pickup_lng ? parseFloat(load.pickup_lng) : null,
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
      deliveryLat: load.delivery_lat ? parseFloat(load.delivery_lat) : null,
      deliveryLng: load.delivery_lng ? parseFloat(load.delivery_lng) : null,
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
