// Offers Routes - Carrier bidding system
const express = require('express');
const { pool } = require('../db/pool');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// Try to load notification service (optional)
let notificationService;
try {
  notificationService = require('../services/notificationService');
} catch (e) {
  console.log('[Offers] Notification service not available');
}

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
 * POST /offers
 * Submit an offer on a load (carrier/dispatcher only)
 */
router.post('/', authenticate, async (req, res) => {
  const client = await pool.connect();
  
  try {
    const {
      loadId,
      amount,
      notes,
      expiresInHours = 24, // Default 24 hour expiry
    } = req.body;

    // Validate
    if (!loadId || !amount) {
      return res.status(400).json({ error: 'loadId and amount are required' });
    }

    // Get user's org - must be a carrier or broker
    const userOrg = await getUserPrimaryOrg(req.user.id);
    
    if (!userOrg) {
      return res.status(403).json({ error: 'You must belong to an organization to submit offers' });
    }

    // Allow carriers and brokers to submit offers
    if (!['carrier', 'broker'].includes(userOrg.org_type)) {
      return res.status(403).json({ error: 'Only carriers and brokers can submit offers' });
    }

    // Check if user has permission based on org type
    const allowedRoles = userOrg.org_type === 'carrier' 
      ? ['carrier_admin', 'dispatcher', 'driver']
      : ['broker_admin', 'broker_agent'];
    
    if (!allowedRoles.includes(userOrg.role)) {
      return res.status(403).json({ error: 'You do not have permission to submit offers' });
    }

    // Get load and verify it's available for offers
    const loadResult = await pool.query(
      `SELECT l.*, o.name as poster_org_name, o.org_type as poster_org_type
       FROM loads l
       LEFT JOIN orgs o ON l.posted_by_org_id = o.id
       WHERE l.id = $1`,
      [loadId]
    );

    if (loadResult.rows.length === 0) {
      return res.status(404).json({ error: 'Load not found' });
    }

    const load = loadResult.rows[0];

    if (load.status !== 'posted') {
      return res.status(400).json({ error: 'Load is no longer available for offers' });
    }

    if (!load.allow_offers) {
      return res.status(400).json({ error: 'This load does not accept offers' });
    }

    // Check minimum offer if set
    if (load.min_offer && parseFloat(amount) < parseFloat(load.min_offer)) {
      return res.status(400).json({ 
        error: `Offer must be at least $${load.min_offer}`,
        minOffer: parseFloat(load.min_offer)
      });
    }

    // Check if load requires verified carrier
    if (load.verified_only && userOrg.verification_status !== 'verified') {
      return res.status(403).json({ 
        error: 'This load requires a verified carrier',
        code: 'VERIFICATION_REQUIRED'
      });
    }

    // Check if carrier already has a pending offer on this load
    const existingOffer = await pool.query(
      `SELECT id FROM offers 
       WHERE load_id = $1 AND carrier_org_id = $2 AND status IN ('pending', 'countered')`,
      [loadId, userOrg.org_id]
    );

    if (existingOffer.rows.length > 0) {
      return res.status(409).json({ 
        error: 'You already have an active offer on this load',
        existingOfferId: existingOffer.rows[0].id
      });
    }

    await client.query('BEGIN');

    // Calculate expiry
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + expiresInHours);

    // Create offer
    const result = await client.query(
      `INSERT INTO offers (
        load_id, carrier_org_id, submitted_by, submitted_by_user_id,
        offered_amount, amount, notes, expires_at, status
      ) VALUES ($1, $2, $3, $3, $4, $4, $5, $6, 'pending')
      RETURNING *`,
      [loadId, userOrg.org_id, req.user.id, amount, notes || null, expiresAt]
    );

    const offer = result.rows[0];

    await client.query('COMMIT');

    // Notify shipper/broker of new offer
    if (notificationService && load.shipper_id) {
      try {
        if (typeof notificationService.sendToUser === 'function') {
          notificationService.sendToUser(load.shipper_id, 'New Offer Received', 
            `${userOrg.org_name} offered $${amount} on your load to ${load.delivery_city}`,
            { type: 'offer_received', offerId: offer.id, loadId }
          );
        }
      } catch (err) {
        console.error('[Offers] Notification error:', err);
      }
    }

    res.status(201).json({
      message: 'Offer submitted successfully',
      offer: formatOfferResponse(offer, userOrg),
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[Offers] Create error:', error);
    res.status(500).json({ error: 'Failed to submit offer' });
  } finally {
    client.release();
  }
});

/**
 * GET /offers
 * List offers (filtered by user's role)
 * - Carriers see their submitted offers
 * - Shippers/Brokers see offers on their loads
 */
router.get('/', authenticate, async (req, res) => {
  try {
    const { status, loadId, limit = 20, offset = 0 } = req.query;
    const userOrg = await getUserPrimaryOrg(req.user.id);

    let query;
    let params;

    if (userOrg?.org_type === 'carrier') {
      // Carrier sees their offers
      query = `
        SELECT o.*, 
          l.description as load_description,
          l.pickup_city, l.pickup_state,
          l.delivery_city, l.delivery_state,
          l.price as load_price,
          l.status as load_status,
          poster_org.name as shipper_org_name,
          poster_org.org_type as shipper_org_type,
          CONCAT(submitter.first_name, ' ', submitter.last_name) as submitted_by_name
        FROM offers o
        JOIN loads l ON o.load_id = l.id
        LEFT JOIN orgs poster_org ON l.posted_by_org_id = poster_org.id
        LEFT JOIN users submitter ON o.submitted_by_user_id = submitter.id
        WHERE o.carrier_org_id = $1
        ${status ? 'AND o.status = $2' : ''}
        ${loadId ? `AND o.load_id = $${status ? 3 : 2}` : ''}
        ORDER BY o.created_at DESC
        LIMIT $${status && loadId ? 4 : status || loadId ? 3 : 2} 
        OFFSET $${status && loadId ? 5 : status || loadId ? 4 : 3}`;
      
      params = [userOrg.org_id];
      if (status) params.push(status);
      if (loadId) params.push(loadId);
      params.push(limit, offset);
    } else {
      // Shipper/Broker sees offers on their loads
      query = `
        SELECT o.*, 
          l.description as load_description,
          l.pickup_city, l.pickup_state,
          l.delivery_city, l.delivery_state,
          l.price as load_price,
          l.status as load_status,
          carrier_org.name as carrier_org_name,
          carrier_org.verification_status as carrier_verified,
          carrier_org.loads_completed as carrier_loads_completed,
          carrier_org.on_time_rate as carrier_on_time_rate,
          CONCAT(submitter.first_name, ' ', submitter.last_name) as submitted_by_name
        FROM offers o
        JOIN loads l ON o.load_id = l.id
        JOIN orgs carrier_org ON o.carrier_org_id = carrier_org.id
        LEFT JOIN users submitter ON o.submitted_by_user_id = submitter.id
        WHERE (l.shipper_id = $1 OR l.posted_by_org_id = $2)
        ${status ? 'AND o.status = $3' : ''}
        ${loadId ? `AND o.load_id = $${status ? 4 : 3}` : ''}
        ORDER BY o.created_at DESC
        LIMIT $${status && loadId ? 5 : status || loadId ? 4 : 3} 
        OFFSET $${status && loadId ? 6 : status || loadId ? 5 : 4}`;
      
      params = [req.user.id, userOrg?.org_id || null];
      if (status) params.push(status);
      if (loadId) params.push(loadId);
      params.push(limit, offset);
    }

    const result = await pool.query(query, params);

    res.json({
      offers: result.rows.map(o => formatOfferResponse(o)),
      count: result.rows.length,
    });
  } catch (error) {
    console.error('[Offers] List error:', error);
    res.status(500).json({ error: 'Failed to get offers' });
  }
});

/**
 * GET /offers/load/:loadId
 * Get all offers on a specific load (shipper/broker only)
 */
router.get('/load/:loadId', authenticate, async (req, res) => {
  try {
    const { loadId } = req.params;
    const userOrg = await getUserPrimaryOrg(req.user.id);

    // Verify user owns or is org member for this load
    const loadCheck = await pool.query(
      `SELECT * FROM loads WHERE id = $1 AND (shipper_id = $2 OR posted_by_org_id = $3)`,
      [loadId, req.user.id, userOrg?.org_id || null]
    );

    if (loadCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const result = await pool.query(
      `SELECT o.*, 
        carrier_org.name as carrier_org_name,
        carrier_org.verification_status as carrier_verified,
        carrier_org.loads_completed as carrier_loads_completed,
        carrier_org.on_time_rate as carrier_on_time_rate,
        carrier_org.claim_rate as carrier_claim_rate,
        CONCAT(submitter.first_name, ' ', submitter.last_name) as submitted_by_name,
        submitter.phone as submitter_phone
       FROM offers o
       JOIN orgs carrier_org ON o.carrier_org_id = carrier_org.id
       LEFT JOIN users submitter ON o.submitted_by_user_id = submitter.id
       WHERE o.load_id = $1
       ORDER BY 
         CASE WHEN o.status = 'pending' THEN 0 
              WHEN o.status = 'countered' THEN 1 
              ELSE 2 END,
         o.amount DESC`,
      [loadId]
    );

    res.json({
      offers: result.rows.map(o => formatOfferResponse(o)),
      count: result.rows.length,
    });
  } catch (error) {
    console.error('[Offers] Load offers error:', error);
    res.status(500).json({ error: 'Failed to get offers' });
  }
});

/**
 * GET /offers/:id
 * Get single offer details
 */
router.get('/:id', authenticate, async (req, res) => {
  try {
    const userOrg = await getUserPrimaryOrg(req.user.id);

    const result = await pool.query(
      `SELECT o.*, 
        l.description as load_description,
        l.pickup_city, l.pickup_state, l.pickup_address,
        l.delivery_city, l.delivery_state, l.delivery_address,
        l.price as load_price,
        l.distance_miles,
        l.status as load_status,
        l.shipper_id,
        l.posted_by_org_id,
        carrier_org.name as carrier_org_name,
        carrier_org.verification_status as carrier_verified,
        carrier_org.loads_completed as carrier_loads_completed,
        carrier_org.on_time_rate as carrier_on_time_rate,
        poster_org.name as shipper_org_name,
        CONCAT(submitter.first_name, ' ', submitter.last_name) as submitted_by_name,
        submitter.phone as submitter_phone
       FROM offers o
       JOIN loads l ON o.load_id = l.id
       JOIN orgs carrier_org ON o.carrier_org_id = carrier_org.id
       LEFT JOIN orgs poster_org ON l.posted_by_org_id = poster_org.id
       LEFT JOIN users submitter ON o.submitted_by_user_id = submitter.id
       WHERE o.id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Offer not found' });
    }

    const offer = result.rows[0];

    // Check authorization
    const isCarrier = userOrg?.org_id === offer.carrier_org_id;
    const isShipper = offer.shipper_id === req.user.id || 
                      (userOrg?.org_id && offer.posted_by_org_id === userOrg.org_id);

    if (!isCarrier && !isShipper) {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.json({
      offer: formatOfferResponse(offer),
      load: {
        id: offer.load_id,
        description: offer.load_description,
        pickupCity: offer.pickup_city,
        pickupState: offer.pickup_state,
        deliveryCity: offer.delivery_city,
        deliveryState: offer.delivery_state,
        price: parseFloat(offer.load_price),
        distanceMiles: parseFloat(offer.distance_miles),
        status: offer.load_status,
      },
    });
  } catch (error) {
    console.error('[Offers] Get error:', error);
    res.status(500).json({ error: 'Failed to get offer' });
  }
});

/**
 * PUT /offers/:id/accept
 * Accept an offer (shipper/broker only)
 * This assigns the carrier to the load
 */
router.put('/:id/accept', authenticate, async (req, res) => {
  const client = await pool.connect();
  
  try {
    const userOrg = await getUserPrimaryOrg(req.user.id);

    // Get offer with load details
    const offerResult = await pool.query(
      `SELECT o.*, l.shipper_id, l.posted_by_org_id, l.status as load_status,
              l.delivery_city, carrier_org.name as carrier_org_name
       FROM offers o
       JOIN loads l ON o.load_id = l.id
       JOIN orgs carrier_org ON o.carrier_org_id = carrier_org.id
       WHERE o.id = $1`,
      [req.params.id]
    );

    if (offerResult.rows.length === 0) {
      return res.status(404).json({ error: 'Offer not found' });
    }

    const offer = offerResult.rows[0];

    // Check authorization
    const isShipper = offer.shipper_id === req.user.id || 
                      (userOrg?.org_id && offer.posted_by_org_id === userOrg.org_id);

    if (!isShipper) {
      return res.status(403).json({ error: 'Only the load poster can accept offers' });
    }

    if (offer.status !== 'pending' && offer.status !== 'countered') {
      return res.status(400).json({ error: `Cannot accept offer with status: ${offer.status}` });
    }

    if (offer.load_status !== 'posted') {
      return res.status(400).json({ error: 'Load is no longer available' });
    }

    await client.query('BEGIN');

    // Accept the offer
    const acceptedAmount = offer.status === 'countered' && offer.counter_amount 
      ? offer.counter_amount 
      : offer.amount;

    await client.query(
      `UPDATE offers 
       SET status = 'accepted', 
           accepted_at = CURRENT_TIMESTAMP,
           accepted_by_user_id = $1,
           final_amount = $2
       WHERE id = $3`,
      [req.user.id, acceptedAmount, req.params.id]
    );

    // Decline all other pending offers on this load
    await client.query(
      `UPDATE offers 
       SET status = 'declined', 
           declined_at = CURRENT_TIMESTAMP,
           decline_reason = 'Another offer was accepted'
       WHERE load_id = $1 AND id != $2 AND status IN ('pending', 'countered')`,
      [offer.load_id, req.params.id]
    );

    // Update load - assign to carrier (not individual driver yet)
    // The carrier's dispatcher will assign a specific driver
    await client.query(
      `UPDATE loads 
       SET status = 'assigned',
           assigned_carrier_org_id = $1,
           carrier_pay = $2,
           assigned_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3`,
      [offer.carrier_org_id, acceptedAmount, offer.load_id]
    );

    await client.query('COMMIT');

    // Notify carrier
    if (notificationService && offer.submitted_by_user_id) {
      try {
        if (typeof notificationService.sendToUser === 'function') {
          notificationService.sendToUser(offer.submitted_by_user_id, 'Offer Accepted! 🎉',
            `Your offer of $${acceptedAmount} was accepted for the load to ${offer.delivery_city}`,
            { type: 'offer_accepted', offerId: req.params.id, loadId: offer.load_id }
          );
        }
      } catch (err) {
        console.error('[Offers] Notification error:', err);
      }
    }

    res.json({
      message: 'Offer accepted',
      offer: {
        id: req.params.id,
        status: 'accepted',
        finalAmount: parseFloat(acceptedAmount),
      },
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[Offers] Accept error:', error);
    res.status(500).json({ error: 'Failed to accept offer' });
  } finally {
    client.release();
  }
});

/**
 * PUT /offers/:id/decline
 * Decline an offer (shipper/broker only)
 */
router.put('/:id/decline', authenticate, async (req, res) => {
  try {
    const { reason } = req.body;
    const userOrg = await getUserPrimaryOrg(req.user.id);

    // Get offer
    const offerResult = await pool.query(
      `SELECT o.*, l.shipper_id, l.posted_by_org_id, l.delivery_city,
              carrier_org.name as carrier_org_name
       FROM offers o
       JOIN loads l ON o.load_id = l.id
       JOIN orgs carrier_org ON o.carrier_org_id = carrier_org.id
       WHERE o.id = $1`,
      [req.params.id]
    );

    if (offerResult.rows.length === 0) {
      return res.status(404).json({ error: 'Offer not found' });
    }

    const offer = offerResult.rows[0];

    // Check authorization
    const isShipper = offer.shipper_id === req.user.id || 
                      (userOrg?.org_id && offer.posted_by_org_id === userOrg.org_id);

    if (!isShipper) {
      return res.status(403).json({ error: 'Only the load poster can decline offers' });
    }

    if (!['pending', 'countered'].includes(offer.status)) {
      return res.status(400).json({ error: `Cannot decline offer with status: ${offer.status}` });
    }

    // Decline offer
    await pool.query(
      `UPDATE offers 
       SET status = 'declined', 
           declined_at = CURRENT_TIMESTAMP,
           decline_reason = $1
       WHERE id = $2`,
      [reason || null, req.params.id]
    );

    // Notify carrier
    if (notificationService && offer.submitted_by_user_id) {
      try {
        if (typeof notificationService.sendToUser === 'function') {
          notificationService.sendToUser(offer.submitted_by_user_id, 'Offer Declined',
            `Your offer for the load to ${offer.delivery_city} was declined${reason ? `: ${reason}` : ''}`,
            { type: 'offer_declined', offerId: req.params.id, loadId: offer.load_id }
          );
        }
      } catch (err) {
        console.error('[Offers] Notification error:', err);
      }
    }

    res.json({
      message: 'Offer declined',
      offer: { id: req.params.id, status: 'declined' },
    });
  } catch (error) {
    console.error('[Offers] Decline error:', error);
    res.status(500).json({ error: 'Failed to decline offer' });
  }
});

/**
 * PUT /offers/:id/counter
 * Counter an offer (shipper/broker only)
 */
router.put('/:id/counter', authenticate, async (req, res) => {
  try {
    const { amount, message } = req.body;
    const userOrg = await getUserPrimaryOrg(req.user.id);

    if (!amount) {
      return res.status(400).json({ error: 'Counter amount is required' });
    }

    // Get offer
    const offerResult = await pool.query(
      `SELECT o.*, l.shipper_id, l.posted_by_org_id, l.delivery_city,
              carrier_org.name as carrier_org_name
       FROM offers o
       JOIN loads l ON o.load_id = l.id
       JOIN orgs carrier_org ON o.carrier_org_id = carrier_org.id
       WHERE o.id = $1`,
      [req.params.id]
    );

    if (offerResult.rows.length === 0) {
      return res.status(404).json({ error: 'Offer not found' });
    }

    const offer = offerResult.rows[0];

    // Check authorization
    const isShipper = offer.shipper_id === req.user.id || 
                      (userOrg?.org_id && offer.posted_by_org_id === userOrg.org_id);

    if (!isShipper) {
      return res.status(403).json({ error: 'Only the load poster can counter offers' });
    }

    if (offer.status !== 'pending') {
      return res.status(400).json({ error: `Cannot counter offer with status: ${offer.status}` });
    }

    // Update offer with counter
    await pool.query(
      `UPDATE offers 
       SET status = 'countered', 
           counter_amount = $1,
           counter_message = $2,
           countered_at = CURRENT_TIMESTAMP,
           countered_by_user_id = $3
       WHERE id = $4`,
      [amount, message || null, req.user.id, req.params.id]
    );

    // Notify carrier
    if (notificationService && offer.submitted_by_user_id) {
      try {
        if (typeof notificationService.sendToUser === 'function') {
          notificationService.sendToUser(offer.submitted_by_user_id, 'Counter Offer Received',
            `Counter offer of $${amount} for the load to ${offer.delivery_city}`,
            { type: 'offer_countered', offerId: req.params.id, loadId: offer.load_id }
          );
        }
      } catch (err) {
        console.error('[Offers] Notification error:', err);
      }
    }

    res.json({
      message: 'Counter offer sent',
      offer: {
        id: req.params.id,
        status: 'countered',
        originalAmount: parseFloat(offer.amount),
        counterAmount: parseFloat(amount),
      },
    });
  } catch (error) {
    console.error('[Offers] Counter error:', error);
    res.status(500).json({ error: 'Failed to counter offer' });
  }
});

/**
 * PUT /offers/:id/accept-counter
 * Accept a counter offer (carrier only)
 */
router.put('/:id/accept-counter', authenticate, async (req, res) => {
  const client = await pool.connect();
  
  try {
    const userOrg = await getUserPrimaryOrg(req.user.id);

    if (!userOrg || !['carrier', 'broker'].includes(userOrg.org_type)) {
      return res.status(403).json({ error: 'Only carriers and brokers can accept counter offers' });
    }

    // Get offer
    const offerResult = await pool.query(
      `SELECT o.*, l.shipper_id, l.status as load_status, l.delivery_city
       FROM offers o
       JOIN loads l ON o.load_id = l.id
       WHERE o.id = $1 AND o.carrier_org_id = $2`,
      [req.params.id, userOrg.org_id]
    );

    if (offerResult.rows.length === 0) {
      return res.status(404).json({ error: 'Offer not found' });
    }

    const offer = offerResult.rows[0];

    if (offer.status !== 'countered') {
      return res.status(400).json({ error: 'This offer has not been countered' });
    }

    if (offer.load_status !== 'posted') {
      return res.status(400).json({ error: 'Load is no longer available' });
    }

    await client.query('BEGIN');

    const finalAmount = offer.counter_amount;

    // Accept the counter
    await client.query(
      `UPDATE offers 
       SET status = 'accepted', 
           accepted_at = CURRENT_TIMESTAMP,
           accepted_by_user_id = $1,
           final_amount = $2
       WHERE id = $3`,
      [req.user.id, finalAmount, req.params.id]
    );

    // Decline other pending offers
    await client.query(
      `UPDATE offers 
       SET status = 'declined', 
           declined_at = CURRENT_TIMESTAMP,
           decline_reason = 'Another offer was accepted'
       WHERE load_id = $1 AND id != $2 AND status IN ('pending', 'countered')`,
      [offer.load_id, req.params.id]
    );

    // Update load
    await client.query(
      `UPDATE loads 
       SET status = 'assigned',
           assigned_carrier_org_id = $1,
           carrier_pay = $2,
           assigned_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3`,
      [userOrg.org_id, finalAmount, offer.load_id]
    );

    await client.query('COMMIT');

    // Notify shipper
    if (notificationService && offer.shipper_id) {
      try {
        if (typeof notificationService.sendToUser === 'function') {
          notificationService.sendToUser(offer.shipper_id, 'Counter Accepted!',
            `Carrier accepted your counter of $${finalAmount} for the load to ${offer.delivery_city}`,
            { type: 'counter_accepted', offerId: req.params.id, loadId: offer.load_id }
          );
        }
      } catch (err) {
        console.error('[Offers] Notification error:', err);
      }
    }

    res.json({
      message: 'Counter offer accepted',
      offer: {
        id: req.params.id,
        status: 'accepted',
        finalAmount: parseFloat(finalAmount),
      },
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[Offers] Accept counter error:', error);
    res.status(500).json({ error: 'Failed to accept counter offer' });
  } finally {
    client.release();
  }
});

/**
 * PUT /offers/:id/withdraw
 * Withdraw an offer (carrier or broker)
 */
router.put('/:id/withdraw', authenticate, async (req, res) => {
  try {
    const userOrg = await getUserPrimaryOrg(req.user.id);

    if (!userOrg || !['carrier', 'broker'].includes(userOrg.org_type)) {
      return res.status(403).json({ error: 'Only carriers and brokers can withdraw offers' });
    }

    // Get and verify offer
    const offerResult = await pool.query(
      `SELECT * FROM offers WHERE id = $1 AND carrier_org_id = $2`,
      [req.params.id, userOrg.org_id]
    );

    if (offerResult.rows.length === 0) {
      return res.status(404).json({ error: 'Offer not found' });
    }

    const offer = offerResult.rows[0];

    if (!['pending', 'countered'].includes(offer.status)) {
      return res.status(400).json({ error: `Cannot withdraw offer with status: ${offer.status}` });
    }

    // Withdraw offer
    await pool.query(
      `UPDATE offers 
       SET status = 'withdrawn', 
           withdrawn_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [req.params.id]
    );

    res.json({
      message: 'Offer withdrawn',
      offer: { id: req.params.id, status: 'withdrawn' },
    });
  } catch (error) {
    console.error('[Offers] Withdraw error:', error);
    res.status(500).json({ error: 'Failed to withdraw offer' });
  }
});

/**
 * Helper: Format offer response
 */
function formatOfferResponse(offer, userOrg = null) {
  return {
    id: offer.id,
    loadId: offer.load_id,
    carrierOrgId: offer.carrier_org_id,
    carrierOrgName: offer.carrier_org_name,
    carrierVerified: offer.carrier_verified === 'verified',
    carrierLoadsCompleted: offer.carrier_loads_completed,
    carrierOnTimeRate: offer.carrier_on_time_rate ? parseFloat(offer.carrier_on_time_rate) : null,
    submittedByUserId: offer.submitted_by_user_id || offer.submitted_by,
    submittedByName: offer.submitted_by_name,
    submittedByPhone: offer.submitter_phone,
    amount: parseFloat(offer.amount || offer.offered_amount),
    counterAmount: offer.counter_amount ? parseFloat(offer.counter_amount) : null,
    counterMessage: offer.counter_message || offer.counter_notes,
    finalAmount: offer.final_amount ? parseFloat(offer.final_amount) : null,
    status: offer.status,
    notes: offer.notes,
    expiresAt: offer.expires_at,
    createdAt: offer.created_at,
    acceptedAt: offer.accepted_at || offer.resolved_at,
    declinedAt: offer.declined_at,
    declineReason: offer.decline_reason,
    // Load info if included
    loadDescription: offer.load_description,
    pickupCity: offer.pickup_city,
    pickupState: offer.pickup_state,
    deliveryCity: offer.delivery_city,
    deliveryState: offer.delivery_state,
    loadPrice: offer.load_price ? parseFloat(offer.load_price) : null,
    loadStatus: offer.load_status,
    // Shipper info if included
    shipperOrgName: offer.shipper_org_name,
    shipperOrgType: offer.shipper_org_type,
  };
}

module.exports = router;
