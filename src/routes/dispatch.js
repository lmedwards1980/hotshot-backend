/**
 * Dispatch Routes
 * Routes for managing carrier fleet and dispatch operations
 * Mounted at /api/dispatch
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../db/pool');
const { authenticate } = require('../middleware/auth');

// Helper to get user's primary org
async function getUserPrimaryOrg(userId) {
  const result = await pool.query(`
    SELECT m.org_id, m.role, o.name as org_name, o.org_type
    FROM memberships m
    JOIN orgs o ON m.org_id = o.id
    WHERE m.user_id = $1 AND m.is_primary = true
    LIMIT 1
  `, [userId]);
  return result.rows[0] || null;
}

/**
 * GET /dispatch/drivers
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

    // Get all drivers in this carrier org - using actual column names
    const result = await pool.query(`
      SELECT 
        u.id,
        u.email,
        u.phone,
        u.first_name,
        u.last_name,
        CONCAT(u.first_name, ' ', u.last_name) as name,
        u.vehicle_type,
        u.average_rating,
        u.total_ratings,
        u.is_active,
        m.role as org_role
      FROM users u
      JOIN memberships m ON u.id = m.user_id
      WHERE m.org_id = $1
      AND m.role IN ('driver', 'carrier_admin', 'owner')
      ORDER BY u.first_name ASC
    `, [userOrg.org_id]);

    const drivers = result.rows.map(d => ({
      id: d.id,
      email: d.email,
      phone: d.phone,
      firstName: d.first_name,
      lastName: d.last_name,
      name: d.name || `${d.first_name || ''} ${d.last_name || ''}`.trim() || 'Unknown',
      vehicleType: d.vehicle_type || 'Not specified',
      licensePlate: '',
      isAvailable: d.is_active ?? true,
      totalDeliveries: parseInt(d.total_ratings) || 0,
      rating: parseFloat(d.average_rating) || 5.0,
      currentLoadId: null,
      orgRole: d.org_role,
    }));

    res.json({ 
      drivers,
      count: drivers.length,
      availableCount: drivers.filter(d => d.isAvailable).length,
    });
  } catch (error) {
    console.error('[Dispatch] Get drivers error:', error);
    res.status(500).json({ error: 'Failed to fetch drivers', details: error.message });
  }
});

/**
 * GET /dispatch/loads
 * Get loads assigned to this carrier that need driver assignment
 */
router.get('/loads', authenticate, async (req, res) => {
  try {
    const userOrg = await getUserPrimaryOrg(req.user.id);
    
    if (!userOrg || userOrg.org_type !== 'carrier') {
      return res.status(403).json({ error: 'Only carrier organizations can view dispatch loads' });
    }

    // Get loads assigned to this carrier that don't have a driver yet
    const result = await pool.query(`
      SELECT 
        l.id,
        l.description,
        l.pickup_city,
        l.pickup_state,
        l.pickup_address,
        l.pickup_date,
        l.delivery_city,
        l.delivery_state,
        l.delivery_address,
        l.delivery_date,
        l.price,
        l.carrier_pay,
        l.driver_payout,
        l.distance_miles,
        l.status,
        l.driver_id,
        poster_org.name as shipper_org_name,
        CONCAT(driver.first_name, ' ', driver.last_name) as driver_name
      FROM loads l
      LEFT JOIN orgs poster_org ON l.posted_by_org_id = poster_org.id
      LEFT JOIN users driver ON l.driver_id = driver.id
      WHERE l.assigned_carrier_org_id = $1
      AND l.status IN ('assigned', 'en_route_pickup', 'picked_up', 'en_route_delivery')
      ORDER BY 
        CASE WHEN l.driver_id IS NULL THEN 0 ELSE 1 END,
        l.pickup_date ASC NULLS LAST,
        l.created_at DESC
    `, [userOrg.org_id]);

    const loads = result.rows.map(l => ({
      id: l.id,
      loadId: l.id,
      description: l.description,
      pickupCity: l.pickup_city,
      pickupState: l.pickup_state,
      pickupAddress: l.pickup_address,
      pickupDate: l.pickup_date,
      deliveryCity: l.delivery_city,
      deliveryState: l.delivery_state,
      deliveryAddress: l.delivery_address,
      deliveryDate: l.delivery_date,
      price: parseFloat(l.price) || 0,
      carrierPay: parseFloat(l.carrier_pay) || parseFloat(l.driver_payout) || 0,
      distanceMiles: parseFloat(l.distance_miles) || 0,
      status: l.status,
      driverId: l.driver_id,
      driverName: l.driver_name,
      shipperOrgName: l.shipper_org_name,
      needsDriver: !l.driver_id,
    }));

    const unassigned = loads.filter(l => l.needsDriver);
    const assigned = loads.filter(l => !l.needsDriver);

    res.json({ 
      loads,
      unassigned,
      assigned,
      count: loads.length,
      unassignedCount: unassigned.length,
    });
  } catch (error) {
    console.error('[Dispatch] Get loads error:', error);
    res.status(500).json({ error: 'Failed to fetch loads', details: error.message });
  }
});

/**
 * GET /dispatch/stats
 * Get organization statistics
 */
router.get('/stats', authenticate, async (req, res) => {
  try {
    const userOrg = await getUserPrimaryOrg(req.user.id);
    
    if (!userOrg || userOrg.org_type !== 'carrier') {
      return res.status(403).json({ error: 'Stats only available for carrier organizations' });
    }

    const driversResult = await pool.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE u.is_active = true) as available
      FROM users u
      JOIN memberships m ON u.id = m.user_id
      WHERE m.org_id = $1 AND m.role IN ('driver', 'carrier_admin', 'owner')
    `, [userOrg.org_id]);

    const offersResult = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status = 'pending') as pending,
        COUNT(*) FILTER (WHERE status IN ('accepted', 'counter_accepted')) as won
      FROM offers
      WHERE carrier_org_id = $1
    `, [userOrg.org_id]);

    res.json({
      drivers: {
        total: parseInt(driversResult.rows[0]?.total) || 0,
        available: parseInt(driversResult.rows[0]?.available) || 0,
      },
      offers: {
        pending: parseInt(offersResult.rows[0]?.pending) || 0,
        won: parseInt(offersResult.rows[0]?.won) || 0,
      },
    });
  } catch (error) {
    console.error('[Dispatch] Get stats error:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

module.exports = router;
