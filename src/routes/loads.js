// Load Routes - Updated with Org Context for 5-Role Model
// + Visibility & Tendering for Brokers
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
 * Helper: Check if carrier is in broker's network
 */
const isCarrierInBrokerNetwork = async (brokerOrgId, carrierOrgId) => {
  if (!brokerOrgId || !carrierOrgId) return false;
  
  const result = await pool.query(`
    SELECT id FROM broker_carriers 
    WHERE broker_org_id = $1 
      AND carrier_org_id = $2 
      AND status = 'active'
      AND blocked_at IS NULL
  `, [brokerOrgId, carrierOrgId]);
  
  return result.rows.length > 0;
};

/**
 * Helper: Get all carrier org IDs in a broker's network
 */
const getBrokerCarrierOrgIds = async (brokerOrgId) => {
  if (!brokerOrgId) return [];
  
  const result = await pool.query(`
    SELECT carrier_org_id FROM broker_carriers 
    WHERE broker_org_id = $1 
      AND status = 'active'
      AND blocked_at IS NULL
  `, [brokerOrgId]);
  
  return result.rows.map(r => r.carrier_org_id);
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
 * Updated with org context, broker fields, and VISIBILITY & TENDERING
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
        // Broker fields
        customerName,        // Broker's customer name
        customerLoadNumber,  // Customer's load reference
        customerPo,          // Customer PO number
        customerRate,        // What broker charges customer
        carrierPay,          // What broker pays carrier (their margin)
        // Booking options
        allowOffers,         // Allow carriers to submit offers
        allowBookNow,        // Allow instant booking at posted rate
        minOffer,            // Minimum acceptable offer
        verifiedOnly,        // Only verified carriers can book
        trackingRequired,    // Require tracking
        // NEW: Visibility & Tendering
        visibility,          // 'public', 'preferred_first', 'private'
        preferredWindowMinutes,  // 15, 30, 60, 120, or null (manual release)
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

      // Handle visibility & tendering (broker feature)
      // For non-brokers, default to 'public'
      const finalVisibility = isBroker ? (visibility || 'public') : 'public';
      const finalWindowMinutes = (isBroker && finalVisibility !== 'public') 
        ? (preferredWindowMinutes || null) 
        : null;
      
      // Calculate release_to_public_at if preferred_first with a window
      let releaseToPublicAt = null;
      if (finalVisibility === 'preferred_first' && finalWindowMinutes) {
        // Will be set via SQL: CURRENT_TIMESTAMP + interval
        releaseToPublicAt = `INTERVAL '${finalWindowMinutes} minutes'`;
      }

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
          visibility, preferred_window_minutes, release_to_public_at,
          status, posted_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38, $39, $40, $41, $42, $43, $44, $45, $46, $47, $48, $49, $50, $51, $52, $53, $54,
          $55, $56, ${finalWindowMinutes ? `CURRENT_TIMESTAMP + INTERVAL '${finalWindowMinutes} minutes'` : 'NULL'},
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
          finalVisibility,
          finalWindowMinutes,
        ]
      );

      const load = result.rows[0];

      // Notify preferred carriers if visibility is not public
      if (isBroker && finalVisibility !== 'public' && userOrg?.org_id) {
        notifyPreferredCarriers(userOrg.org_id, load).catch(err => 
          console.error('[Loads] Failed to notify preferred carriers:', err)
        );
      }

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
 * Helper: Notify preferred carriers about new load
 */
async function notifyPreferredCarriers(brokerOrgId, load) {
  try {
    // Get all active carriers in broker's network
    const carriers = await pool.query(`
      SELECT bc.carrier_org_id, o.name as carrier_name
      FROM broker_carriers bc
      JOIN orgs o ON bc.carrier_org_id = o.id
      WHERE bc.broker_org_id = $1 
        AND bc.status = 'active'
        AND bc.blocked_at IS NULL
    `, [brokerOrgId]);

    // Get all users in those carrier orgs who should be notified
    for (const carrier of carriers.rows) {
      const users = await pool.query(`
        SELECT u.id, u.first_name
        FROM users u
        JOIN memberships m ON u.id = m.user_id
        WHERE m.org_id = $1 
          AND m.is_active = true
          AND m.role IN ('carrier_admin', 'dispatcher')
      `, [carrier.carrier_org_id]);

      for (const user of users.rows) {
        await notificationService.sendPushNotification(
          user.id,
          'New Load from Preferred Broker',
          `${load.pickup_city}, ${load.pickup_state} → ${load.delivery_city}, ${load.delivery_state} • $${load.carrier_pay || load.price}`,
          { loadId: load.id, type: 'preferred_load' }
        ).catch(err => console.error('[Notify] Push failed:', err));
      }
    }
  } catch (error) {
    console.error('[Loads] Notify preferred carriers error:', error);
  }
}

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
 * NOW WITH VISIBILITY FILTERING
 */
router.get('/available', authenticate, async (req, res) => {
  try {
    const { limit = 20, offset = 0 } = req.query;

    // Get user's org to check if they're in any broker's network
    const userOrg = await getUserPrimaryOrg(req.user.id);
    const carrierOrgId = userOrg?.org_type === 'carrier' ? userOrg.org_id : null;

    // Build visibility filter
    // A carrier can see a load if:
    // 1. visibility = 'public', OR
    // 2. visibility = 'preferred_first' AND (release_to_public_at has passed OR carrier is in broker's network), OR
    // 3. visibility = 'private' AND carrier is in broker's network
    
    let visibilityFilter;
    if (carrierOrgId) {
      visibilityFilter = `
        AND (
          l.visibility = 'public'
          OR l.visibility IS NULL
          OR (l.visibility = 'preferred_first' AND (
            l.release_to_public_at IS NULL 
            OR l.release_to_public_at <= CURRENT_TIMESTAMP
            OR l.released_early_at IS NOT NULL
            OR EXISTS (
              SELECT 1 FROM broker_carriers bc 
              WHERE bc.broker_org_id = l.posted_by_org_id 
                AND bc.carrier_org_id = $3
                AND bc.status = 'active'
                AND bc.blocked_at IS NULL
            )
          ))
          OR (l.visibility = 'private' AND EXISTS (
            SELECT 1 FROM broker_carriers bc 
            WHERE bc.broker_org_id = l.posted_by_org_id 
              AND bc.carrier_org_id = $3
              AND bc.status = 'active'
              AND bc.blocked_at IS NULL
          ))
        )
      `;
    } else {
      // No carrier org - can only see public loads or released loads
      visibilityFilter = `
        AND (
          l.visibility = 'public'
          OR l.visibility IS NULL
          OR (l.visibility = 'preferred_first' AND (
            l.release_to_public_at IS NULL 
            OR l.release_to_public_at <= CURRENT_TIMESTAMP
            OR l.released_early_at IS NOT NULL
          ))
        )
      `;
    }

    const query = `
      SELECT l.*, 
        CONCAT(u.first_name, ' ', u.last_name) as shipper_name,
        o.name as shipper_org_name,
        o.org_type as shipper_org_type,
        o.verification_status as shipper_verification,
        shipper_user.shipper_score,
        shipper_user.shipper_loads_completed,
        shipper_user.shipper_on_time_rate,
        shipper_user.shipper_disputes,
        ${carrierOrgId ? `
        CASE WHEN EXISTS (
          SELECT 1 FROM broker_carriers bc 
          WHERE bc.broker_org_id = l.posted_by_org_id 
            AND bc.carrier_org_id = $3
            AND bc.status = 'active'
        ) THEN true ELSE false END as is_preferred_broker
        ` : 'false as is_preferred_broker'}
       FROM loads l
       JOIN users u ON l.shipper_id = u.id
       JOIN users shipper_user ON l.shipper_id = shipper_user.id
       LEFT JOIN orgs o ON l.posted_by_org_id = o.id
       WHERE l.status = 'posted'
       ${visibilityFilter}
       ORDER BY 
         ${carrierOrgId ? 'is_preferred_broker DESC,' : ''} 
         l.posted_at DESC
       LIMIT $1 OFFSET $2`;
    
    const params = carrierOrgId 
      ? [limit, offset, carrierOrgId]
      : [limit, offset];

    const result = await pool.query(query, params);

    // Track views by preferred carriers
    if (carrierOrgId && result.rows.length > 0) {
      const preferredLoadIds = result.rows
        .filter(l => l.is_preferred_broker && l.visibility !== 'public')
        .map(l => l.id);
      
      if (preferredLoadIds.length > 0) {
        // Increment views_by_preferred for these loads
        pool.query(`
          UPDATE loads 
          SET views_by_preferred = COALESCE(views_by_preferred, 0) + 1
          WHERE id = ANY($1)
        `, [preferredLoadIds]).catch(err => 
          console.error('[Loads] Failed to track preferred views:', err)
        );
      }
    }

    res.json({
      loads: result.rows.map(load => ({
        ...formatLoadResponse(load),
        shipperOrgName: load.shipper_org_name,
        shipperOrgType: load.shipper_org_type,
        shipperVerified: load.shipper_verification === 'verified',
        isPreferredBroker: load.is_preferred_broker || false,
        // Shipper integrity scores
        shipperScore: load.shipper_score ? parseFloat(load.shipper_score) : null,
        shipperLoadsCompleted: load.shipper_loads_completed || 0,
        shipperOnTimeRate: load.shipper_on_time_rate ? parseFloat(load.shipper_on_time_rate) : null,
        shipperDisputes: load.shipper_disputes || 0,
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
 * PUT /loads/:id/release
 * Broker manually releases a preferred/private load to public
 */
router.put('/:id/release',
  authenticate,
  async (req, res) => {
    try {
      const loadId = req.params.id;
      const userOrg = await getUserPrimaryOrg(req.user.id);

      // Verify ownership
      const loadCheck = await pool.query(`
        SELECT * FROM loads 
        WHERE id = $1 
          AND (posted_by_user_id = $2 OR posted_by_org_id = $3)
          AND status = 'posted'
      `, [loadId, req.user.id, userOrg?.org_id]);

      if (loadCheck.rows.length === 0) {
        return res.status(404).json({ error: 'Load not found or not eligible for release' });
      }

      const load = loadCheck.rows[0];

      if (load.visibility === 'public') {
        return res.status(400).json({ error: 'Load is already public' });
      }

      // Release to public
      const result = await pool.query(`
        UPDATE loads 
        SET released_early_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING *
      `, [loadId]);

      res.json({
        message: 'Load released to public',
        load: formatLoadResponse(result.rows[0]),
      });
    } catch (error) {
      console.error('[Loads] Release error:', error);
      res.status(500).json({ error: 'Failed to release load' });
    }
  }
);

/**
 * GET /loads/:id/tendering-status
 * Get tendering status for a load (broker view)
 */
router.get('/:id/tendering-status',
  authenticate,
  async (req, res) => {
    try {
      const loadId = req.params.id;
      const userOrg = await getUserPrimaryOrg(req.user.id);

      const result = await pool.query(`
        SELECT 
          l.id,
          l.visibility,
          l.preferred_window_minutes,
          l.release_to_public_at,
          l.released_early_at,
          l.views_by_preferred,
          l.posted_at,
          l.status,
          (SELECT COUNT(*) FROM offers WHERE load_id = l.id) as offer_count,
          (SELECT COUNT(*) FROM offers WHERE load_id = l.id AND status = 'pending') as pending_offer_count
        FROM loads l
        WHERE l.id = $1 
          AND (l.posted_by_user_id = $2 OR l.posted_by_org_id = $3)
      `, [loadId, req.user.id, userOrg?.org_id]);

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Load not found' });
      }

      const load = result.rows[0];
      const now = new Date();
      const releaseAt = load.release_to_public_at ? new Date(load.release_to_public_at) : null;
      
      let timeRemainingSeconds = null;
      let isReleased = false;

      if (load.visibility === 'public' || load.released_early_at) {
        isReleased = true;
      } else if (load.visibility === 'preferred_first' && releaseAt) {
        if (releaseAt <= now) {
          isReleased = true;
        } else {
          timeRemainingSeconds = Math.floor((releaseAt - now) / 1000);
        }
      }

      res.json({
        loadId: load.id,
        visibility: load.visibility,
        preferredWindowMinutes: load.preferred_window_minutes,
        releaseToPublicAt: load.release_to_public_at,
        releasedEarlyAt: load.released_early_at,
        isReleased,
        timeRemainingSeconds,
        viewsByPreferred: load.views_by_preferred || 0,
        offerCount: parseInt(load.offer_count) || 0,
        pendingOfferCount: parseInt(load.pending_offer_count) || 0,
        status: load.status,
      });
    } catch (error) {
      console.error('[Loads] Tendering status error:', error);
      res.status(500).json({ error: 'Failed to get tendering status' });
    }
  }
);

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
         AND l.status IN ('assigned', 'confirmed', 'en_route_pickup', 'at_pickup', 'picked_up', 'en_route_delivery', 'at_delivery')
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
      // Solo shipper - just their loads
      query = `
        SELECT l.*, 
          CONCAT(driver.first_name, ' ', driver.last_name) as driver_name,
          driver.phone as driver_phone
        FROM loads l
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

    // Count total
    let countQuery;
    let countParams;
    
    if (userOrg?.org_id) {
      countQuery = `SELECT COUNT(*) FROM loads WHERE posted_by_org_id = $1 ${status ? 'AND status = $2' : ''}`;
      countParams = status ? [userOrg.org_id, status] : [userOrg.org_id];
    } else if (companyId) {
      countQuery = `
        SELECT COUNT(*) FROM loads l 
        JOIN users shipper ON l.shipper_id = shipper.id 
        WHERE shipper.company_id = $1 ${status ? 'AND l.status = $2' : ''}`;
      countParams = status ? [companyId, status] : [companyId];
    } else {
      countQuery = `SELECT COUNT(*) FROM loads WHERE shipper_id = $1 ${status ? 'AND status = $2' : ''}`;
      countParams = status ? [req.user.id, status] : [req.user.id];
    }

    const countResult = await pool.query(countQuery, countParams);
    const total = parseInt(countResult.rows[0].count);

    res.json({
      loads: result.rows.map(load => ({
        ...formatLoadResponse(load),
        shipperName: load.shipper_name,
        shipperEmail: load.shipper_email,
        shipperDepartment: load.shipper_department,
        postedByName: load.posted_by_name,
      })),
      count: result.rows.length,
      total,
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
 * Get single load details with driver location for tracking
 */
router.get('/:id', authenticate, async (req, res) => {
  try {
    const loadId = req.params.id;
    const userOrg = await getUserPrimaryOrg(req.user.id);

    const result = await pool.query(`
      SELECT 
        l.*,
        shipper.first_name as shipper_first_name,
        shipper.last_name as shipper_last_name,
        shipper.phone as shipper_phone,
        shipper.email as shipper_email,
        shipper.company_name as shipper_company,
        shipper_org.name as shipper_org_name,
        shipper_org.org_type as shipper_org_type,
        driver.first_name as driver_first_name,
        driver.last_name as driver_last_name,
        driver.phone as driver_phone,
        driver.vehicle_type as driver_vehicle_type,
        driver.license_plate as driver_license_plate,
        driver.driver_lat as driver_current_lat,
        driver.driver_lng as driver_current_lng,
        driver.location_updated_at as driver_last_location_update,
        driver.rating as driver_rating,
        driver.rating_count as driver_rating_count,
        carrier_org.name as carrier_org_name,
        carrier_org.mc_number as carrier_mc,
        (SELECT COUNT(*) FROM offers WHERE load_id = l.id) as offer_count,
        (SELECT COUNT(*) FROM offers WHERE load_id = l.id AND status = 'pending') as pending_offer_count
      FROM loads l
      LEFT JOIN users shipper ON l.shipper_id = shipper.id
      LEFT JOIN orgs shipper_org ON l.posted_by_org_id = shipper_org.id
      LEFT JOIN users driver ON l.driver_id = driver.id
      LEFT JOIN memberships driver_membership ON driver.id = driver_membership.user_id AND driver_membership.is_primary = true
      LEFT JOIN orgs carrier_org ON driver_membership.org_id = carrier_org.id
      WHERE l.id = $1
    `, [loadId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Load not found' });
    }

    const load = result.rows[0];

    // Check access permissions
    const isShipperOwner = load.shipper_id === req.user.id || load.posted_by_org_id === userOrg?.org_id;
    const isDriverOwner = load.driver_id === req.user.id;
    const isCarrierMember = userOrg?.org_type === 'carrier' && load.assigned_carrier_org_id === userOrg.org_id;

    // Format response based on role
    const response = {
      load: {
        ...formatLoadResponse(load, true),
        offerCount: parseInt(load.offer_count) || 0,
        pendingOfferCount: parseInt(load.pending_offer_count) || 0,
        shipper: {
          id: load.shipper_id,
          name: `${load.shipper_first_name || ''} ${load.shipper_last_name || ''}`.trim(),
          phone: load.shipper_phone,
          email: isShipperOwner ? load.shipper_email : undefined,
          companyName: load.shipper_company || load.shipper_org_name,
          orgName: load.shipper_org_name,
          orgType: load.shipper_org_type,
        },
      },
    };

    // Include driver info if assigned
    if (load.driver_id) {
      response.load.driver = {
        id: load.driver_id,
        name: `${load.driver_first_name || ''} ${load.driver_last_name || ''}`.trim(),
        phone: load.driver_phone,
        vehicleType: load.driver_vehicle_type,
        licensePlate: load.driver_license_plate,
        rating: load.driver_rating ? parseFloat(load.driver_rating) : null,
        ratingCount: load.driver_rating_count || 0,
        carrierName: load.carrier_org_name,
        carrierMc: load.carrier_mc,
      };

      // Include live location for tracking (shipper/broker viewing their load)
      if (isShipperOwner && load.driver_current_lat && load.driver_current_lng) {
        response.load.driver.currentLat = parseFloat(load.driver_current_lat);
        response.load.driver.currentLng = parseFloat(load.driver_current_lng);
        response.load.driver.lastLocationUpdate = load.driver_last_location_update;
      }
    }

    // Include visibility info for owner
    if (isShipperOwner) {
      response.load.visibility = load.visibility;
      response.load.preferredWindowMinutes = load.preferred_window_minutes;
      response.load.releaseToPublicAt = load.release_to_public_at;
      response.load.releasedEarlyAt = load.released_early_at;
      response.load.viewsByPreferred = load.views_by_preferred;
    }

    res.json(response);
  } catch (error) {
    console.error('[Loads] Get single error:', error);
    res.status(500).json({ error: 'Failed to get load' });
  }
});

/**
 * PUT /loads/:id/status
 * Update load status
 */
router.put('/:id/status',
  authenticate,
  async (req, res) => {
    try {
      const { status: newStatus } = req.body;
      const loadId = req.params.id;

      const validStatuses = [
        'posted', 'assigned', 'accepted', 'confirmed',
        'en_route_pickup', 'at_pickup', 'picked_up',
        'en_route_delivery', 'at_delivery', 'delivered',
        'completed', 'cancelled'
      ];

      if (!validStatuses.includes(newStatus)) {
        return res.status(400).json({ 
          error: 'Invalid status',
          validStatuses 
        });
      }

      // Get user's org
      const userOrg = await getUserPrimaryOrg(req.user.id);

      // Verify ownership/access
      const loadCheck = await pool.query(`
        SELECT l.*, 
          a.driver_user_id as assigned_driver_id,
          a.carrier_org_id as assigned_carrier_id
        FROM loads l
        LEFT JOIN assignments a ON l.id = a.load_id AND a.status != 'cancelled'
        WHERE l.id = $1
      `, [loadId]);

      if (loadCheck.rows.length === 0) {
        return res.status(404).json({ error: 'Load not found' });
      }

      const load = loadCheck.rows[0];

      // Check permissions based on role
      const isShipperOwner = load.shipper_id === req.user.id || load.posted_by_org_id === userOrg?.org_id;
      const isDriverOwner = load.driver_id === req.user.id || load.assigned_driver_id === req.user.id;
      const isCarrierMember = userOrg?.org_type === 'carrier' && load.assigned_carrier_id === userOrg.org_id;

      // Determine what status updates each role can make
      const driverStatuses = ['en_route_pickup', 'at_pickup', 'picked_up', 'en_route_delivery', 'at_delivery', 'delivered'];
      const shipperStatuses = ['completed', 'cancelled'];

      if (driverStatuses.includes(newStatus) && !isDriverOwner && !isCarrierMember) {
        return res.status(403).json({ error: 'Only the assigned driver can update to this status' });
      }

      if (shipperStatuses.includes(newStatus) && !isShipperOwner) {
        return res.status(403).json({ error: 'Only the shipper can update to this status' });
      }

      // Update timestamps based on status
      let timestampField = null;
      switch (newStatus) {
        case 'assigned': timestampField = 'assigned_at'; break;
        case 'picked_up': timestampField = 'picked_up_at'; break;
        case 'delivered': timestampField = 'delivered_at'; break;
        case 'completed': timestampField = 'completed_at'; break;
        case 'cancelled': timestampField = 'cancelled_at'; break;
      }

      const updateQuery = timestampField
        ? `UPDATE loads SET status = $1, ${timestampField} = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *`
        : `UPDATE loads SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *`;

      const result = await pool.query(updateQuery, [newStatus, loadId]);

      // Also update assignment status if exists
      if (load.assigned_driver_id) {
        const assignmentStatus = newStatus === 'delivered' ? 'completed' : 
                                 newStatus === 'cancelled' ? 'cancelled' : 
                                 ['en_route_pickup', 'at_pickup', 'picked_up', 'en_route_delivery', 'at_delivery'].includes(newStatus) ? 'in_progress' : 
                                 'pending';
        
        await pool.query(`
          UPDATE assignments 
          SET status = $1, 
              ${newStatus === 'delivered' ? 'completed_at = CURRENT_TIMESTAMP,' : ''}
              ${['en_route_pickup'].includes(newStatus) ? 'started_at = CURRENT_TIMESTAMP,' : ''}
              updated_at = CURRENT_TIMESTAMP
          WHERE load_id = $2 AND status != 'cancelled'
        `.replace(/,\s*updated_at/, ' updated_at'), [assignmentStatus, loadId]);
      }

      // Send notifications
      if (newStatus === 'picked_up' && load.shipper_id) {
        notificationService.notifyLoadPickedUp(load.shipper_id, loadId)
          .catch(err => console.error('[Notifications] Pickup error:', err));
      }
      
      if (newStatus === 'delivered' && load.shipper_id) {
        notificationService.notifyLoadDelivered(load.shipper_id, loadId)
          .catch(err => console.error('[Notifications] Delivery error:', err));
      }

      res.json({
        message: `Status updated to ${newStatus}`,
        load: formatLoadResponse(result.rows[0]),
      });
    } catch (error) {
      console.error('[Loads] Status update error:', error);
      res.status(500).json({ error: 'Failed to update status' });
    }
  }
);

/**
 * POST /loads/:id/cancel
 * Cancel a load
 */
router.post('/:id/cancel',
  authenticate,
  async (req, res) => {
    try {
      const { reason } = req.body;
      const loadId = req.params.id;
      const userOrg = await getUserPrimaryOrg(req.user.id);

      // Verify ownership
      const loadCheck = await pool.query(`
        SELECT * FROM loads 
        WHERE id = $1 
          AND (shipper_id = $2 OR posted_by_org_id = $3)
          AND status NOT IN ('delivered', 'completed', 'cancelled')
      `, [loadId, req.user.id, userOrg?.org_id]);

      if (loadCheck.rows.length === 0) {
        return res.status(404).json({ error: 'Load not found or cannot be cancelled' });
      }

      const load = loadCheck.rows[0];

      // Update load status
      const result = await pool.query(`
        UPDATE loads 
        SET status = 'cancelled',
            cancelled_at = CURRENT_TIMESTAMP,
            cancelled_by = $1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
        RETURNING *
      `, [req.user.id, loadId]);

      // Cancel any pending assignments
      await pool.query(`
        UPDATE assignments 
        SET status = 'cancelled'
        WHERE load_id = $1 AND status NOT IN ('completed', 'cancelled')
      `, [loadId]);

      // Cancel any pending offers
      await pool.query(`
        UPDATE offers 
        SET status = 'cancelled'
        WHERE load_id = $1 AND status = 'pending'
      `, [loadId]);

      // Notify driver if assigned
      if (load.driver_id) {
        notificationService.notifyLoadCancelled(load.driver_id, loadId, reason)
          .catch(err => console.error('[Notifications] Cancel error:', err));
      }

      // Increment shipper cancellation count
      await pool.query(`
        UPDATE users 
        SET shipper_cancellations = COALESCE(shipper_cancellations, 0) + 1
        WHERE id = $1
      `, [load.shipper_id]);

      res.json({
        message: 'Load cancelled',
        load: formatLoadResponse(result.rows[0]),
      });
    } catch (error) {
      console.error('[Loads] Cancel error:', error);
      res.status(500).json({ error: 'Failed to cancel load' });
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
    // Org context
    postedByOrgId: load.posted_by_org_id,
    postedByUserId: load.posted_by_user_id,
    // Booking options
    allowOffers: load.allow_offers !== false,
    allowBookNow: load.allow_book_now !== false,
    minOffer: load.min_offer ? parseFloat(load.min_offer) : null,
    verifiedOnly: load.verified_only || false,
    trackingRequired: load.tracking_required !== false,
    // Visibility & Tendering
    visibility: load.visibility || 'public',
    preferredWindowMinutes: load.preferred_window_minutes,
    releaseToPublicAt: load.release_to_public_at,
    releasedEarlyAt: load.released_early_at,
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
