/**
 * Invoice Routes - PDF generation endpoints
 * GET /api/invoices/load/:loadId - Shipper invoice for a load
 * GET /api/invoices/driver/statement - Driver earnings statement
 * GET /api/invoices/dispatcher/statement - Dispatcher commission statement
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');
const {
  generateShipperInvoice,
  generateDriverStatement,
  generateDispatcherStatement,
} = require('../services/invoiceService');

// ═══════════════════════════════════════════════════════════════════════════════
// SHIPPER INVOICE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /invoices/load/:loadId
 * Generate/retrieve invoice PDF for a completed load (shipper)
 */
router.get('/load/:loadId', authenticate, async (req, res) => {
  try {
    const { loadId } = req.params;
    
    // Get load with shipper info
    const loadResult = await pool.query(`
      SELECT 
        l.*,
        s.id as shipper_id, s.first_name, s.last_name, s.email, s.phone,
        s.company_name
      FROM loads l
      JOIN users s ON l.shipper_id = s.id
      WHERE l.id = $1
    `, [loadId]);
    
    if (loadResult.rows.length === 0) {
      return res.status(404).json({ error: 'Load not found' });
    }
    
    const load = loadResult.rows[0];
    
    // Verify user owns this load or is admin
    if (load.shipper_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized to view this invoice' });
    }
    
    // Check if load is completed
    if (!['delivered', 'completed'].includes(load.status)) {
      return res.status(400).json({ error: 'Invoice only available for completed loads' });
    }
    
    // Get payment info
    const paymentResult = await pool.query(`
      SELECT * FROM payments 
      WHERE load_id = $1 AND status IN ('captured', 'transferred')
      ORDER BY created_at DESC LIMIT 1
    `, [loadId]);
    
    const payment = paymentResult.rows[0] || null;
    
    // Generate shipper object
    const shipper = {
      id: load.shipper_id,
      first_name: load.first_name,
      last_name: load.last_name,
      email: load.email,
      phone: load.phone,
      company_name: load.company_name,
    };
    
    // Generate PDF
    const { url } = await generateShipperInvoice(load, shipper, payment);
    
    res.json({
      invoiceUrl: url,
      loadId: load.id,
      amount: load.price,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[Invoice] Shipper invoice error:', error);
    res.status(500).json({ error: 'Failed to generate invoice' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// DRIVER EARNINGS STATEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /invoices/driver/statement
 * Generate earnings statement for driver
 * Query params: startDate, endDate (defaults to current month)
 */
router.get('/driver/statement', authenticate, async (req, res) => {
  try {
    // Only drivers can access
    if (req.user.role !== 'driver') {
      return res.status(403).json({ error: 'Only drivers can access earnings statements' });
    }
    
    // Parse dates
    const now = new Date();
    const startDate = req.query.startDate 
      ? new Date(req.query.startDate) 
      : new Date(now.getFullYear(), now.getMonth(), 1);
    const endDate = req.query.endDate 
      ? new Date(req.query.endDate) 
      : new Date(now.getFullYear(), now.getMonth() + 1, 0);
    
    // Get driver info
    const driverResult = await pool.query(`
      SELECT id, first_name, last_name, email, phone, vehicle_type
      FROM users WHERE id = $1
    `, [req.user.id]);
    
    const driver = driverResult.rows[0];
    
    // Get completed loads in date range
    const loadsResult = await pool.query(`
      SELECT 
        l.id, l.status, l.pickup_city, l.pickup_state,
        l.delivery_city, l.delivery_state, l.distance_miles,
        l.price, l.driver_payout, l.driver_net_payout,
        l.dispatcher_commission, l.delivered_at, l.completed_at
      FROM loads l
      WHERE l.driver_id = $1
        AND l.status IN ('delivered', 'completed')
        AND (l.delivered_at >= $2 OR l.completed_at >= $2)
        AND (l.delivered_at <= $3 OR l.completed_at <= $3)
      ORDER BY COALESCE(l.delivered_at, l.completed_at) DESC
    `, [req.user.id, startDate, endDate]);
    
    const loads = loadsResult.rows;
    
    if (loads.length === 0) {
      return res.json({
        message: 'No completed loads in this period',
        statementUrl: null,
        summary: {
          totalLoads: 0,
          totalEarnings: 0,
          totalMiles: 0,
        },
      });
    }
    
    // Generate PDF
    const { url } = await generateDriverStatement(driver, loads, startDate, endDate);
    
    // Calculate summary
    const totalEarnings = loads.reduce((sum, l) => sum + (parseFloat(l.driver_net_payout || l.driver_payout) || 0), 0);
    const totalMiles = loads.reduce((sum, l) => sum + (parseFloat(l.distance_miles) || 0), 0);
    
    res.json({
      statementUrl: url,
      period: {
        start: startDate.toISOString(),
        end: endDate.toISOString(),
      },
      summary: {
        totalLoads: loads.length,
        totalEarnings,
        totalMiles,
      },
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[Invoice] Driver statement error:', error);
    res.status(500).json({ error: 'Failed to generate statement' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// DISPATCHER COMMISSION STATEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /invoices/dispatcher/statement
 * Generate commission statement for dispatcher
 * Query params: startDate, endDate (defaults to current month)
 */
router.get('/dispatcher/statement', authenticate, async (req, res) => {
  try {
    // Only dispatchers can access
    const dispatcherCheck = await pool.query(
      'SELECT is_dispatcher, dispatcher_company_name FROM users WHERE id = $1',
      [req.user.id]
    );
    
    if (!dispatcherCheck.rows[0]?.is_dispatcher) {
      return res.status(403).json({ error: 'Only dispatchers can access commission statements' });
    }
    
    // Parse dates
    const now = new Date();
    const startDate = req.query.startDate 
      ? new Date(req.query.startDate) 
      : new Date(now.getFullYear(), now.getMonth(), 1);
    const endDate = req.query.endDate 
      ? new Date(req.query.endDate) 
      : new Date(now.getFullYear(), now.getMonth() + 1, 0);
    
    // Get dispatcher info
    const dispatcherResult = await pool.query(`
      SELECT id, first_name, last_name, email, dispatcher_company_name
      FROM users WHERE id = $1
    `, [req.user.id]);
    
    const dispatcher = dispatcherResult.rows[0];
    
    // Get completed loads assigned by this dispatcher
    const loadsResult = await pool.query(`
      SELECT 
        l.id, l.status, l.pickup_city, l.delivery_city,
        l.price, l.driver_payout, l.dispatcher_commission,
        l.dispatcher_commission_rate, l.delivered_at, l.completed_at,
        l.driver_id,
        d.first_name || ' ' || COALESCE(d.last_name, '') as driver_name
      FROM loads l
      JOIN users d ON l.driver_id = d.id
      WHERE l.accepted_by_dispatcher_id = $1
        AND l.status IN ('delivered', 'completed')
        AND (l.delivered_at >= $2 OR l.completed_at >= $2)
        AND (l.delivered_at <= $3 OR l.completed_at <= $3)
      ORDER BY COALESCE(l.delivered_at, l.completed_at) DESC
    `, [req.user.id, startDate, endDate]);
    
    const loads = loadsResult.rows;
    
    if (loads.length === 0) {
      return res.json({
        message: 'No completed loads in this period',
        statementUrl: null,
        summary: {
          totalLoads: 0,
          totalCommission: 0,
          uniqueDrivers: 0,
        },
      });
    }
    
    // Generate PDF
    const { url } = await generateDispatcherStatement(dispatcher, loads, startDate, endDate);
    
    // Calculate summary
    const totalCommission = loads.reduce((sum, l) => sum + (parseFloat(l.dispatcher_commission) || 0), 0);
    const uniqueDrivers = new Set(loads.map(l => l.driver_id)).size;
    
    res.json({
      statementUrl: url,
      period: {
        start: startDate.toISOString(),
        end: endDate.toISOString(),
      },
      summary: {
        totalLoads: loads.length,
        totalCommission,
        uniqueDrivers,
      },
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[Invoice] Dispatcher statement error:', error);
    res.status(500).json({ error: 'Failed to generate statement' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// BATCH EXPORT (for tax purposes)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /invoices/export
 * Export all statements for a year (1099 preparation)
 * Query params: year (defaults to current year)
 */
router.get('/export', authenticate, async (req, res) => {
  try {
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const startDate = new Date(year, 0, 1);
    const endDate = new Date(year, 11, 31);
    
    // Get user info
    const userResult = await pool.query(
      'SELECT id, role, is_dispatcher FROM users WHERE id = $1',
      [req.user.id]
    );
    const user = userResult.rows[0];
    
    let statementUrl = null;
    let summary = {};
    
    if (user.role === 'driver') {
      // Get driver's completed loads for the year
      const loadsResult = await pool.query(`
        SELECT 
          l.id, l.pickup_city, l.delivery_city, l.distance_miles,
          l.driver_payout, l.driver_net_payout, l.delivered_at, l.completed_at
        FROM loads l
        WHERE l.driver_id = $1
          AND l.status IN ('delivered', 'completed')
          AND EXTRACT(YEAR FROM COALESCE(l.delivered_at, l.completed_at)) = $2
        ORDER BY COALESCE(l.delivered_at, l.completed_at) ASC
      `, [req.user.id, year]);
      
      const loads = loadsResult.rows;
      const totalEarnings = loads.reduce((sum, l) => sum + (parseFloat(l.driver_net_payout || l.driver_payout) || 0), 0);
      
      summary = {
        year,
        type: 'driver',
        totalLoads: loads.length,
        totalEarnings,
        requiresForm1099: totalEarnings >= 600,
      };
      
      if (loads.length > 0) {
        const driverResult = await pool.query(
          'SELECT id, first_name, last_name, email, vehicle_type FROM users WHERE id = $1',
          [req.user.id]
        );
        const { url } = await generateDriverStatement(driverResult.rows[0], loads, startDate, endDate);
        statementUrl = url;
      }
    } else if (user.is_dispatcher) {
      // Get dispatcher's commission for the year
      const loadsResult = await pool.query(`
        SELECT 
          l.id, l.pickup_city, l.delivery_city, l.dispatcher_commission,
          l.dispatcher_commission_rate, l.delivered_at, l.completed_at,
          l.driver_id,
          d.first_name || ' ' || COALESCE(d.last_name, '') as driver_name
        FROM loads l
        JOIN users d ON l.driver_id = d.id
        WHERE l.accepted_by_dispatcher_id = $1
          AND l.status IN ('delivered', 'completed')
          AND EXTRACT(YEAR FROM COALESCE(l.delivered_at, l.completed_at)) = $2
        ORDER BY COALESCE(l.delivered_at, l.completed_at) ASC
      `, [req.user.id, year]);
      
      const loads = loadsResult.rows;
      const totalCommission = loads.reduce((sum, l) => sum + (parseFloat(l.dispatcher_commission) || 0), 0);
      
      summary = {
        year,
        type: 'dispatcher',
        totalLoads: loads.length,
        totalCommission,
        requiresForm1099: totalCommission >= 600,
      };
      
      if (loads.length > 0) {
        const dispatcherResult = await pool.query(
          'SELECT id, first_name, last_name, email, dispatcher_company_name FROM users WHERE id = $1',
          [req.user.id]
        );
        const { url } = await generateDispatcherStatement(dispatcherResult.rows[0], loads, startDate, endDate);
        statementUrl = url;
      }
    } else {
      return res.status(400).json({ error: 'Export only available for drivers and dispatchers' });
    }
    
    res.json({
      statementUrl,
      summary,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[Invoice] Export error:', error);
    res.status(500).json({ error: 'Failed to export statements' });
  }
});

module.exports = router;
