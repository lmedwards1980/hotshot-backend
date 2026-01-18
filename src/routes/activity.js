// Activity Routes - Shipper and Broker activity feeds
const express = require('express');
const { pool } = require('../db/pool');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

/**
 * GET /shipper/activity
 * Get activity feed for shipper (loads, offers, payments)
 */
router.get('/shipper/activity', authenticate, async (req, res) => {
  try {
    const { limit = 20, offset = 0 } = req.query;
    const userId = req.user.id;

    // Get recent loads activity
    const loadsResult = await pool.query(`
      SELECT
        l.id,
        l.status,
        l.pickup_city,
        l.pickup_state,
        l.delivery_city,
        l.delivery_state,
        l.price,
        l.created_at,
        l.updated_at,
        l.assigned_at,
        l.picked_up_at,
        l.delivered_at,
        u.first_name as driver_first_name,
        u.last_name as driver_last_name,
        'load' as activity_type
      FROM loads l
      LEFT JOIN users u ON l.driver_id = u.id
      WHERE l.shipper_id = $1
      ORDER BY GREATEST(l.updated_at, l.created_at) DESC
      LIMIT $2 OFFSET $3
    `, [userId, parseInt(limit), parseInt(offset)]);

    // Build activity items from loads
    const activities = [];

    for (const load of loadsResult.rows) {
      // Determine the most recent activity for this load
      let activityDescription = '';
      let activityTime = load.created_at;
      let activitySubtype = 'created';

      if (load.delivered_at) {
        activityDescription = `Load delivered to ${load.delivery_city}, ${load.delivery_state}`;
        activityTime = load.delivered_at;
        activitySubtype = 'delivered';
      } else if (load.picked_up_at) {
        activityDescription = `Load picked up from ${load.pickup_city}, ${load.pickup_state}`;
        activityTime = load.picked_up_at;
        activitySubtype = 'picked_up';
      } else if (load.assigned_at && load.driver_first_name) {
        activityDescription = `Load assigned to ${load.driver_first_name} ${load.driver_last_name || ''}`.trim();
        activityTime = load.assigned_at;
        activitySubtype = 'assigned';
      } else if (load.status === 'posted') {
        activityDescription = `Load posted: ${load.pickup_city}, ${load.pickup_state} → ${load.delivery_city}, ${load.delivery_state}`;
        activityTime = load.created_at;
        activitySubtype = 'posted';
      } else {
        activityDescription = `Load status: ${load.status}`;
        activityTime = load.updated_at;
        activitySubtype = load.status;
      }

      activities.push({
        id: `load-${load.id}-${activitySubtype}`,
        type: 'load',
        subtype: activitySubtype,
        loadId: load.id,
        description: activityDescription,
        route: `${load.pickup_city}, ${load.pickup_state} → ${load.delivery_city}, ${load.delivery_state}`,
        amount: parseFloat(load.price) || null,
        status: load.status,
        driverName: load.driver_first_name ? `${load.driver_first_name} ${load.driver_last_name || ''}`.trim() : null,
        timestamp: activityTime,
      });
    }

    // Get recent offers received
    const offersResult = await pool.query(`
      SELECT
        o.id,
        o.amount,
        o.status,
        o.created_at,
        o.updated_at,
        l.id as load_id,
        l.pickup_city,
        l.pickup_state,
        l.delivery_city,
        l.delivery_state,
        org.name as carrier_name,
        u.first_name as submitter_first_name,
        u.last_name as submitter_last_name
      FROM offers o
      JOIN loads l ON o.load_id = l.id
      LEFT JOIN orgs org ON o.carrier_org_id = org.id
      LEFT JOIN users u ON o.submitted_by_user_id = u.id
      WHERE l.shipper_id = $1
      ORDER BY o.updated_at DESC
      LIMIT $2
    `, [userId, parseInt(limit)]);

    for (const offer of offersResult.rows) {
      const driverName = offer.carrier_name ||
        (offer.submitter_first_name ? `${offer.submitter_first_name} ${offer.submitter_last_name || ''}`.trim() : 'A carrier');

      let description = '';
      if (offer.status === 'pending') {
        description = `${driverName} submitted an offer of $${offer.amount}`;
      } else if (offer.status === 'accepted') {
        description = `Offer from ${driverName} accepted`;
      } else if (offer.status === 'declined') {
        description = `Offer from ${driverName} declined`;
      } else if (offer.status === 'countered') {
        description = `Counter offer sent to ${driverName}`;
      } else {
        description = `Offer ${offer.status} from ${driverName}`;
      }

      activities.push({
        id: `offer-${offer.id}`,
        type: 'offer',
        subtype: offer.status,
        loadId: offer.load_id,
        offerId: offer.id,
        description,
        route: `${offer.pickup_city}, ${offer.pickup_state} → ${offer.delivery_city}, ${offer.delivery_state}`,
        amount: parseFloat(offer.amount),
        status: offer.status,
        driverName,
        timestamp: offer.updated_at || offer.created_at,
      });
    }

    // Sort all activities by timestamp descending
    activities.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    // Apply limit after combining
    const limitedActivities = activities.slice(0, parseInt(limit));

    res.json({
      activities: limitedActivities,
      pagination: {
        limit: parseInt(limit),
        offset: parseInt(offset),
        hasMore: activities.length > parseInt(limit),
      },
    });
  } catch (error) {
    console.error('[Activity] Shipper activity error:', error);
    res.status(500).json({ error: 'Failed to fetch activity' });
  }
});

/**
 * GET /shipper/offers
 * Get offers received on shipper's loads
 */
router.get('/shipper/offers', authenticate, async (req, res) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;
    const userId = req.user.id;

    // Get user's org membership
    const orgResult = await pool.query(`
      SELECT org_id FROM memberships WHERE user_id = $1 AND is_primary = true
    `, [userId]);
    const userOrgId = orgResult.rows[0]?.org_id;

    let statusFilter = '';
    const params = [userId, userOrgId, parseInt(limit), parseInt(offset)];

    if (status && status !== 'all') {
      statusFilter = 'AND o.status = $5';
      params.push(status);
    }

    const result = await pool.query(`
      SELECT
        o.id,
        o.load_id,
        COALESCE(o.offered_amount, o.amount) as amount,
        o.status,
        o.created_at,
        o.updated_at,
        l.price as original_price,
        l.pickup_city,
        l.pickup_state,
        l.delivery_city,
        l.delivery_state,
        carrier_org.name as carrier_name,
        CONCAT(submitter.first_name, ' ', submitter.last_name) as submitter_name
      FROM offers o
      JOIN loads l ON o.load_id = l.id
      LEFT JOIN orgs carrier_org ON o.carrier_org_id = carrier_org.id
      LEFT JOIN users submitter ON o.submitted_by_user_id = submitter.id
      WHERE (l.shipper_id = $1 OR l.posted_by_org_id = $2)
      ${statusFilter}
      ORDER BY o.created_at DESC
      LIMIT $3 OFFSET $4
    `, params);

    res.json({
      offers: result.rows.map(o => ({
        id: o.id,
        loadId: o.load_id,
        carrierName: o.carrier_name || o.submitter_name || 'Unknown Carrier',
        amount: parseFloat(o.amount),
        originalPrice: parseFloat(o.original_price),
        status: o.status,
        submittedAt: o.created_at,
        updatedAt: o.updated_at,
        loadRoute: {
          pickupCity: o.pickup_city,
          pickupState: o.pickup_state,
          deliveryCity: o.delivery_city,
          deliveryState: o.delivery_state,
        },
      })),
    });
  } catch (error) {
    console.error('[Activity] Shipper offers error:', error);
    res.status(500).json({ error: 'Failed to fetch offers' });
  }
});

/**
 * GET /broker/activity
 * Get activity feed for broker (loads, carriers, shippers)
 */
router.get('/broker/activity', authenticate, async (req, res) => {
  try {
    const { limit = 20, offset = 0 } = req.query;
    const userId = req.user.id;

    const activities = [];

    // Get user's org membership
    const orgResult = await pool.query(`
      SELECT org_id FROM memberships WHERE user_id = $1 AND is_primary = true
    `, [userId]);
    const userOrgId = orgResult.rows[0]?.org_id;

    // Get broker's loads activity (loads they posted or are associated with)
    const loadsResult = await pool.query(`
      SELECT
        l.id,
        l.status,
        l.pickup_city,
        l.pickup_state,
        l.delivery_city,
        l.delivery_state,
        l.price,
        l.driver_payout,
        l.created_at,
        l.updated_at,
        l.assigned_at,
        l.picked_up_at,
        l.delivered_at,
        driver.first_name as driver_first_name,
        driver.last_name as driver_last_name,
        carrier_org.name as carrier_name,
        shipper.company_name as shipper_company,
        shipper.first_name as shipper_first_name
      FROM loads l
      LEFT JOIN users driver ON l.driver_id = driver.id
      LEFT JOIN users shipper ON l.shipper_id = shipper.id
      LEFT JOIN memberships dm ON driver.id = dm.user_id AND dm.is_primary = true
      LEFT JOIN orgs carrier_org ON dm.org_id = carrier_org.id
      WHERE l.shipper_id = $1 OR l.posted_by_org_id = $2
      ORDER BY GREATEST(l.updated_at, l.created_at) DESC
      LIMIT $3 OFFSET $4
    `, [userId, userOrgId, parseInt(limit), parseInt(offset)]);

    for (const load of loadsResult.rows) {
      let description = '';
      let activityTime = load.updated_at;
      let subtype = load.status;

      if (load.delivered_at) {
        description = `Load delivered: ${load.pickup_city} → ${load.delivery_city}`;
        activityTime = load.delivered_at;
        subtype = 'delivered';
      } else if (load.picked_up_at) {
        description = `Load picked up from ${load.pickup_city}`;
        activityTime = load.picked_up_at;
        subtype = 'picked_up';
      } else if (load.assigned_at && load.driver_first_name) {
        const carrierName = load.carrier_name || `${load.driver_first_name} ${load.driver_last_name || ''}`.trim();
        description = `Load assigned to ${carrierName}`;
        activityTime = load.assigned_at;
        subtype = 'assigned';
      } else if (load.status === 'posted') {
        description = `New load posted: ${load.pickup_city} → ${load.delivery_city}`;
        activityTime = load.created_at;
        subtype = 'posted';
      } else {
        description = `Load ${load.status}: ${load.pickup_city} → ${load.delivery_city}`;
      }

      const shipperName = load.shipper_company || load.shipper_first_name || 'Shipper';

      activities.push({
        id: `load-${load.id}-${subtype}`,
        type: 'load',
        subtype,
        loadId: load.id,
        description,
        route: `${load.pickup_city}, ${load.pickup_state} → ${load.delivery_city}, ${load.delivery_state}`,
        amount: parseFloat(load.price) || null,
        margin: load.driver_payout ? parseFloat(load.price) - parseFloat(load.driver_payout) : null,
        status: load.status,
        shipperName,
        carrierName: load.carrier_name || (load.driver_first_name ? `${load.driver_first_name} ${load.driver_last_name || ''}`.trim() : null),
        timestamp: activityTime,
      });
    }

    // Get carrier network activity (new carriers, status changes)
    let carrierResult = { rows: [] };
    if (userOrgId) {
      carrierResult = await pool.query(`
        SELECT
          bc.id,
          bc.status,
          bc.created_at,
          bc.updated_at,
          o.name as carrier_name,
          o.mc_number
        FROM broker_carriers bc
        JOIN orgs o ON bc.carrier_org_id = o.id
        WHERE bc.broker_org_id = $1
        ORDER BY bc.updated_at DESC
        LIMIT 10
      `, [userOrgId]);
    }

    for (const carrier of carrierResult.rows) {
      let description = '';
      if (carrier.status === 'active') {
        description = `${carrier.carrier_name} joined your carrier network`;
      } else if (carrier.status === 'pending') {
        description = `Invitation sent to ${carrier.carrier_name}`;
      } else if (carrier.status === 'blocked') {
        description = `${carrier.carrier_name} was blocked`;
      } else {
        description = `Carrier ${carrier.carrier_name} - ${carrier.status}`;
      }

      activities.push({
        id: `carrier-${carrier.id}`,
        type: 'carrier',
        subtype: carrier.status,
        description,
        carrierName: carrier.carrier_name,
        mcNumber: carrier.mc_number,
        status: carrier.status,
        timestamp: carrier.updated_at || carrier.created_at,
      });
    }

    // Get shipper connection activity
    let shipperResult = { rows: [] };
    if (userOrgId) {
      shipperResult = await pool.query(`
        SELECT
          bs.id,
          bs.status,
          bs.created_at,
          bs.updated_at,
          o.name as shipper_name
        FROM broker_shippers bs
        JOIN orgs o ON bs.shipper_org_id = o.id
        WHERE bs.broker_org_id = $1
        ORDER BY bs.updated_at DESC
        LIMIT 10
      `, [userOrgId]);
    }

    for (const shipper of shipperResult.rows) {
      const shipperName = shipper.shipper_name || 'Shipper';

      let description = '';
      if (shipper.status === 'connected') {
        description = `Connected with shipper ${shipperName}`;
      } else if (shipper.status === 'pending') {
        description = `Connection request sent to ${shipperName}`;
      } else {
        description = `Shipper ${shipperName} - ${shipper.status}`;
      }

      activities.push({
        id: `shipper-${shipper.id}`,
        type: 'shipper_connection',
        subtype: shipper.status,
        description,
        shipperName,
        status: shipper.status,
        timestamp: shipper.updated_at || shipper.created_at,
      });
    }

    // Sort all activities by timestamp descending
    activities.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    // Apply limit
    const limitedActivities = activities.slice(0, parseInt(limit));

    res.json({
      activities: limitedActivities,
      pagination: {
        limit: parseInt(limit),
        offset: parseInt(offset),
        hasMore: activities.length > parseInt(limit),
      },
    });
  } catch (error) {
    console.error('[Activity] Broker activity error:', error);
    res.status(500).json({ error: 'Failed to fetch activity' });
  }
});

module.exports = router;
