// Assignments Routes - Dispatcher assigns drivers to loads
const express = require('express');
const { pool } = require('../db/pool');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// Try to load notification service (optional)
let notificationService;
try {
  notificationService = require('../services/notificationService');
} catch (e) {
  console.log('[Assignments] Notification service not available');
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
 * POST /assignments
 * Create an assignment - dispatcher assigns a driver to a load
 */
router.post('/', authenticate, async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { loadId, driverUserId, notes } = req.body;

    if (!loadId || !driverUserId) {
      return res.status(400).json({ error: 'loadId and driverUserId are required' });
    }

    // Get dispatcher's org
    const userOrg = await getUserPrimaryOrg(req.user.id);
    
    if (!userOrg || userOrg.org_type !== 'carrier') {
      return res.status(403).json({ error: 'Only carrier members can create assignments' });
    }

    // Check permission (must be carrier_admin or dispatcher)
    if (!['carrier_admin', 'dispatcher'].includes(userOrg.role)) {
      return res.status(403).json({ error: 'You do not have permission to assign drivers' });
    }

    // Get load and verify carrier owns it
    const loadResult = await pool.query(
      `SELECT l.*, o.name as shipper_org_name
       FROM loads l
       LEFT JOIN orgs o ON l.posted_by_org_id = o.id
       WHERE l.id = $1`,
      [loadId]
    );

    if (loadResult.rows.length === 0) {
      return res.status(404).json({ error: 'Load not found' });
    }

    const load = loadResult.rows[0];

    // Verify load is assigned to this carrier
    if (load.assigned_carrier_org_id !== userOrg.org_id) {
      return res.status(403).json({ error: 'This load is not assigned to your carrier' });
    }

    // Verify load status allows assignment
    if (!['assigned'].includes(load.status)) {
      return res.status(400).json({ 
        error: `Cannot assign driver to load with status: ${load.status}`,
        hint: 'Load must be in "assigned" status'
      });
    }

    // Verify driver belongs to this carrier
    const driverCheck = await pool.query(
      `SELECT u.id, u.first_name, u.last_name, u.phone, m.role
       FROM users u
       JOIN memberships m ON u.id = m.user_id
       WHERE u.id = $1 AND m.org_id = $2 AND m.role = 'driver' AND m.is_active = true`,
      [driverUserId, userOrg.org_id]
    );

    if (driverCheck.rows.length === 0) {
      return res.status(400).json({ error: 'Driver not found in your organization' });
    }

    const driver = driverCheck.rows[0];

    // Check if driver already has an active assignment
    const activeAssignment = await pool.query(
      `SELECT a.id, l.delivery_city 
       FROM assignments a
       JOIN loads l ON a.load_id = l.id
       WHERE a.driver_user_id = $1 AND a.status IN ('pending', 'confirmed', 'in_progress')`,
      [driverUserId]
    );

    if (activeAssignment.rows.length > 0) {
      return res.status(409).json({ 
        error: 'Driver already has an active assignment',
        activeAssignmentId: activeAssignment.rows[0].id,
        activeLoadDestination: activeAssignment.rows[0].delivery_city
      });
    }

    // Check if load already has an assignment
    const existingAssignment = await pool.query(
      `SELECT id FROM assignments WHERE load_id = $1 AND status NOT IN ('cancelled')`,
      [loadId]
    );

    if (existingAssignment.rows.length > 0) {
      return res.status(409).json({ 
        error: 'Load already has an assignment',
        existingAssignmentId: existingAssignment.rows[0].id
      });
    }

    await client.query('BEGIN');

    // Create assignment
    const result = await client.query(
      `INSERT INTO assignments (
        load_id, carrier_org_id, driver_user_id, dispatcher_user_id,
        carrier_pay, status, assigned_at
      ) VALUES ($1, $2, $3, $4, $5, 'pending', NOW())
      RETURNING *`,
      [loadId, userOrg.org_id, driverUserId, req.user.id, load.carrier_pay]
    );

    const assignment = result.rows[0];

    // Update load with driver_id
    await client.query(
      `UPDATE loads SET driver_id = $1, updated_at = NOW() WHERE id = $2`,
      [driverUserId, loadId]
    );

    await client.query('COMMIT');

    // Notify driver
    if (notificationService) {
      try {
        if (typeof notificationService.sendToUser === 'function') {
          notificationService.sendToUser(driverUserId, 'New Load Assignment',
            `You've been assigned a load to ${load.delivery_city}, ${load.delivery_state}`,
            { type: 'assignment_created', assignmentId: assignment.id, loadId }
          );
        }
      } catch (err) {
        console.error('[Assignments] Notification error:', err);
      }
    }

    res.status(201).json({
      message: 'Driver assigned successfully',
      assignment: formatAssignmentResponse(assignment, load, driver),
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[Assignments] Create error:', error);
    res.status(500).json({ error: 'Failed to create assignment' });
  } finally {
    client.release();
  }
});

/**
 * GET /assignments
 * List assignments based on user role
 * - Drivers see their assignments
 * - Dispatchers/Carriers see all org assignments
 */
router.get('/', authenticate, async (req, res) => {
  try {
    const { status, limit = 20, offset = 0 } = req.query;
    const userOrg = await getUserPrimaryOrg(req.user.id);

    let query;
    let params;

    if (userOrg?.role === 'driver') {
      // Driver sees their assignments
      query = `
        SELECT a.*,
          l.description, l.pickup_city, l.pickup_state, l.pickup_address,
          l.delivery_city, l.delivery_state, l.delivery_address,
          l.pickup_date, l.pickup_time_start, l.delivery_date,
          l.status as load_status, l.distance_miles,
          poster_org.name as shipper_org_name,
          CONCAT(dispatcher.first_name, ' ', dispatcher.last_name) as dispatcher_name
        FROM assignments a
        JOIN loads l ON a.load_id = l.id
        LEFT JOIN orgs poster_org ON l.posted_by_org_id = poster_org.id
        LEFT JOIN users dispatcher ON a.dispatcher_user_id = dispatcher.id
        WHERE a.driver_user_id = $1
        ${status ? 'AND a.status = $2' : ''}
        ORDER BY a.assigned_at DESC
        LIMIT $${status ? 3 : 2} OFFSET $${status ? 4 : 3}`;
      
      params = status 
        ? [req.user.id, status, limit, offset]
        : [req.user.id, limit, offset];
    } else if (userOrg?.org_type === 'carrier') {
      // Carrier/Dispatcher sees org assignments
      query = `
        SELECT a.*,
          l.description, l.pickup_city, l.pickup_state, l.pickup_address,
          l.delivery_city, l.delivery_state, l.delivery_address,
          l.pickup_date, l.pickup_time_start, l.delivery_date,
          l.status as load_status, l.distance_miles,
          poster_org.name as shipper_org_name,
          CONCAT(driver.first_name, ' ', driver.last_name) as driver_name,
          driver.phone as driver_phone,
          CONCAT(dispatcher.first_name, ' ', dispatcher.last_name) as dispatcher_name
        FROM assignments a
        JOIN loads l ON a.load_id = l.id
        LEFT JOIN orgs poster_org ON l.posted_by_org_id = poster_org.id
        LEFT JOIN users driver ON a.driver_user_id = driver.id
        LEFT JOIN users dispatcher ON a.dispatcher_user_id = dispatcher.id
        WHERE a.carrier_org_id = $1
        ${status ? 'AND a.status = $2' : ''}
        ORDER BY a.assigned_at DESC
        LIMIT $${status ? 3 : 2} OFFSET $${status ? 4 : 3}`;
      
      params = status 
        ? [userOrg.org_id, status, limit, offset]
        : [userOrg.org_id, limit, offset];
    } else {
      return res.status(403).json({ error: 'Access denied' });
    }

    const result = await pool.query(query, params);

    res.json({
      assignments: result.rows.map(formatAssignmentResponse),
      count: result.rows.length,
    });
  } catch (error) {
    console.error('[Assignments] List error:', error);
    res.status(500).json({ error: 'Failed to get assignments' });
  }
});

/**
 * GET /assignments/active
 * Get driver's current active assignment
 */
router.get('/active', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT a.*,
        l.id as load_id, l.description, 
        l.pickup_address, l.pickup_city, l.pickup_state, l.pickup_zip,
        l.pickup_lat, l.pickup_lng,
        l.pickup_contact_name, l.pickup_contact_phone,
        l.pickup_date, l.pickup_time_start, l.pickup_time_end,
        l.delivery_address, l.delivery_city, l.delivery_state, l.delivery_zip,
        l.delivery_lat, l.delivery_lng,
        l.delivery_contact_name, l.delivery_contact_phone,
        l.delivery_date, l.delivery_time_start, l.delivery_time_end,
        l.status as load_status, l.distance_miles, l.weight_lbs,
        l.special_requirements,
        poster_org.name as shipper_org_name,
        poster_org.org_type as shipper_org_type,
        CONCAT(shipper.first_name, ' ', shipper.last_name) as shipper_contact_name,
        shipper.phone as shipper_phone,
        CONCAT(dispatcher.first_name, ' ', dispatcher.last_name) as dispatcher_name,
        dispatcher.phone as dispatcher_phone
       FROM assignments a
       JOIN loads l ON a.load_id = l.id
       LEFT JOIN orgs poster_org ON l.posted_by_org_id = poster_org.id
       LEFT JOIN users shipper ON l.shipper_id = shipper.id
       LEFT JOIN users dispatcher ON a.dispatcher_user_id = dispatcher.id
       WHERE a.driver_user_id = $1 
         AND a.status IN ('pending', 'confirmed', 'in_progress')
       ORDER BY a.assigned_at DESC
       LIMIT 1`,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No active assignment' });
    }

    const a = result.rows[0];

    res.json({
      assignment: {
        id: a.id,
        status: a.status,
        carrierPay: parseFloat(a.carrier_pay),
        assignedAt: a.assigned_at,
        confirmedAt: a.confirmed_at,
        startedAt: a.started_at,
        load: {
          id: a.load_id,
          description: a.description,
          status: a.load_status,
          distanceMiles: parseFloat(a.distance_miles),
          weightLbs: a.weight_lbs,
          specialRequirements: a.special_requirements,
          pickup: {
            address: a.pickup_address,
            city: a.pickup_city,
            state: a.pickup_state,
            zip: a.pickup_zip,
            lat: a.pickup_lat ? parseFloat(a.pickup_lat) : null,
            lng: a.pickup_lng ? parseFloat(a.pickup_lng) : null,
            contactName: a.pickup_contact_name,
            contactPhone: a.pickup_contact_phone,
            date: a.pickup_date,
            timeStart: a.pickup_time_start,
            timeEnd: a.pickup_time_end,
          },
          delivery: {
            address: a.delivery_address,
            city: a.delivery_city,
            state: a.delivery_state,
            zip: a.delivery_zip,
            lat: a.delivery_lat ? parseFloat(a.delivery_lat) : null,
            lng: a.delivery_lng ? parseFloat(a.delivery_lng) : null,
            contactName: a.delivery_contact_name,
            contactPhone: a.delivery_contact_phone,
            date: a.delivery_date,
            timeStart: a.delivery_time_start,
            timeEnd: a.delivery_time_end,
          },
        },
        shipper: {
          orgName: a.shipper_org_name,
          orgType: a.shipper_org_type,
          contactName: a.shipper_contact_name,
          phone: a.shipper_phone,
        },
        dispatcher: {
          name: a.dispatcher_name,
          phone: a.dispatcher_phone,
        },
      },
    });
  } catch (error) {
    console.error('[Assignments] Active error:', error);
    res.status(500).json({ error: 'Failed to get active assignment' });
  }
});

/**
 * GET /assignments/:id
 * Get single assignment details
 */
router.get('/:id', authenticate, async (req, res) => {
  try {
    const userOrg = await getUserPrimaryOrg(req.user.id);

    const result = await pool.query(
      `SELECT a.*,
        l.description, l.pickup_city, l.pickup_state, l.pickup_address,
        l.delivery_city, l.delivery_state, l.delivery_address,
        l.pickup_date, l.pickup_time_start, l.delivery_date,
        l.status as load_status, l.distance_miles, l.shipper_id,
        poster_org.name as shipper_org_name,
        CONCAT(driver.first_name, ' ', driver.last_name) as driver_name,
        driver.phone as driver_phone,
        CONCAT(dispatcher.first_name, ' ', dispatcher.last_name) as dispatcher_name
       FROM assignments a
       JOIN loads l ON a.load_id = l.id
       LEFT JOIN orgs poster_org ON l.posted_by_org_id = poster_org.id
       LEFT JOIN users driver ON a.driver_user_id = driver.id
       LEFT JOIN users dispatcher ON a.dispatcher_user_id = dispatcher.id
       WHERE a.id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Assignment not found' });
    }

    const assignment = result.rows[0];

    // Check authorization
    const isDriver = assignment.driver_user_id === req.user.id;
    const isCarrierMember = userOrg?.org_id === assignment.carrier_org_id;

    if (!isDriver && !isCarrierMember) {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.json({
      assignment: formatAssignmentResponse(assignment),
    });
  } catch (error) {
    console.error('[Assignments] Get error:', error);
    res.status(500).json({ error: 'Failed to get assignment' });
  }
});

/**
 * PUT /assignments/:id/confirm
 * Driver confirms/accepts the assignment
 */
router.put('/:id/confirm', authenticate, async (req, res) => {
  try {
    // Get assignment and verify driver
    const result = await pool.query(
      `SELECT a.*, l.delivery_city, l.pickup_city
       FROM assignments a
       JOIN loads l ON a.load_id = l.id
       WHERE a.id = $1 AND a.driver_user_id = $2`,
      [req.params.id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Assignment not found' });
    }

    const assignment = result.rows[0];

    if (assignment.status !== 'pending') {
      return res.status(400).json({ error: `Cannot confirm assignment with status: ${assignment.status}` });
    }

    // Update assignment
    await pool.query(
      `UPDATE assignments SET status = 'confirmed', confirmed_at = NOW() WHERE id = $1`,
      [req.params.id]
    );

    // Notify dispatcher
    if (notificationService && assignment.dispatcher_user_id) {
      try {
        if (typeof notificationService.sendToUser === 'function') {
          const driverResult = await pool.query(
            'SELECT first_name, last_name FROM users WHERE id = $1',
            [req.user.id]
          );
          const driverName = driverResult.rows[0] 
            ? `${driverResult.rows[0].first_name} ${driverResult.rows[0].last_name}`.trim()
            : 'Driver';
            
          notificationService.sendToUser(assignment.dispatcher_user_id, 'Assignment Confirmed',
            `${driverName} confirmed the load to ${assignment.delivery_city}`,
            { type: 'assignment_confirmed', assignmentId: req.params.id, loadId: assignment.load_id }
          );
        }
      } catch (err) {
        console.error('[Assignments] Notification error:', err);
      }
    }

    res.json({
      message: 'Assignment confirmed',
      assignment: { id: req.params.id, status: 'confirmed' },
    });
  } catch (error) {
    console.error('[Assignments] Confirm error:', error);
    res.status(500).json({ error: 'Failed to confirm assignment' });
  }
});

/**
 * PUT /assignments/:id/reject
 * Driver rejects the assignment
 */
router.put('/:id/reject', authenticate, async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { reason } = req.body;

    // Get assignment and verify driver
    const result = await pool.query(
      `SELECT a.*, l.delivery_city
       FROM assignments a
       JOIN loads l ON a.load_id = l.id
       WHERE a.id = $1 AND a.driver_user_id = $2`,
      [req.params.id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Assignment not found' });
    }

    const assignment = result.rows[0];

    if (assignment.status !== 'pending') {
      return res.status(400).json({ error: `Cannot reject assignment with status: ${assignment.status}` });
    }

    await client.query('BEGIN');

    // Update assignment (use 'cancelled' since 'rejected' isn't allowed)
    await client.query(
      `UPDATE assignments SET status = 'cancelled' WHERE id = $1`,
      [req.params.id]
    );

    // Remove driver from load
    await client.query(
      `UPDATE loads SET driver_id = NULL, updated_at = NOW() WHERE id = $1`,
      [assignment.load_id]
    );

    await client.query('COMMIT');

    // Notify dispatcher
    if (notificationService && assignment.dispatcher_user_id) {
      try {
        if (typeof notificationService.sendToUser === 'function') {
          notificationService.sendToUser(assignment.dispatcher_user_id, 'Assignment Rejected',
            `Driver rejected the load to ${assignment.delivery_city}${reason ? `: ${reason}` : ''}`,
            { type: 'assignment_rejected', assignmentId: req.params.id, loadId: assignment.load_id }
          );
        }
      } catch (err) {
        console.error('[Assignments] Notification error:', err);
      }
    }

    res.json({
      message: 'Assignment rejected',
      assignment: { id: req.params.id, status: 'cancelled' },
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[Assignments] Reject error:', error);
    res.status(500).json({ error: 'Failed to reject assignment' });
  } finally {
    client.release();
  }
});

/**
 * PUT /assignments/:id/start
 * Driver starts the assignment (en route to pickup)
 */
router.put('/:id/start', authenticate, async (req, res) => {
  const client = await pool.connect();
  
  try {
    // Get assignment and verify driver
    const result = await pool.query(
      `SELECT a.*, l.shipper_id, l.delivery_city
       FROM assignments a
       JOIN loads l ON a.load_id = l.id
       WHERE a.id = $1 AND a.driver_user_id = $2`,
      [req.params.id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Assignment not found' });
    }

    const assignment = result.rows[0];

    if (assignment.status !== 'confirmed') {
      return res.status(400).json({ error: `Cannot start assignment with status: ${assignment.status}` });
    }

    await client.query('BEGIN');

    // Update assignment
    await client.query(
      `UPDATE assignments SET status = 'in_progress', started_at = NOW() WHERE id = $1`,
      [req.params.id]
    );

    // Update load status
    await client.query(
      `UPDATE loads SET status = 'en_route_pickup', updated_at = NOW() WHERE id = $1`,
      [assignment.load_id]
    );

    await client.query('COMMIT');

    // Notify shipper
    if (notificationService && assignment.shipper_id) {
      try {
        if (typeof notificationService.sendToUser === 'function') {
          notificationService.sendToUser(assignment.shipper_id, 'Driver En Route',
            `Driver is heading to pickup for your load to ${assignment.delivery_city}`,
            { type: 'driver_en_route', assignmentId: req.params.id, loadId: assignment.load_id }
          );
        }
      } catch (err) {
        console.error('[Assignments] Notification error:', err);
      }
    }

    res.json({
      message: 'Assignment started',
      assignment: { id: req.params.id, status: 'in_progress' },
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[Assignments] Start error:', error);
    res.status(500).json({ error: 'Failed to start assignment' });
  } finally {
    client.release();
  }
});

/**
 * PUT /assignments/:id/complete
 * Mark assignment as completed (after delivery)
 */
router.put('/:id/complete', authenticate, async (req, res) => {
  const client = await pool.connect();
  
  try {
    const userOrg = await getUserPrimaryOrg(req.user.id);

    // Get assignment
    const result = await pool.query(
      `SELECT a.*, l.shipper_id, l.delivery_city
       FROM assignments a
       JOIN loads l ON a.load_id = l.id
       WHERE a.id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Assignment not found' });
    }

    const assignment = result.rows[0];

    // Check authorization (driver or carrier admin)
    const isDriver = assignment.driver_user_id === req.user.id;
    const isCarrierAdmin = userOrg?.org_id === assignment.carrier_org_id && 
                          ['carrier_admin', 'dispatcher'].includes(userOrg.role);

    if (!isDriver && !isCarrierAdmin) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (assignment.status !== 'in_progress') {
      return res.status(400).json({ error: `Cannot complete assignment with status: ${assignment.status}` });
    }

    await client.query('BEGIN');

    // Update assignment
    await client.query(
      `UPDATE assignments SET status = 'completed', completed_at = NOW() WHERE id = $1`,
      [req.params.id]
    );

    // Update load status
    await client.query(
      `UPDATE loads SET status = 'delivered', delivered_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [assignment.load_id]
    );

    await client.query('COMMIT');

    res.json({
      message: 'Assignment completed',
      assignment: { id: req.params.id, status: 'completed' },
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[Assignments] Complete error:', error);
    res.status(500).json({ error: 'Failed to complete assignment' });
  } finally {
    client.release();
  }
});

/**
 * PUT /assignments/:id/cancel
 * Cancel an assignment (dispatcher only)
 */
router.put('/:id/cancel', authenticate, async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { reason } = req.body;
    const userOrg = await getUserPrimaryOrg(req.user.id);

    if (!userOrg || userOrg.org_type !== 'carrier') {
      return res.status(403).json({ error: 'Only carrier members can cancel assignments' });
    }

    if (!['carrier_admin', 'dispatcher'].includes(userOrg.role)) {
      return res.status(403).json({ error: 'You do not have permission to cancel assignments' });
    }

    // Get assignment
    const result = await pool.query(
      `SELECT a.*, l.delivery_city
       FROM assignments a
       JOIN loads l ON a.load_id = l.id
       WHERE a.id = $1 AND a.carrier_org_id = $2`,
      [req.params.id, userOrg.org_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Assignment not found' });
    }

    const assignment = result.rows[0];

    if (!['pending', 'confirmed'].includes(assignment.status)) {
      return res.status(400).json({ error: `Cannot cancel assignment with status: ${assignment.status}` });
    }

    await client.query('BEGIN');

    // Update assignment
    await client.query(
      `UPDATE assignments SET status = 'cancelled' WHERE id = $1`,
      [req.params.id]
    );

    // Remove driver from load (load stays assigned to carrier)
    await client.query(
      `UPDATE loads SET driver_id = NULL, updated_at = NOW() WHERE id = $1`,
      [assignment.load_id]
    );

    await client.query('COMMIT');

    // Notify driver
    if (notificationService && assignment.driver_user_id) {
      try {
        if (typeof notificationService.sendToUser === 'function') {
          notificationService.sendToUser(assignment.driver_user_id, 'Assignment Cancelled',
            `Your assignment to ${assignment.delivery_city} has been cancelled${reason ? `: ${reason}` : ''}`,
            { type: 'assignment_cancelled', assignmentId: req.params.id, loadId: assignment.load_id }
          );
        }
      } catch (err) {
        console.error('[Assignments] Notification error:', err);
      }
    }

    res.json({
      message: 'Assignment cancelled',
      assignment: { id: req.params.id, status: 'cancelled' },
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[Assignments] Cancel error:', error);
    res.status(500).json({ error: 'Failed to cancel assignment' });
  } finally {
    client.release();
  }
});

/**
 * GET /assignments/drivers/available
 * Get available drivers in carrier org (for dispatcher to assign)
 */
router.get('/drivers/available', authenticate, async (req, res) => {
  try {
    const userOrg = await getUserPrimaryOrg(req.user.id);

    if (!userOrg || userOrg.org_type !== 'carrier') {
      return res.status(403).json({ error: 'Only carrier members can view drivers' });
    }

    // Get all drivers in org without active assignments
    const result = await pool.query(
      `SELECT u.id, u.first_name, u.last_name, u.phone, u.email,
        u.vehicle_type, u.license_plate,
        u.driver_lat, u.driver_lng, u.location_updated_at,
        u.is_available, u.rating, u.total_deliveries
       FROM users u
       JOIN memberships m ON u.id = m.user_id
       WHERE m.org_id = $1 AND m.role = 'driver' AND m.is_active = true
       AND u.id NOT IN (
         SELECT driver_user_id FROM assignments 
         WHERE status IN ('assigned', 'confirmed', 'in_progress')
       )
       ORDER BY u.is_available DESC, u.rating DESC`,
      [userOrg.org_id]
    );

    res.json({
      drivers: result.rows.map(d => ({
        id: d.id,
        name: `${d.first_name} ${d.last_name}`.trim(),
        firstName: d.first_name,
        lastName: d.last_name,
        phone: d.phone,
        email: d.email,
        vehicleType: d.vehicle_type,
        licensePlate: d.license_plate,
        isAvailable: d.is_available,
        rating: d.rating ? parseFloat(d.rating) : null,
        totalDeliveries: d.total_deliveries || 0,
        location: d.driver_lat && d.driver_lng ? {
          lat: parseFloat(d.driver_lat),
          lng: parseFloat(d.driver_lng),
          updatedAt: d.location_updated_at,
        } : null,
      })),
      count: result.rows.length,
    });
  } catch (error) {
    console.error('[Assignments] Available drivers error:', error);
    res.status(500).json({ error: 'Failed to get available drivers' });
  }
});

/**
 * Helper: Format assignment response
 */
function formatAssignmentResponse(a, load = null, driver = null) {
  return {
    id: a.id,
    loadId: a.load_id,
    carrierOrgId: a.carrier_org_id,
    driverUserId: a.driver_user_id,
    driverName: a.driver_name || (driver ? `${driver.first_name} ${driver.last_name}`.trim() : null),
    driverPhone: a.driver_phone || driver?.phone,
    dispatcherUserId: a.dispatcher_user_id,
    dispatcherName: a.dispatcher_name,
    carrierPay: a.carrier_pay ? parseFloat(a.carrier_pay) : null,
    status: a.status,
    assignedAt: a.assigned_at,
    confirmedAt: a.confirmed_at,
    startedAt: a.started_at,
    completedAt: a.completed_at,
    // Load info
    loadDescription: a.description || load?.description,
    pickupCity: a.pickup_city || load?.pickup_city,
    pickupState: a.pickup_state || load?.pickup_state,
    pickupAddress: a.pickup_address || load?.pickup_address,
    pickupDate: a.pickup_date || load?.pickup_date,
    deliveryCity: a.delivery_city || load?.delivery_city,
    deliveryState: a.delivery_state || load?.delivery_state,
    deliveryAddress: a.delivery_address || load?.delivery_address,
    deliveryDate: a.delivery_date || load?.delivery_date,
    loadStatus: a.load_status || load?.status,
    distanceMiles: a.distance_miles ? parseFloat(a.distance_miles) : null,
    shipperOrgName: a.shipper_org_name,
  };
}

module.exports = router;
