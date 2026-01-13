/**
 * Dispatcher Routes
 * Handles dispatcher mode: driver management, load assignment, earnings
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../db/pool');
const { authenticate, requireUserType } = require('../middleware/auth');
const crypto = require('crypto');

// ═══════════════════════════════════════════════════════════════════════════════
// MIDDLEWARE: Require dispatcher role
// ═══════════════════════════════════════════════════════════════════════════════

const requireDispatcher = async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT is_dispatcher FROM users WHERE id = $1',
      [req.user.id]
    );
    
    if (!result.rows[0]?.is_dispatcher) {
      return res.status(403).json({ error: 'Dispatcher access required' });
    }
    
    next();
  } catch (error) {
    res.status(500).json({ error: 'Authorization check failed' });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// DISPATCHER REGISTRATION & PROFILE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /dispatchers/register
 * Upgrade current driver account to dispatcher
 */
router.post('/register',
  authenticate,
  async (req, res) => {
    try {
      const { companyName, bio, defaultCommissionRate } = req.body;
      
      // Validate commission rate
      const commissionRate = parseFloat(defaultCommissionRate) || 10.0;
      if (commissionRate < 0 || commissionRate > 50) {
        return res.status(400).json({ error: 'Commission rate must be between 0% and 50%' });
      }
      
      // Update user to dispatcher
      const result = await pool.query(`
        UPDATE users
        SET 
          is_dispatcher = true,
          dispatcher_company_name = $1,
          dispatcher_bio = $2,
          default_commission_rate = $3,
          dispatcher_accepting_drivers = true,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $4
        RETURNING id, email, first_name, last_name, is_dispatcher, 
                  dispatcher_company_name, dispatcher_bio, default_commission_rate
      `, [companyName || null, bio || null, commissionRate, req.user.id]);
      
      res.json({
        message: 'Dispatcher registration successful',
        dispatcher: result.rows[0],
      });
    } catch (error) {
      console.error('[Dispatcher] Register error:', error);
      res.status(500).json({ error: 'Failed to register as dispatcher' });
    }
  }
);

/**
 * GET /dispatchers/profile
 * Get dispatcher's own profile
 */
router.get('/profile',
  authenticate,
  requireDispatcher,
  async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT 
          id, email, first_name, last_name, phone,
          is_dispatcher, dispatcher_company_name, dispatcher_bio, dispatcher_logo_url,
          default_commission_rate, dispatcher_accepting_drivers,
          dispatcher_rating, dispatcher_rating_count,
          dispatcher_total_loads, dispatcher_total_earnings,
          created_at
        FROM users
        WHERE id = $1
      `, [req.user.id]);
      
      // Get driver count
      const driverCount = await pool.query(`
        SELECT COUNT(*) FROM dispatcher_drivers
        WHERE dispatcher_id = $1 AND status = 'active'
      `, [req.user.id]);
      
      // Get pending requests count
      const requestCount = await pool.query(`
        SELECT COUNT(*) FROM dispatcher_requests
        WHERE dispatcher_id = $1 AND status = 'pending'
      `, [req.user.id]);
      
      res.json({
        profile: result.rows[0],
        driverCount: parseInt(driverCount.rows[0].count),
        pendingRequests: parseInt(requestCount.rows[0].count),
      });
    } catch (error) {
      console.error('[Dispatcher] Profile error:', error);
      res.status(500).json({ error: 'Failed to get profile' });
    }
  }
);

/**
 * PUT /dispatchers/profile
 * Update dispatcher profile
 */
router.put('/profile',
  authenticate,
  requireDispatcher,
  async (req, res) => {
    try {
      const { companyName, bio, defaultCommissionRate, acceptingDrivers } = req.body;
      
      const updates = [];
      const values = [];
      let paramCount = 0;
      
      if (companyName !== undefined) {
        paramCount++;
        updates.push(`dispatcher_company_name = $${paramCount}`);
        values.push(companyName);
      }
      
      if (bio !== undefined) {
        paramCount++;
        updates.push(`dispatcher_bio = $${paramCount}`);
        values.push(bio);
      }
      
      if (defaultCommissionRate !== undefined) {
        const rate = parseFloat(defaultCommissionRate);
        if (rate < 0 || rate > 50) {
          return res.status(400).json({ error: 'Commission rate must be between 0% and 50%' });
        }
        paramCount++;
        updates.push(`default_commission_rate = $${paramCount}`);
        values.push(rate);
      }
      
      if (acceptingDrivers !== undefined) {
        paramCount++;
        updates.push(`dispatcher_accepting_drivers = $${paramCount}`);
        values.push(acceptingDrivers);
      }
      
      if (updates.length === 0) {
        return res.status(400).json({ error: 'No fields to update' });
      }
      
      paramCount++;
      values.push(req.user.id);
      
      const result = await pool.query(`
        UPDATE users
        SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
        WHERE id = $${paramCount}
        RETURNING dispatcher_company_name, dispatcher_bio, default_commission_rate, dispatcher_accepting_drivers
      `, values);
      
      res.json({
        message: 'Profile updated',
        profile: result.rows[0],
      });
    } catch (error) {
      console.error('[Dispatcher] Update profile error:', error);
      res.status(500).json({ error: 'Failed to update profile' });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// DISPATCHER DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /dispatchers/dashboard
 * Get dispatcher dashboard stats
 */
router.get('/dashboard',
  authenticate,
  requireDispatcher,
  async (req, res) => {
    try {
      // Get driver stats
      const driverStats = await pool.query(`
        SELECT 
          COUNT(*) FILTER (WHERE status = 'active') as active_drivers,
          COUNT(*) FILTER (WHERE status = 'pending') as pending_invites
        FROM dispatcher_drivers
        WHERE dispatcher_id = $1
      `, [req.user.id]);
      
      // Get load stats (loads assigned by this dispatcher)
      const loadStats = await pool.query(`
        SELECT 
          COUNT(*) as total_loads,
          COUNT(*) FILTER (WHERE status IN ('assigned', 'en_route_pickup', 'at_pickup', 'picked_up', 'en_route_delivery', 'at_delivery')) as active_loads,
          COUNT(*) FILTER (WHERE status = 'delivered' OR status = 'completed') as completed_loads,
          COALESCE(SUM(dispatcher_commission) FILTER (WHERE status IN ('delivered', 'completed')), 0) as total_earnings
        FROM loads
        WHERE accepted_by_dispatcher_id = $1
      `, [req.user.id]);
      
      // Get pending requests
      const pendingRequests = await pool.query(`
        SELECT COUNT(*) FROM dispatcher_requests
        WHERE dispatcher_id = $1 AND status = 'pending'
      `, [req.user.id]);
      
      // Get recent activity
      const recentLoads = await pool.query(`
        SELECT 
          l.id, l.status, l.pickup_city, l.delivery_city,
          l.price, l.dispatcher_commission,
          l.created_at, l.delivered_at,
          u.first_name || ' ' || COALESCE(u.last_name, '') as driver_name
        FROM loads l
        JOIN users u ON l.driver_id = u.id
        WHERE l.accepted_by_dispatcher_id = $1
        ORDER BY l.created_at DESC
        LIMIT 5
      `, [req.user.id]);
      
      // Get this week's earnings
      const weekEarnings = await pool.query(`
        SELECT COALESCE(SUM(dispatcher_commission), 0) as week_earnings
        FROM loads
        WHERE accepted_by_dispatcher_id = $1
          AND status IN ('delivered', 'completed')
          AND delivered_at >= NOW() - INTERVAL '7 days'
      `, [req.user.id]);
      
      res.json({
        drivers: {
          active: parseInt(driverStats.rows[0].active_drivers),
          pendingInvites: parseInt(driverStats.rows[0].pending_invites),
        },
        loads: {
          total: parseInt(loadStats.rows[0].total_loads),
          active: parseInt(loadStats.rows[0].active_loads),
          completed: parseInt(loadStats.rows[0].completed_loads),
        },
        earnings: {
          total: parseFloat(loadStats.rows[0].total_earnings) || 0,
          thisWeek: parseFloat(weekEarnings.rows[0].week_earnings) || 0,
        },
        pendingRequests: parseInt(pendingRequests.rows[0].count),
        recentLoads: recentLoads.rows,
      });
    } catch (error) {
      console.error('[Dispatcher] Dashboard error:', error);
      res.status(500).json({ error: 'Failed to load dashboard' });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// DRIVER MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /dispatchers/drivers
 * Get all drivers for this dispatcher
 */
router.get('/drivers',
  authenticate,
  requireDispatcher,
  async (req, res) => {
    try {
      const { status = 'active' } = req.query;
      
      const result = await pool.query(`
        SELECT 
          dd.id as relationship_id,
          dd.status,
          dd.commission_rate,
          dd.connection_type,
          dd.created_at as joined_at,
          dd.accepted_at,
          u.id as driver_id,
          u.first_name,
          u.last_name,
          u.email,
          u.phone,
          u.vehicle_type,
          u.license_plate,
          u.rating as driver_rating,
          u.total_deliveries,
          u.driver_lat,
          u.driver_lng,
          u.location_updated_at,
          u.is_available,
          (
            SELECT COUNT(*) FROM loads l 
            WHERE l.driver_id = u.id 
              AND l.accepted_by_dispatcher_id = $1
              AND l.status IN ('delivered', 'completed')
          ) as loads_completed,
          (
            SELECT COALESCE(SUM(driver_payout - COALESCE(dispatcher_commission, 0)), 0) 
            FROM loads l 
            WHERE l.driver_id = u.id 
              AND l.accepted_by_dispatcher_id = $1
              AND l.status IN ('delivered', 'completed')
          ) as total_earned
        FROM dispatcher_drivers dd
        JOIN users u ON dd.driver_id = u.id
        WHERE dd.dispatcher_id = $1
          AND ($2 = 'all' OR dd.status = $2)
        ORDER BY dd.created_at DESC
      `, [req.user.id, status]);
      
      res.json({
        drivers: result.rows,
        count: result.rows.length,
      });
    } catch (error) {
      console.error('[Dispatcher] Get drivers error:', error);
      res.status(500).json({ error: 'Failed to get drivers' });
    }
  }
);

/**
 * GET /dispatchers/drivers/:driverId
 * Get single driver details
 */
router.get('/drivers/:driverId',
  authenticate,
  requireDispatcher,
  async (req, res) => {
    try {
      const { driverId } = req.params;
      
      // Get driver relationship
      const relationship = await pool.query(`
        SELECT 
          dd.*,
          u.first_name, u.last_name, u.email, u.phone,
          u.vehicle_type, u.license_plate, u.rating, u.total_deliveries,
          u.driver_lat, u.driver_lng, u.location_updated_at, u.is_available
        FROM dispatcher_drivers dd
        JOIN users u ON dd.driver_id = u.id
        WHERE dd.dispatcher_id = $1 AND dd.driver_id = $2
      `, [req.user.id, driverId]);
      
      if (relationship.rows.length === 0) {
        return res.status(404).json({ error: 'Driver not found' });
      }
      
      // Get driver's recent loads with this dispatcher
      const recentLoads = await pool.query(`
        SELECT 
          l.id, l.status, l.pickup_city, l.delivery_city,
          l.price, l.driver_payout, l.dispatcher_commission, l.driver_net_payout,
          l.created_at, l.delivered_at
        FROM loads l
        WHERE l.driver_id = $1 AND l.accepted_by_dispatcher_id = $2
        ORDER BY l.created_at DESC
        LIMIT 10
      `, [driverId, req.user.id]);
      
      // Get earnings summary
      const earnings = await pool.query(`
        SELECT 
          COUNT(*) as total_loads,
          COALESCE(SUM(driver_payout), 0) as gross_earnings,
          COALESCE(SUM(dispatcher_commission), 0) as your_commission,
          COALESCE(SUM(driver_net_payout), 0) as driver_net
        FROM loads
        WHERE driver_id = $1 
          AND accepted_by_dispatcher_id = $2
          AND status IN ('delivered', 'completed')
      `, [driverId, req.user.id]);
      
      res.json({
        driver: relationship.rows[0],
        recentLoads: recentLoads.rows,
        earnings: earnings.rows[0],
      });
    } catch (error) {
      console.error('[Dispatcher] Get driver detail error:', error);
      res.status(500).json({ error: 'Failed to get driver details' });
    }
  }
);

/**
 * PUT /dispatchers/drivers/:driverId
 * Update driver commission rate
 */
router.put('/drivers/:driverId',
  authenticate,
  requireDispatcher,
  async (req, res) => {
    try {
      const { driverId } = req.params;
      const { commissionRate } = req.body;
      
      if (commissionRate === undefined) {
        return res.status(400).json({ error: 'Commission rate required' });

/**
 * GET /dispatchers/drivers/:driverId/active-load
 * Get driver's current active load (for fleet map)
 */
router.get('/drivers/:driverId/active-load',
  authenticate,
  requireDispatcher,
  async (req, res) => {
    try {
      const { driverId } = req.params;
      
      // Verify driver belongs to this dispatcher
      const relationship = await pool.query(`
        SELECT id FROM dispatcher_drivers
        WHERE dispatcher_id = router.put('/drivers/:driverId',
  authenticate,
  requireDispatcher,
  async (req, res) => {
    try {
      const { driverId } = req.params;
      const { commissionRate } = req.body;
      
      if (commissionRate === undefined) {
        return res.status(400).json({ error: 'Commission rate required' }); AND driver_id = $2 AND status = 'active'
      `, [req.user.id, driverId]);
      
      if (relationship.rows.length === 0) {
        return res.status(403).json({ error: 'Driver not in your fleet' });
      }
      
      // Get driver's active load
      const result = await pool.query(`
        SELECT 
          l.id, l.status, l.load_type,
          l.pickup_city, l.pickup_state, l.pickup_lat, l.pickup_lng,
          l.delivery_city, l.delivery_state, l.delivery_lat, l.delivery_lng,
          l.price, l.driver_payout, l.dispatcher_commission
        FROM loads l
        WHERE l.driver_id = router.put('/drivers/:driverId',
  authenticate,
  requireDispatcher,
  async (req, res) => {
    try {
      const { driverId } = req.params;
      const { commissionRate } = req.body;
      
      if (commissionRate === undefined) {
        return res.status(400).json({ error: 'Commission rate required' });
          AND l.status IN ('assigned', 'accepted', 'en_route_pickup', 'at_pickup', 'picked_up', 'en_route_delivery', 'at_delivery')
        ORDER BY l.assigned_at DESC
        LIMIT 1
      `, [driverId]);
      
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'No active load', load: null });
      }
      
      res.json({ load: result.rows[0] });
    } catch (error) {
      console.error('[Dispatcher] Get driver active load error:', error);
      res.status(500).json({ error: 'Failed to get active load' });
    }
  }
);
      }
      
      const rate = parseFloat(commissionRate);
      if (rate < 0 || rate > 50) {
        return res.status(400).json({ error: 'Commission rate must be between 0% and 50%' });
      }
      
      const result = await pool.query(`
        UPDATE dispatcher_drivers
        SET commission_rate = $1
        WHERE dispatcher_id = $2 AND driver_id = $3 AND status = 'active'
        RETURNING *
      `, [rate, req.user.id, driverId]);
      
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Driver relationship not found' });
      }
      
      res.json({
        message: 'Commission rate updated',
        relationship: result.rows[0],
      });
    } catch (error) {
      console.error('[Dispatcher] Update driver error:', error);
      res.status(500).json({ error: 'Failed to update driver' });
    }
  }
);

/**
 * DELETE /dispatchers/drivers/:driverId
 * Remove driver from dispatcher
 */
router.delete('/drivers/:driverId',
  authenticate,
  requireDispatcher,
  async (req, res) => {
    try {
      const { driverId } = req.params;
      
      const result = await pool.query(`
        UPDATE dispatcher_drivers
        SET 
          status = 'removed',
          removed_at = CURRENT_TIMESTAMP,
          removed_by = $1
        WHERE dispatcher_id = $1 AND driver_id = $2 AND status = 'active'
        RETURNING *
      `, [req.user.id, driverId]);
      
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Active driver relationship not found' });
      }
      
      res.json({
        message: 'Driver removed',
      });
    } catch (error) {
      console.error('[Dispatcher] Remove driver error:', error);
      res.status(500).json({ error: 'Failed to remove driver' });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// INVITE CODES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /dispatchers/invite-codes
 * Generate new invite code
 */
router.post('/invite-codes',
  authenticate,
  requireDispatcher,
  async (req, res) => {
    try {
      const { commissionRate, maxUses, expiresInDays, customCode } = req.body;
      
      // Generate or use custom code
      let code = customCode?.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!code || code.length < 4) {
        code = crypto.randomBytes(4).toString('hex').toUpperCase();
      }
      
      // Check if code already exists
      const existing = await pool.query(
        'SELECT id FROM dispatcher_invite_codes WHERE code = $1',
        [code]
      );
      
      if (existing.rows.length > 0) {
        return res.status(409).json({ error: 'Code already exists. Try a different one.' });
      }
      
      // Validate commission rate
      const rate = parseFloat(commissionRate) || 10.0;
      if (rate < 0 || rate > 50) {
        return res.status(400).json({ error: 'Commission rate must be between 0% and 50%' });
      }
      
      // Calculate expiration
      let expiresAt = null;
      if (expiresInDays) {
        expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + parseInt(expiresInDays));
      }
      
      const result = await pool.query(`
        INSERT INTO dispatcher_invite_codes 
          (dispatcher_id, code, commission_rate, max_uses, expires_at)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
      `, [req.user.id, code, rate, maxUses || null, expiresAt]);
      
      res.status(201).json({
        message: 'Invite code created',
        inviteCode: result.rows[0],
      });
    } catch (error) {
      console.error('[Dispatcher] Create invite code error:', error);
      res.status(500).json({ error: 'Failed to create invite code' });
    }
  }
);

/**
 * GET /dispatchers/invite-codes
 * List dispatcher's invite codes
 */
router.get('/invite-codes',
  authenticate,
  requireDispatcher,
  async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT *
        FROM dispatcher_invite_codes
        WHERE dispatcher_id = $1
        ORDER BY created_at DESC
      `, [req.user.id]);
      
      res.json({
        inviteCodes: result.rows,
      });
    } catch (error) {
      console.error('[Dispatcher] List invite codes error:', error);
      res.status(500).json({ error: 'Failed to get invite codes' });
    }
  }
);

/**
 * DELETE /dispatchers/invite-codes/:codeId
 * Deactivate invite code
 */
router.delete('/invite-codes/:codeId',
  authenticate,
  requireDispatcher,
  async (req, res) => {
    try {
      const result = await pool.query(`
        UPDATE dispatcher_invite_codes
        SET is_active = false, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND dispatcher_id = $2
        RETURNING *
      `, [req.params.codeId, req.user.id]);
      
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Invite code not found' });
      }
      
      res.json({
        message: 'Invite code deactivated',
      });
    } catch (error) {
      console.error('[Dispatcher] Delete invite code error:', error);
      res.status(500).json({ error: 'Failed to delete invite code' });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// DRIVER REQUESTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /dispatchers/requests
 * Get pending driver requests
 */
router.get('/requests',
  authenticate,
  requireDispatcher,
  async (req, res) => {
    try {
      const { status = 'pending' } = req.query;
      
      const result = await pool.query(`
        SELECT 
          dr.*,
          u.first_name, u.last_name, u.email, u.phone,
          u.vehicle_type, u.rating, u.total_deliveries
        FROM dispatcher_requests dr
        JOIN users u ON dr.driver_id = u.id
        WHERE dr.dispatcher_id = $1
          AND ($2 = 'all' OR dr.status = $2)
        ORDER BY dr.created_at DESC
      `, [req.user.id, status]);
      
      res.json({
        requests: result.rows,
      });
    } catch (error) {
      console.error('[Dispatcher] Get requests error:', error);
      res.status(500).json({ error: 'Failed to get requests' });
    }
  }
);

/**
 * POST /dispatchers/requests/:requestId/accept
 * Accept driver request
 */
router.post('/requests/:requestId/accept',
  authenticate,
  requireDispatcher,
  async (req, res) => {
    try {
      const { requestId } = req.params;
      const { commissionRate } = req.body;
      
      // Get request
      const request = await pool.query(`
        SELECT * FROM dispatcher_requests
        WHERE id = $1 AND dispatcher_id = $2 AND status = 'pending'
      `, [requestId, req.user.id]);
      
      if (request.rows.length === 0) {
        return res.status(404).json({ error: 'Request not found or already processed' });
      }
      
      const driverId = request.rows[0].driver_id;
      
      // Get dispatcher's default rate if not specified
      let rate = parseFloat(commissionRate);
      if (isNaN(rate)) {
        const dispatcher = await pool.query(
          'SELECT default_commission_rate FROM users WHERE id = $1',
          [req.user.id]
        );
        rate = dispatcher.rows[0].default_commission_rate;
      }
      
      // Create relationship
      await pool.query(`
        INSERT INTO dispatcher_drivers 
          (dispatcher_id, driver_id, status, commission_rate, connection_type, accepted_at)
        VALUES ($1, $2, 'active', $3, 'request', CURRENT_TIMESTAMP)
        ON CONFLICT (dispatcher_id, driver_id) 
        DO UPDATE SET 
          status = 'active', 
          commission_rate = $3,
          accepted_at = CURRENT_TIMESTAMP
      `, [req.user.id, driverId, rate]);
      
      // Update request
      await pool.query(`
        UPDATE dispatcher_requests
        SET status = 'accepted', responded_at = CURRENT_TIMESTAMP
        WHERE id = $1
      `, [requestId]);
      
      res.json({
        message: 'Request accepted',
        commissionRate: rate,
      });
    } catch (error) {
      console.error('[Dispatcher] Accept request error:', error);
      res.status(500).json({ error: 'Failed to accept request' });
    }
  }
);

/**
 * POST /dispatchers/requests/:requestId/decline
 * Decline driver request
 */
router.post('/requests/:requestId/decline',
  authenticate,
  requireDispatcher,
  async (req, res) => {
    try {
      const { requestId } = req.params;
      
      const result = await pool.query(`
        UPDATE dispatcher_requests
        SET status = 'declined', responded_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND dispatcher_id = $2 AND status = 'pending'
        RETURNING *
      `, [requestId, req.user.id]);
      
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Request not found' });
      }
      
      res.json({
        message: 'Request declined',
      });
    } catch (error) {
      console.error('[Dispatcher] Decline request error:', error);
      res.status(500).json({ error: 'Failed to decline request' });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// LOAD ASSIGNMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /dispatchers/available-loads
 * Get loads available for assignment
 */
router.get('/available-loads',
  authenticate,
  requireDispatcher,
  async (req, res) => {
    try {
      const { limit = 50, offset = 0 } = req.query;
      
      const result = await pool.query(`
        SELECT 
          l.*,
          CONCAT(s.first_name, ' ', s.last_name) as shipper_name,
          s.company_name as shipper_company
        FROM loads l
        JOIN users s ON l.shipper_id = s.id
        WHERE l.status = 'posted'
        ORDER BY l.posted_at DESC
        LIMIT $1 OFFSET $2
      `, [limit, offset]);
      
      res.json({
        loads: result.rows,
        count: result.rows.length,
      });
    } catch (error) {
      console.error('[Dispatcher] Available loads error:', error);
      res.status(500).json({ error: 'Failed to get available loads' });
    }
  }
);

/**
 * GET /dispatchers/drivers/:driverId/availability
 * Check driver availability for a time window
 */
router.get('/drivers/:driverId/availability',
  authenticate,
  requireDispatcher,
  async (req, res) => {
    try {
      const { driverId } = req.params;
      const { pickupDate, pickupTimeStart, pickupTimeEnd, deliveryDate, deliveryTimeEnd } = req.query;
      
      // Verify driver belongs to this dispatcher
      const relationship = await pool.query(`
        SELECT id FROM dispatcher_drivers
        WHERE dispatcher_id = $1 AND driver_id = $2 AND status = 'active'
      `, [req.user.id, driverId]);
      
      if (relationship.rows.length === 0) {
        return res.status(403).json({ error: 'Driver not in your fleet' });
      }
      
      // Check for conflicts
      const conflicts = await pool.query(`
        SELECT 
          l.id, l.status, l.pickup_city, l.delivery_city,
          l.pickup_date, l.pickup_time_start,
          l.delivery_date, l.delivery_time_end
        FROM loads l
        WHERE l.driver_id = $1
          AND l.status IN ('assigned', 'accepted', 'en_route_pickup', 'at_pickup', 'picked_up', 'en_route_delivery', 'at_delivery')
          AND (
            -- Check for time overlap with 2 hour buffer
            (l.delivery_date + l.delivery_time_end::TIME + INTERVAL '2 hours') > ($2::DATE + $3::TIME)
          )
        ORDER BY l.pickup_date, l.pickup_time_start
      `, [driverId, pickupDate, pickupTimeStart]);
      
      const isAvailable = conflicts.rows.length === 0;
      
      res.json({
        isAvailable,
        conflicts: conflicts.rows,
        driverId,
      });
    } catch (error) {
      console.error('[Dispatcher] Check availability error:', error);
      res.status(500).json({ error: 'Failed to check availability' });
    }
  }
);

/**
 * POST /dispatchers/loads/:loadId/assign
 * Assign load to a driver
 */
router.post('/loads/:loadId/assign',
  authenticate,
  requireDispatcher,
  async (req, res) => {
    try {
      const { loadId } = req.params;
      const { driverId } = req.body;
      
      if (!driverId) {
        return res.status(400).json({ error: 'Driver ID required' });
      }
      
      // Verify driver belongs to dispatcher
      const relationship = await pool.query(`
        SELECT commission_rate FROM dispatcher_drivers
        WHERE dispatcher_id = $1 AND driver_id = $2 AND status = 'active'
      `, [req.user.id, driverId]);
      
      if (relationship.rows.length === 0) {
        return res.status(403).json({ error: 'Driver not in your fleet' });
      }
      
      const commissionRate = relationship.rows[0].commission_rate;
      
      // Get load
      const load = await pool.query(`
        SELECT * FROM loads WHERE id = $1 AND status = 'posted'
      `, [loadId]);
      
      if (load.rows.length === 0) {
        return res.status(404).json({ error: 'Load not available' });
      }
      
      const loadData = load.rows[0];
      
      // Check for conflicts
      const conflicts = await pool.query(`
        SELECT id, delivery_city, delivery_time_end
        FROM loads
        WHERE driver_id = $1
          AND status IN ('assigned', 'accepted', 'en_route_pickup', 'at_pickup', 'picked_up', 'en_route_delivery', 'at_delivery')
          AND (delivery_date + delivery_time_end::TIME + INTERVAL '2 hours') > ($2::DATE + $3::TIME)
        LIMIT 1
      `, [driverId, loadData.pickup_date, loadData.pickup_time_start || '00:00']);
      
      if (conflicts.rows.length > 0) {
        return res.status(409).json({
          error: 'Schedule conflict',
          conflict: conflicts.rows[0],
          message: `Driver has delivery to ${conflicts.rows[0].delivery_city} ending at ${conflicts.rows[0].delivery_time_end}`,
        });
      }
      
      // Calculate payouts
      const driverShare = parseFloat(loadData.driver_payout);
      const dispatcherCommission = driverShare * (commissionRate / 100);
      const driverNetPayout = driverShare - dispatcherCommission;
      
      // Assign load
      const result = await pool.query(`
        UPDATE loads
        SET 
          driver_id = $1,
          status = 'assigned',
          assigned_at = CURRENT_TIMESTAMP,
          accepted_by_user_id = $2,
          accepted_by_dispatcher_id = $2,
          dispatcher_commission_rate = $3,
          dispatcher_commission = $4,
          driver_net_payout = $5,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $6 AND status = 'posted'
        RETURNING *
      `, [driverId, req.user.id, commissionRate, dispatcherCommission, driverNetPayout, loadId]);
      
      if (result.rows.length === 0) {
        return res.status(409).json({ error: 'Load no longer available' });
      }
      
      // Create schedule entry for conflict detection
      await pool.query(`
        INSERT INTO driver_schedule 
          (driver_id, load_id, type, start_time, end_time, created_by)
        VALUES (
          $1, $2, 'load',
          $3::DATE + COALESCE($4::TIME, '00:00'::TIME),
          $5::DATE + COALESCE($6::TIME, '23:59'::TIME),
          $7
        )
      `, [
        driverId, loadId,
        loadData.pickup_date, loadData.pickup_time_start,
        loadData.delivery_date, loadData.delivery_time_end,
        req.user.id
      ]);
      
      // TODO: Notify driver of new assignment
      // TODO: Notify shipper that load was accepted
      
      res.json({
        message: 'Load assigned successfully',
        load: result.rows[0],
        payout: {
          loadPrice: parseFloat(loadData.price),
          platformFee: parseFloat(loadData.platform_fee),
          driverShare,
          dispatcherCommission,
          driverNetPayout,
        },
      });
    } catch (error) {
      console.error('[Dispatcher] Assign load error:', error);
      res.status(500).json({ error: 'Failed to assign load' });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// DISPATCHER EARNINGS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /dispatchers/earnings
 * Get earnings breakdown
 */
router.get('/earnings',
  authenticate,
  requireDispatcher,
  async (req, res) => {
    try {
      const { startDate, endDate, driverId } = req.query;
      
      let dateFilter = '';
      const params = [req.user.id];
      let paramCount = 1;
      
      if (startDate) {
        paramCount++;
        dateFilter += ` AND l.delivered_at >= $${paramCount}`;
        params.push(startDate);
      }
      
      if (endDate) {
        paramCount++;
        dateFilter += ` AND l.delivered_at <= $${paramCount}`;
        params.push(endDate);
      }
      
      if (driverId) {
        paramCount++;
        dateFilter += ` AND l.driver_id = $${paramCount}`;
        params.push(driverId);
      }
      
      // Get earnings by driver
      const byDriver = await pool.query(`
        SELECT 
          l.driver_id,
          u.first_name || ' ' || COALESCE(u.last_name, '') as driver_name,
          COUNT(*) as load_count,
          SUM(l.price) as total_load_value,
          SUM(l.dispatcher_commission) as total_commission
        FROM loads l
        JOIN users u ON l.driver_id = u.id
        WHERE l.accepted_by_dispatcher_id = $1
          AND l.status IN ('delivered', 'completed')
          ${dateFilter}
        GROUP BY l.driver_id, u.first_name, u.last_name
        ORDER BY total_commission DESC
      `, params);
      
      // Get daily breakdown (last 30 days)
      const daily = await pool.query(`
        SELECT 
          DATE(l.delivered_at) as date,
          COUNT(*) as load_count,
          SUM(l.dispatcher_commission) as daily_earnings
        FROM loads l
        WHERE l.accepted_by_dispatcher_id = $1
          AND l.status IN ('delivered', 'completed')
          AND l.delivered_at >= NOW() - INTERVAL '30 days'
        GROUP BY DATE(l.delivered_at)
        ORDER BY date DESC
      `, [req.user.id]);
      
      // Get totals
      const totals = await pool.query(`
        SELECT 
          COUNT(*) as total_loads,
          COALESCE(SUM(l.price), 0) as total_load_value,
          COALESCE(SUM(l.dispatcher_commission), 0) as total_earnings
        FROM loads l
        WHERE l.accepted_by_dispatcher_id = $1
          AND l.status IN ('delivered', 'completed')
          ${dateFilter}
      `, params);
      
      res.json({
        totals: totals.rows[0],
        byDriver: byDriver.rows,
        daily: daily.rows,
      });
    } catch (error) {
      console.error('[Dispatcher] Earnings error:', error);
      res.status(500).json({ error: 'Failed to get earnings' });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// DRIVER-FACING ROUTES (for drivers to interact with dispatchers)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /dispatchers/join
 * Driver joins dispatcher using invite code
 */
router.post('/join',
  authenticate,
  async (req, res) => {
    try {
      const { code } = req.body;
      
      if (!code) {
        return res.status(400).json({ error: 'Invite code required' });
      }
      
      // Find invite code
      const invite = await pool.query(`
        SELECT ic.*, u.first_name, u.last_name, u.dispatcher_company_name
        FROM dispatcher_invite_codes ic
        JOIN users u ON ic.dispatcher_id = u.id
        WHERE ic.code = $1 
          AND ic.is_active = true
          AND (ic.expires_at IS NULL OR ic.expires_at > NOW())
          AND (ic.max_uses IS NULL OR ic.use_count < ic.max_uses)
      `, [code.toUpperCase()]);
      
      if (invite.rows.length === 0) {
        return res.status(404).json({ error: 'Invalid or expired invite code' });
      }
      
      const inviteData = invite.rows[0];
      
      // Check if already connected
      const existing = await pool.query(`
        SELECT id, status FROM dispatcher_drivers
        WHERE dispatcher_id = $1 AND driver_id = $2
      `, [inviteData.dispatcher_id, req.user.id]);
      
      if (existing.rows.length > 0) {
        const status = existing.rows[0].status;
        if (status === 'active') {
          return res.status(409).json({ error: 'Already connected to this dispatcher' });
        }
        if (status === 'pending') {
          return res.status(409).json({ error: 'Invite already pending' });
        }
      }
      
      // Create relationship
      await pool.query(`
        INSERT INTO dispatcher_drivers 
          (dispatcher_id, driver_id, status, commission_rate, connection_type, invite_code, accepted_at)
        VALUES ($1, $2, 'active', $3, 'invite', $4, CURRENT_TIMESTAMP)
        ON CONFLICT (dispatcher_id, driver_id) 
        DO UPDATE SET 
          status = 'active',
          commission_rate = $3,
          invite_code = $4,
          accepted_at = CURRENT_TIMESTAMP
      `, [inviteData.dispatcher_id, req.user.id, inviteData.commission_rate, code.toUpperCase()]);
      
      // Increment use count
      await pool.query(`
        UPDATE dispatcher_invite_codes
        SET use_count = use_count + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
      `, [inviteData.id]);
      
      res.json({
        message: 'Successfully joined dispatcher',
        dispatcher: {
          id: inviteData.dispatcher_id,
          name: `${inviteData.first_name} ${inviteData.last_name || ''}`.trim(),
          companyName: inviteData.dispatcher_company_name,
          commissionRate: inviteData.commission_rate,
        },
      });
    } catch (error) {
      console.error('[Dispatcher] Join error:', error);
      res.status(500).json({ error: 'Failed to join dispatcher' });
    }
  }
);

/**
 * GET /dispatchers/my-dispatchers
 * Driver gets their dispatchers
 */
router.get('/my-dispatchers',
  authenticate,
  async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT 
          dd.id as relationship_id,
          dd.status,
          dd.commission_rate,
          dd.accepted_at,
          u.id as dispatcher_id,
          u.first_name || ' ' || COALESCE(u.last_name, '') as name,
          u.dispatcher_company_name as company_name,
          u.dispatcher_rating as rating,
          u.phone,
          (
            SELECT COUNT(*) FROM loads l 
            WHERE l.driver_id = $1 
              AND l.accepted_by_dispatcher_id = u.id
              AND l.status IN ('delivered', 'completed')
          ) as loads_together,
          (
            SELECT COALESCE(SUM(driver_net_payout), 0) FROM loads l 
            WHERE l.driver_id = $1 
              AND l.accepted_by_dispatcher_id = u.id
              AND l.status IN ('delivered', 'completed')
          ) as total_earned
        FROM dispatcher_drivers dd
        JOIN users u ON dd.dispatcher_id = u.id
        WHERE dd.driver_id = $1 AND dd.status = 'active'
        ORDER BY dd.accepted_at DESC
      `, [req.user.id]);
      
      res.json({
        dispatchers: result.rows,
      });
    } catch (error) {
      console.error('[Dispatcher] My dispatchers error:', error);
      res.status(500).json({ error: 'Failed to get dispatchers' });
    }
  }
);

/**
 * DELETE /dispatchers/leave/:dispatcherId
 * Driver leaves a dispatcher
 */
router.delete('/leave/:dispatcherId',
  authenticate,
  async (req, res) => {
    try {
      const { dispatcherId } = req.params;
      
      const result = await pool.query(`
        UPDATE dispatcher_drivers
        SET 
          status = 'removed',
          removed_at = CURRENT_TIMESTAMP,
          removed_by = $1
        WHERE dispatcher_id = $2 AND driver_id = $1 AND status = 'active'
        RETURNING *
      `, [req.user.id, dispatcherId]);
      
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Dispatcher relationship not found' });
      }
      
      res.json({
        message: 'Left dispatcher successfully',
      });
    } catch (error) {
      console.error('[Dispatcher] Leave error:', error);
      res.status(500).json({ error: 'Failed to leave dispatcher' });
    }
  }
);

/**
 * GET /dispatchers/search
 * Driver searches for dispatchers to request
 */
router.get('/search',
  authenticate,
  async (req, res) => {
    try {
      const { query, limit = 20 } = req.query;
      
      let whereClause = 'u.is_dispatcher = true AND u.dispatcher_accepting_drivers = true';
      const params = [req.user.id, limit];
      
      if (query) {
        params.push(`%${query}%`);
        whereClause += ` AND (
          u.dispatcher_company_name ILIKE $3 
          OR u.first_name ILIKE $3 
          OR u.last_name ILIKE $3
        )`;
      }
      
      const result = await pool.query(`
        SELECT 
          u.id,
          u.first_name || ' ' || COALESCE(u.last_name, '') as name,
          u.dispatcher_company_name as company_name,
          u.dispatcher_bio as bio,
          u.default_commission_rate as commission_rate,
          u.dispatcher_rating as rating,
          u.dispatcher_rating_count as rating_count,
          u.dispatcher_total_loads as total_loads,
          (SELECT COUNT(*) FROM dispatcher_drivers dd WHERE dd.dispatcher_id = u.id AND dd.status = 'active') as driver_count,
          EXISTS (
            SELECT 1 FROM dispatcher_drivers dd 
            WHERE dd.dispatcher_id = u.id AND dd.driver_id = $1 AND dd.status = 'active'
          ) as already_connected,
          EXISTS (
            SELECT 1 FROM dispatcher_requests dr 
            WHERE dr.dispatcher_id = u.id AND dr.driver_id = $1 AND dr.status = 'pending'
          ) as request_pending
        FROM users u
        WHERE ${whereClause}
        ORDER BY u.dispatcher_rating DESC, u.dispatcher_total_loads DESC
        LIMIT $2
      `, params);
      
      res.json({
        dispatchers: result.rows,
      });
    } catch (error) {
      console.error('[Dispatcher] Search error:', error);
      res.status(500).json({ error: 'Failed to search dispatchers' });
    }
  }
);

/**
 * POST /dispatchers/request/:dispatcherId
 * Driver requests to join a dispatcher
 */
router.post('/request/:dispatcherId',
  authenticate,
  async (req, res) => {
    try {
      const { dispatcherId } = req.params;
      const { message } = req.body;
      
      // Check dispatcher exists and accepting
      const dispatcher = await pool.query(`
        SELECT id, dispatcher_accepting_drivers, first_name, dispatcher_company_name
        FROM users
        WHERE id = $1 AND is_dispatcher = true
      `, [dispatcherId]);
      
      if (dispatcher.rows.length === 0) {
        return res.status(404).json({ error: 'Dispatcher not found' });
      }
      
      if (!dispatcher.rows[0].dispatcher_accepting_drivers) {
        return res.status(400).json({ error: 'Dispatcher not accepting new drivers' });
      }
      
      // Check for existing relationship or request
      const existing = await pool.query(`
        SELECT id FROM dispatcher_drivers
        WHERE dispatcher_id = $1 AND driver_id = $2 AND status = 'active'
      `, [dispatcherId, req.user.id]);
      
      if (existing.rows.length > 0) {
        return res.status(409).json({ error: 'Already connected to this dispatcher' });
      }
      
      const existingRequest = await pool.query(`
        SELECT id, status FROM dispatcher_requests
        WHERE dispatcher_id = $1 AND driver_id = $2
      `, [dispatcherId, req.user.id]);
      
      if (existingRequest.rows.length > 0) {
        if (existingRequest.rows[0].status === 'pending') {
          return res.status(409).json({ error: 'Request already pending' });
        }
      }
      
      // Create request
      await pool.query(`
        INSERT INTO dispatcher_requests (driver_id, dispatcher_id, message)
        VALUES ($1, $2, $3)
        ON CONFLICT (driver_id, dispatcher_id)
        DO UPDATE SET status = 'pending', message = $3, created_at = CURRENT_TIMESTAMP
      `, [req.user.id, dispatcherId, message || null]);
      
      res.json({
        message: 'Request sent successfully',
        dispatcher: {
          name: dispatcher.rows[0].first_name,
          companyName: dispatcher.rows[0].dispatcher_company_name,
        },
      });
    } catch (error) {
      console.error('[Dispatcher] Request error:', error);
      res.status(500).json({ error: 'Failed to send request' });
    }
  }
);


// ═══════════════════════════════════════════════════════════════════════════════
// DISPATCHER ACTIVITY FEED
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/activity', authenticate, async (req, res) => {
  try {
    const { filter = 'all', limit = 50 } = req.query;
    
    let query = `
      SELECT 
        l.id, l.status, l.pickup_city, l.delivery_city,
        l.price, l.driver_payout, l.dispatcher_commission,
        l.assigned_at, l.picked_up_at, l.delivered_at, l.completed_at, l.updated_at,
        d.id as driver_id,
        d.first_name || ' ' || COALESCE(d.last_name, '') as driver_name
      FROM loads l
      JOIN dispatcher_drivers dd ON l.driver_id = dd.driver_id
      JOIN users d ON l.driver_id = d.id
      WHERE dd.dispatcher_id = $1 AND dd.status = 'active'
    `;
    
    if (filter === 'loads') {
      query += ` AND l.status IN ('assigned', 'en_route_pickup', 'picked_up', 'en_route_delivery', 'delivered')`;
    } else if (filter === 'earnings') {
      query += ` AND l.status IN ('delivered', 'completed') AND l.dispatcher_commission > 0`;
    }
    
    query += ` ORDER BY COALESCE(l.updated_at, l.created_at) DESC LIMIT $2`;
    
    const result = await pool.query(query, [req.user.id, parseInt(limit)]);
    
    const activities = result.rows.map(load => {
      let type = 'load_update', message = '', created_at = load.updated_at;
      if (load.completed_at) { type = 'load_completed'; message = 'Completed delivery'; created_at = load.completed_at; }
      else if (load.delivered_at) { type = 'load_delivered'; message = 'Delivered load'; created_at = load.delivered_at; }
      else if (load.picked_up_at) { type = 'load_picked_up'; message = 'Picked up load'; created_at = load.picked_up_at; }
      else if (load.assigned_at) { type = 'load_assigned'; message = 'Accepted load assignment'; created_at = load.assigned_at; }
      
      return {
        id: `${load.id}-${type}`, type, driver_id: load.driver_id, driver_name: load.driver_name,
        load_id: load.id, pickup_city: load.pickup_city, delivery_city: load.delivery_city,
        amount: parseFloat(load.price) || 0, commission: parseFloat(load.dispatcher_commission) || 0,
        status: load.status, message, created_at,
      };
    });
    
    res.json({ activities });
  } catch (error) {
    console.error('[Dispatcher Activity] Error:', error);
    res.status(500).json({ error: 'Failed to fetch activity' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// DISPATCHER SETTINGS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/settings', authenticate, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT dispatcher_company_name, dispatcher_bio, default_commission_rate
      FROM users WHERE id = $1 AND is_dispatcher = true
    `, [req.user.id]);
    
    if (result.rows.length === 0) return res.status(404).json({ error: 'Dispatcher not found' });
    res.json(result.rows[0]);
  } catch (error) {
    console.error('[Dispatcher Settings] GET error:', error);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

router.put('/settings', authenticate, async (req, res) => {
  try {
    const { companyName, bio, defaultCommissionRate } = req.body;
    
    if (defaultCommissionRate !== undefined) {
      const rate = parseInt(defaultCommissionRate);
      if (isNaN(rate) || rate < 0 || rate > 50) {
        return res.status(400).json({ error: 'Commission rate must be between 0 and 50' });
      }
    }
    
    await pool.query(`
      UPDATE users SET
        dispatcher_company_name = COALESCE($1, dispatcher_company_name),
        dispatcher_bio = COALESCE($2, dispatcher_bio),
        default_commission_rate = COALESCE($3, default_commission_rate),
        updated_at = NOW()
      WHERE id = $4 AND is_dispatcher = true
    `, [companyName, bio, defaultCommissionRate, req.user.id]);
    
    res.json({ message: 'Settings updated' });
  } catch (error) {
    console.error('[Dispatcher Settings] PUT error:', error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// DRIVER COMMISSION MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

router.put('/drivers/:driverId/commission', authenticate, async (req, res) => {
  try {
    const { driverId } = req.params;
    const { commissionRate } = req.body;
    
    const rate = parseInt(commissionRate);
    if (isNaN(rate) || rate < 0 || rate > 50) {
      return res.status(400).json({ error: 'Commission rate must be between 0 and 50' });
    }
    
    const check = await pool.query(`
      SELECT id FROM dispatcher_drivers WHERE dispatcher_id = $1 AND driver_id = $2 AND status = 'active'
    `, [req.user.id, driverId]);
    
    if (check.rows.length === 0) return res.status(404).json({ error: 'Driver not found in your fleet' });
    
    await pool.query(`
      UPDATE dispatcher_drivers SET commission_rate = $1, updated_at = NOW()
      WHERE dispatcher_id = $2 AND driver_id = $3
    `, [rate, req.user.id, driverId]);
    
    res.json({ message: 'Commission rate updated', commissionRate: rate });
  } catch (error) {
    console.error('[Dispatcher Commission] Error:', error);
    res.status(500).json({ error: 'Failed to update commission rate' });
  }
});

router.delete('/drivers/:driverId', authenticate, async (req, res) => {
  try {
    const { driverId } = req.params;
    
    const result = await pool.query(`
      UPDATE dispatcher_drivers SET status = 'removed', updated_at = NOW()
      WHERE dispatcher_id = $1 AND driver_id = $2 AND status = 'active'
      RETURNING id
    `, [req.user.id, driverId]);
    
    if (result.rows.length === 0) return res.status(404).json({ error: 'Driver not found in your fleet' });
    res.json({ message: 'Driver removed from fleet' });
  } catch (error) {
    console.error('[Dispatcher Remove Driver] Error:', error);
    res.status(500).json({ error: 'Failed to remove driver' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// DRIVER REQUESTS (Accept/Reject)
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/requests/:requestId/accept', authenticate, async (req, res) => {
  try {
    const { requestId } = req.params;
    
    const request = await pool.query(`
      SELECT dr.*, u.default_commission_rate as dispatcher_default_rate
      FROM dispatcher_requests dr
      JOIN users u ON dr.dispatcher_id = u.id
      WHERE dr.id = $1 AND dr.dispatcher_id = $2 AND dr.status = 'pending'
    `, [requestId, req.user.id]);
    
    if (request.rows.length === 0) return res.status(404).json({ error: 'Request not found' });
    
    const req_data = request.rows[0];
    
    await pool.query(`
      INSERT INTO dispatcher_drivers (dispatcher_id, driver_id, commission_rate, status)
      VALUES ($1, $2, $3, 'active')
      ON CONFLICT (dispatcher_id, driver_id) 
      DO UPDATE SET status = 'active', commission_rate = $3, updated_at = NOW()
    `, [req.user.id, req_data.driver_id, req_data.dispatcher_default_rate || 10]);
    
    await pool.query(`UPDATE dispatcher_requests SET status = 'accepted', updated_at = NOW() WHERE id = $1`, [requestId]);
    
    res.json({ message: 'Request accepted' });
  } catch (error) {
    console.error('[Dispatcher Accept Request] Error:', error);
    res.status(500).json({ error: 'Failed to accept request' });
  }
});

router.post('/requests/:requestId/reject', authenticate, async (req, res) => {
  try {
    const { requestId } = req.params;
    
    const result = await pool.query(`
      UPDATE dispatcher_requests SET status = 'rejected', updated_at = NOW()
      WHERE id = $1 AND dispatcher_id = $2 AND status = 'pending'
      RETURNING id
    `, [requestId, req.user.id]);
    
    if (result.rows.length === 0) return res.status(404).json({ error: 'Request not found' });
    res.json({ message: 'Request rejected' });
  } catch (error) {
    console.error('[Dispatcher Reject Request] Error:', error);
    res.status(500).json({ error: 'Failed to reject request' });
  }
});

module.exports = router;


