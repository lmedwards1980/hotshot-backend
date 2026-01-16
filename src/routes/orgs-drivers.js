/**
 * GET /orgs/drivers
 * Get all drivers in the user's carrier organization
 * Only accessible by carrier_admin and dispatcher roles
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');

// Helper to get user's primary org
async function getUserPrimaryOrg(userId) {
  const result = await pool.query(`
    SELECT om.org_id, om.role, o.name as org_name, o.org_type
    FROM org_memberships om
    JOIN orgs o ON om.org_id = o.id
    WHERE om.user_id = $1 AND om.is_primary = true
    LIMIT 1
  `, [userId]);
  return result.rows[0] || null;
}

/**
 * GET /orgs/drivers
 * List all drivers in the carrier organization
 */
router.get('/drivers', authenticate, async (req, res) => {
  try {
    const userOrg = await getUserPrimaryOrg(req.user.id);
    
    if (!userOrg) {
      return res.status(400).json({ error: 'User is not part of any organization' });
    }

    if (userOrg.org_type !== 'carrier') {
      return res.status(403).json({ error: 'Only carrier organizations have drivers' });
    }

    // Check if user has permission (carrier_admin or dispatcher)
    if (!['carrier_admin', 'dispatcher', 'owner'].includes(userOrg.role)) {
      return res.status(403).json({ error: 'You do not have permission to view drivers' });
    }

    // Get all drivers in this carrier org
    const result = await pool.query(`
      SELECT 
        u.id,
        u.email,
        u.phone,
        u.first_name,
        u.last_name,
        CONCAT(u.first_name, ' ', u.last_name) as name,
        u.vehicle_type,
        u.license_plate,
        u.is_available,
        u.total_deliveries,
        u.rating,
        u.driver_lat,
        u.driver_lng,
        u.location_updated_at,
        om.role as org_role,
        -- Check if driver has an active assignment
        (
          SELECT a.load_id 
          FROM assignments a 
          WHERE a.driver_id = u.id 
          AND a.status IN ('pending', 'confirmed', 'in_progress')
          LIMIT 1
        ) as current_load_id
      FROM users u
      JOIN org_memberships om ON u.id = om.user_id
      WHERE om.org_id = $1
      AND om.role IN ('driver', 'carrier_admin', 'owner')
      ORDER BY 
        CASE WHEN u.is_available = true AND (
          SELECT COUNT(*) FROM assignments a 
          WHERE a.driver_id = u.id AND a.status IN ('pending', 'confirmed', 'in_progress')
        ) = 0 THEN 0 ELSE 1 END,
        u.total_deliveries DESC,
        u.rating DESC
    `, [userOrg.org_id]);

    const drivers = result.rows.map(d => ({
      id: d.id,
      email: d.email,
      phone: d.phone,
      firstName: d.first_name,
      lastName: d.last_name,
      name: d.name,
      vehicleType: d.vehicle_type || 'Not specified',
      licensePlate: d.license_plate || '',
      isAvailable: d.is_available ?? true,
      totalDeliveries: parseInt(d.total_deliveries) || 0,
      rating: parseFloat(d.rating) || 5.0,
      currentLoadId: d.current_load_id || null,
      orgRole: d.org_role,
      location: d.driver_lat && d.driver_lng ? {
        lat: parseFloat(d.driver_lat),
        lng: parseFloat(d.driver_lng),
        updatedAt: d.location_updated_at,
      } : null,
    }));

    res.json({ 
      drivers,
      count: drivers.length,
      availableCount: drivers.filter(d => d.isAvailable && !d.currentLoadId).length,
    });
  } catch (error) {
    console.error('[Orgs] Get drivers error:', error);
    res.status(500).json({ error: 'Failed to fetch drivers' });
  }
});

/**
 * PUT /orgs/drivers/:driverId/availability
 * Update a driver's availability (dispatcher can toggle driver availability)
 */
router.put('/drivers/:driverId/availability', authenticate, async (req, res) => {
  try {
    const { driverId } = req.params;
    const { isAvailable } = req.body;
    
    const userOrg = await getUserPrimaryOrg(req.user.id);
    
    if (!userOrg || userOrg.org_type !== 'carrier') {
      return res.status(403).json({ error: 'Only carrier organizations can manage drivers' });
    }

    if (!['carrier_admin', 'dispatcher', 'owner'].includes(userOrg.role)) {
      return res.status(403).json({ error: 'You do not have permission to manage drivers' });
    }

    // Verify driver is in same org
    const driverCheck = await pool.query(`
      SELECT om.user_id FROM org_memberships om
      WHERE om.user_id = $1 AND om.org_id = $2
    `, [driverId, userOrg.org_id]);

    if (driverCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Driver not found in your organization' });
    }

    await pool.query(`
      UPDATE users SET is_available = $1 WHERE id = $2
    `, [isAvailable, driverId]);

    res.json({ message: 'Driver availability updated', isAvailable });
  } catch (error) {
    console.error('[Orgs] Update driver availability error:', error);
    res.status(500).json({ error: 'Failed to update driver availability' });
  }
});

/**
 * GET /orgs/stats
 * Get organization statistics for dispatcher dashboard
 */
router.get('/stats', authenticate, async (req, res) => {
  try {
    const userOrg = await getUserPrimaryOrg(req.user.id);
    
    if (!userOrg) {
      return res.status(400).json({ error: 'User is not part of any organization' });
    }

    if (userOrg.org_type !== 'carrier') {
      return res.status(403).json({ error: 'Stats only available for carrier organizations' });
    }

    // Get various stats
    const [driversResult, assignmentsResult, offersResult] = await Promise.all([
      // Driver stats
      pool.query(`
        SELECT 
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE u.is_available = true) as available
        FROM users u
        JOIN org_memberships om ON u.id = om.user_id
        WHERE om.org_id = $1 AND om.role IN ('driver', 'carrier_admin', 'owner')
      `, [userOrg.org_id]),
      
      // Assignment stats
      pool.query(`
        SELECT 
          COUNT(*) FILTER (WHERE status = 'pending') as pending,
          COUNT(*) FILTER (WHERE status = 'confirmed') as confirmed,
          COUNT(*) FILTER (WHERE status = 'in_progress') as in_progress,
          COUNT(*) FILTER (WHERE status = 'completed') as completed
        FROM assignments
        WHERE carrier_org_id = $1
      `, [userOrg.org_id]),
      
      // Offer stats
      pool.query(`
        SELECT 
          COUNT(*) FILTER (WHERE status = 'pending') as pending,
          COUNT(*) FILTER (WHERE status IN ('accepted', 'counter_accepted')) as won,
          COUNT(*) FILTER (WHERE status IN ('declined', 'counter_declined', 'expired')) as lost
        FROM offers
        WHERE carrier_org_id = $1
      `, [userOrg.org_id]),
    ]);

    res.json({
      drivers: {
        total: parseInt(driversResult.rows[0]?.total) || 0,
        available: parseInt(driversResult.rows[0]?.available) || 0,
      },
      assignments: {
        pending: parseInt(assignmentsResult.rows[0]?.pending) || 0,
        confirmed: parseInt(assignmentsResult.rows[0]?.confirmed) || 0,
        inProgress: parseInt(assignmentsResult.rows[0]?.in_progress) || 0,
        completed: parseInt(assignmentsResult.rows[0]?.completed) || 0,
      },
      offers: {
        pending: parseInt(offersResult.rows[0]?.pending) || 0,
        won: parseInt(offersResult.rows[0]?.won) || 0,
        lost: parseInt(offersResult.rows[0]?.lost) || 0,
      },
    });
  } catch (error) {
    console.error('[Orgs] Get stats error:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

module.exports = router;
