// Broker Routes - Carrier network & shipper relationship management
const express = require('express');
const { pool } = require('../db/pool');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// ============================================
// MIDDLEWARE: Verify user is a broker
// ============================================

const requireBroker = async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT 
        o.id as org_id,
        o.org_type,
        o.name as org_name,
        o.mc_number,
        o.broker_mc_number,
        m.role,
        m.permissions
      FROM memberships m
      JOIN orgs o ON m.org_id = o.id
      WHERE m.user_id = $1 AND m.is_active = true AND o.is_active = true
      ORDER BY m.is_primary DESC
      LIMIT 1
    `, [req.user.id]);

    if (result.rows.length === 0) {
      return res.status(403).json({ error: 'You must belong to an organization' });
    }

    const org = result.rows[0];

    if (org.org_type !== 'broker') {
      return res.status(403).json({ error: 'This endpoint is for brokers only' });
    }

    req.brokerOrg = {
      id: org.org_id,
      name: org.org_name,
      type: org.org_type,
      mcNumber: org.mc_number || org.broker_mc_number,
      role: org.role,
      permissions: org.permissions
    };

    next();
  } catch (error) {
    console.error('[Broker] Auth error:', error);
    res.status(500).json({ error: 'Authorization failed' });
  }
};

// Helper: Check if broker admin or agent
const requireBrokerAdmin = (req, res, next) => {
  if (!['broker_admin', 'broker_agent'].includes(req.brokerOrg.role)) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  next();
};

// ============================================
// CARRIER NETWORK ROUTES
// ============================================

/**
 * GET /broker/carriers
 * List carriers in broker's network
 */
router.get('/carriers', authenticate, requireBroker, async (req, res) => {
  try {
    const { status, search, preferred, limit = 50, offset = 0 } = req.query;

    let whereClause = 'WHERE bc.broker_org_id = $1';
    const params = [req.brokerOrg.id];
    let paramIndex = 2;

    if (status) {
      whereClause += ` AND bc.status = $${paramIndex++}`;
      params.push(status);
    }

    if (preferred === 'true') {
      whereClause += ' AND bc.is_preferred = true';
    }

    if (search) {
      whereClause += ` AND (
        o.name ILIKE $${paramIndex} OR 
        o.mc_number ILIKE $${paramIndex} OR 
        o.dot_number ILIKE $${paramIndex}
      )`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    const result = await pool.query(`
      SELECT 
        bc.*,
        o.name as carrier_name,
        o.mc_number as carrier_mc,
        o.dot_number as carrier_dot,
        o.city as carrier_city,
        o.state as carrier_state,
        o.verification_status as carrier_verification,
        o.loads_completed as platform_loads,
        o.on_time_rate as platform_on_time,
        (SELECT COUNT(*) FROM memberships WHERE org_id = o.id AND role = 'driver' AND is_active = true) as driver_count
      FROM broker_carriers bc
      JOIN orgs o ON bc.carrier_org_id = o.id
      ${whereClause}
      ORDER BY bc.is_preferred DESC, bc.loads_completed DESC, bc.created_at DESC
      LIMIT $${paramIndex++} OFFSET $${paramIndex}
    `, [...params, limit, offset]);

    // Get counts
    const countResult = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status = 'active') as active_count,
        COUNT(*) FILTER (WHERE status = 'pending') as pending_count,
        COUNT(*) FILTER (WHERE status = 'blocked') as blocked_count,
        COUNT(*) FILTER (WHERE is_preferred = true AND status = 'active') as preferred_count,
        COUNT(*) as total_count
      FROM broker_carriers
      WHERE broker_org_id = $1
    `, [req.brokerOrg.id]);

    res.json({
      carriers: result.rows.map(formatCarrierResponse),
      counts: countResult.rows[0],
      pagination: { limit: parseInt(limit), offset: parseInt(offset) }
    });
  } catch (error) {
    console.error('[Broker] Get carriers error:', error);
    res.status(500).json({ error: 'Failed to get carriers' });
  }
});

/**
 * GET /broker/carriers/search
 * Search carriers on platform (for adding to network)
 * NOTE: This route MUST come before /carriers/:id
 */
router.get('/carriers/search', authenticate, requireBroker, async (req, res) => {
  try {
    const { mc, name, city, state, q, limit = 20 } = req.query;

    // If 'q' is provided (even empty string), do unified search
    if (q !== undefined) {
      const searchTerm = q.trim() ? `%${q}%` : '%';
      const result = await pool.query(`
        SELECT 
          o.id, o.name, o.mc_number, o.dot_number, o.city, o.state,
          o.verification_status, o.loads_completed, o.on_time_rate,
          bc.id as network_record_id,
          bc.status as network_status,
          CASE WHEN bc.id IS NOT NULL THEN true ELSE false END as already_in_network
        FROM orgs o
        LEFT JOIN broker_carriers bc ON bc.carrier_org_id = o.id AND bc.broker_org_id = $1
        WHERE o.org_type = 'carrier' AND o.is_active = true
          ${q.trim() ? `AND (
            o.name ILIKE $2 OR 
            o.city ILIKE $2 OR 
            o.mc_number ILIKE $2 OR
            o.dot_number ILIKE $2
          )` : ''}
        ORDER BY o.loads_completed DESC NULLS LAST, o.name ASC
        LIMIT $${q.trim() ? '3' : '2'}
      `, q.trim() ? [req.brokerOrg.id, searchTerm, limit] : [req.brokerOrg.id, limit]);

      return res.json({ carriers: result.rows });
    }

    // Legacy field-specific search
    if (!mc && !name && !city) {
      return res.status(400).json({ error: 'Provide q, mc, name, or city to search' });
    }

    let whereClause = `WHERE o.org_type = 'carrier' AND o.is_active = true`;
    const params = [];
    let paramIndex = 1;

    if (mc) {
      whereClause += ` AND (o.mc_number ILIKE $${paramIndex} OR o.mc_number ILIKE $${paramIndex + 1})`;
      params.push(`%${mc}%`, `%MC${mc.replace(/\D/g, '')}%`);
      paramIndex += 2;
    }

    if (name) {
      whereClause += ` AND o.name ILIKE $${paramIndex++}`;
      params.push(`%${name}%`);
    }

    if (city) {
      whereClause += ` AND o.city ILIKE $${paramIndex++}`;
      params.push(`%${city}%`);
    }

    if (state) {
      whereClause += ` AND o.state = $${paramIndex++}`;
      params.push(state.toUpperCase());
    }

    params.push(limit);

    const result = await pool.query(`
      SELECT 
        o.id, o.name, o.mc_number, o.dot_number, o.city, o.state,
        o.verification_status, o.loads_completed, o.on_time_rate,
        EXISTS(
          SELECT 1 FROM broker_carriers bc 
          WHERE bc.broker_org_id = $${paramIndex + 1} AND bc.carrier_org_id = o.id
        ) as already_in_network
      FROM orgs o
      ${whereClause}
      ORDER BY o.loads_completed DESC NULLS LAST
      LIMIT $${paramIndex}
    `, [...params, req.brokerOrg.id]);

    res.json({ carriers: result.rows });
  } catch (error) {
    console.error('[Broker] Search carriers error:', error);
    res.status(500).json({ error: 'Failed to search carriers' });
  }
});

/**
 * GET /broker/carriers/org/:orgId
 * Get carrier org details by org ID (for viewing carriers not yet in network)
 * NOTE: This route MUST come before /carriers/:id
 */
router.get('/carriers/org/:orgId', authenticate, requireBroker, async (req, res) => {
  try {
    const { orgId } = req.params;

    // Get org info
    const orgResult = await pool.query(`
      SELECT 
        o.*,
        (SELECT COUNT(*) FROM memberships WHERE org_id = o.id AND role = 'driver' AND is_active = true) as driver_count
      FROM orgs o
      WHERE o.id = $1 AND o.org_type = 'carrier' AND o.is_active = true
    `, [orgId]);

    if (orgResult.rows.length === 0) {
      return res.status(404).json({ error: 'Carrier not found' });
    }

    const org = orgResult.rows[0];

    // Check if already in network
    const networkResult = await pool.query(`
      SELECT id, status, is_preferred, loads_completed, notes
      FROM broker_carriers
      WHERE broker_org_id = $1 AND carrier_org_id = $2
    `, [req.brokerOrg.id, orgId]);

    const inNetwork = networkResult.rows.length > 0;
    const networkRecord = networkResult.rows[0] || null;

    // Get trust signals if available
    const trustResult = await pool.query(`
      SELECT * FROM trust_signals WHERE org_id = $1
    `, [orgId]);
    const trustSignals = trustResult.rows[0] || null;

    res.json({
      carrier: {
        id: org.id,
        name: org.name,
        dbaName: org.dba_name,
        email: org.email,
        phone: org.phone,
        address: org.address,
        city: org.city,
        state: org.state,
        zip: org.zip,
        mcNumber: org.mc_number,
        dotNumber: org.dot_number,
        authorityStatus: org.authority_status,
        verificationStatus: org.verification_status,
        verifiedAt: org.verified_at,
        loadsCompleted: org.loads_completed,
        onTimeRate: org.on_time_rate ? parseFloat(org.on_time_rate) : null,
        claimRate: org.claim_rate ? parseFloat(org.claim_rate) : null,
        driverCount: parseInt(org.driver_count) || 0,
        trustSignals: trustSignals ? {
          totalLoads: trustSignals.total_loads,
          completedLoads: trustSignals.completed_loads,
          cancelledLoads: trustSignals.cancelled_loads,
          onTimePickups: trustSignals.on_time_pickups,
          onTimeDeliveries: trustSignals.on_time_deliveries,
          claimsFiled: trustSignals.claims_filed,
          claimsPaid: trustSignals.claims_paid,
          avgCloseoutHours: trustSignals.avg_closeout_hours ? parseFloat(trustSignals.avg_closeout_hours) : null,
          completionRate: trustSignals.completion_rate ? parseFloat(trustSignals.completion_rate) : null,
          onTimeRate: trustSignals.on_time_rate ? parseFloat(trustSignals.on_time_rate) : null,
          claimRate: trustSignals.claim_rate ? parseFloat(trustSignals.claim_rate) : null,
        } : null,
      },
      inNetwork,
      networkStatus: networkRecord?.status || null,
      networkRecord: networkRecord ? {
        id: networkRecord.id,
        status: networkRecord.status,
        isPreferred: networkRecord.is_preferred,
        loadsCompleted: networkRecord.loads_completed,
        notes: networkRecord.notes,
      } : null,
    });
  } catch (error) {
    console.error('[Broker] Get carrier org error:', error);
    res.status(500).json({ error: 'Failed to get carrier' });
  }
});

/**
 * GET /broker/carriers/:id
 * Get carrier details
 */
router.get('/carriers/:id', authenticate, requireBroker, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        bc.*,
        o.name as carrier_name,
        o.mc_number as carrier_mc,
        o.dot_number as carrier_dot,
        o.city as carrier_city,
        o.state as carrier_state,
        o.email as carrier_email,
        o.phone as carrier_phone,
        o.address as carrier_address,
        o.zip as carrier_zip,
        o.verification_status as carrier_verification,
        o.loads_completed as platform_loads,
        o.on_time_rate as platform_on_time,
        o.claim_rate as platform_claim_rate
      FROM broker_carriers bc
      JOIN orgs o ON bc.carrier_org_id = o.id
      WHERE bc.id = $1 AND bc.broker_org_id = $2
    `, [req.params.id, req.brokerOrg.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Carrier not found' });
    }

    res.json({ carrier: formatCarrierResponse(result.rows[0]) });
  } catch (error) {
    console.error('[Broker] Get carrier error:', error);
    res.status(500).json({ error: 'Failed to get carrier' });
  }
});

/**
 * POST /broker/carriers
 * Send invitation to carrier (requires carrier acceptance)
 */
router.post('/carriers', authenticate, requireBroker, requireBrokerAdmin, async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { carrierOrgId, mcNumber, email, companyName, contactName, message } = req.body;

    // Find carrier org
    let carrierOrg = null;

    if (carrierOrgId) {
      const result = await pool.query(
        `SELECT * FROM orgs WHERE id = $1 AND org_type = 'carrier' AND is_active = true`,
        [carrierOrgId]
      );
      carrierOrg = result.rows[0];
    } else if (mcNumber) {
      const result = await pool.query(
        `SELECT * FROM orgs WHERE (mc_number = $1 OR mc_number = $2) AND org_type = 'carrier' AND is_active = true`,
        [mcNumber, `MC${mcNumber.replace(/\D/g, '')}`]
      );
      carrierOrg = result.rows[0];
    }

    // Check for existing relationship or pending invite
    if (carrierOrg) {
      const existing = await pool.query(
        `SELECT id, status FROM broker_carriers WHERE broker_org_id = $1 AND carrier_org_id = $2`,
        [req.brokerOrg.id, carrierOrg.id]
      );

      if (existing.rows.length > 0) {
        const status = existing.rows[0].status;
        if (status === 'active') {
          return res.status(409).json({ error: 'Carrier already in your network' });
        } else if (status === 'pending_carrier') {
          return res.status(409).json({ error: 'Invitation already sent, waiting for carrier to accept' });
        } else if (status === 'pending_broker') {
          return res.status(409).json({ error: 'Carrier has requested to join - review in your dashboard' });
        }
      }
    }

    await client.query('BEGIN');

    if (carrierOrg) {
      // Carrier exists on platform - create pending invite
      const result = await client.query(`
        INSERT INTO broker_carriers (
          broker_org_id, carrier_org_id, status, invited_by,
          primary_contact_name, notes
        ) VALUES ($1, $2, 'pending_carrier', $3, $4, $5)
        ON CONFLICT (broker_org_id, carrier_org_id) 
        DO UPDATE SET status = 'pending_carrier', invited_by = $3, notes = $5, updated_at = NOW()
        RETURNING *
      `, [req.brokerOrg.id, carrierOrg.id, req.user.id, contactName || null, message || null]);

      await client.query('COMMIT');

      // TODO: Send push notification to carrier about broker invite

      res.status(201).json({
        message: 'Invitation sent - waiting for carrier to accept',
        invite: {
          id: result.rows[0].id,
          carrierOrgId: carrierOrg.id,
          carrierName: carrierOrg.name,
          status: 'pending_carrier'
        }
      });
    } else {
      // Carrier not on platform - create external invite placeholder
      const result = await client.query(`
        INSERT INTO broker_carriers (
          broker_org_id, carrier_org_id, status, invited_by,
          primary_contact_name, primary_contact_email, notes,
          external_mc_number, external_company_name
        ) VALUES ($1, NULL, 'external_invite', $2, $3, $4, $5, $6, $7)
        RETURNING *
      `, [
        req.brokerOrg.id, req.user.id, contactName || null, 
        email || null, message || null, mcNumber || null, companyName || null
      ]);

      await client.query('COMMIT');

      // TODO: Send invitation email if email provided

      res.status(201).json({
        message: email ? 'Invitation email sent' : 'Carrier added for later invitation',
        invite: {
          id: result.rows[0].id,
          status: 'external_invite',
          externalMcNumber: mcNumber,
          externalCompanyName: companyName
        }
      });
    }
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[Broker] Add carrier error:', error);
    res.status(500).json({ error: 'Failed to add carrier' });
  } finally {
    client.release();
  }
});

/**
 * PUT /broker/carriers/:id
 * Update carrier relationship (preferred, notes, etc.)
 */
router.put('/carriers/:id', authenticate, requireBroker, requireBrokerAdmin, async (req, res) => {
  try {
    const { isPreferred, primaryContactName, primaryContactPhone, primaryContactEmail, notes } = req.body;

    const updates = [];
    const params = [];
    let paramIndex = 1;

    if (isPreferred !== undefined) {
      updates.push(`is_preferred = $${paramIndex++}`);
      params.push(isPreferred);
    }
    if (primaryContactName !== undefined) {
      updates.push(`primary_contact_name = $${paramIndex++}`);
      params.push(primaryContactName);
    }
    if (primaryContactPhone !== undefined) {
      updates.push(`primary_contact_phone = $${paramIndex++}`);
      params.push(primaryContactPhone);
    }
    if (primaryContactEmail !== undefined) {
      updates.push(`primary_contact_email = $${paramIndex++}`);
      params.push(primaryContactEmail);
    }
    if (notes !== undefined) {
      updates.push(`notes = $${paramIndex++}`);
      params.push(notes);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No updates provided' });
    }

    updates.push('updated_at = NOW()');
    params.push(req.params.id, req.brokerOrg.id);

    const result = await pool.query(`
      UPDATE broker_carriers 
      SET ${updates.join(', ')}
      WHERE id = $${paramIndex++} AND broker_org_id = $${paramIndex}
      RETURNING *
    `, params);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Carrier not found' });
    }

    res.json({ message: 'Carrier updated', carrier: formatCarrierResponse(result.rows[0]) });
  } catch (error) {
    console.error('[Broker] Update carrier error:', error);
    res.status(500).json({ error: 'Failed to update carrier' });
  }
});

/**
 * PUT /broker/carriers/:id/block
 * Block a carrier
 */
router.put('/carriers/:id/block', authenticate, requireBroker, requireBrokerAdmin, async (req, res) => {
  try {
    const { reason } = req.body;

    const result = await pool.query(`
      UPDATE broker_carriers 
      SET status = 'blocked', 
          blocked_at = NOW(), 
          blocked_by = $1, 
          blocked_reason = $2,
          updated_at = NOW()
      WHERE id = $3 AND broker_org_id = $4
      RETURNING *
    `, [req.user.id, reason || null, req.params.id, req.brokerOrg.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Carrier not found' });
    }

    res.json({ message: 'Carrier blocked', carrier: formatCarrierResponse(result.rows[0]) });
  } catch (error) {
    console.error('[Broker] Block carrier error:', error);
    res.status(500).json({ error: 'Failed to block carrier' });
  }
});

/**
 * PUT /broker/carriers/:id/unblock
 * Unblock a carrier
 */
router.put('/carriers/:id/unblock', authenticate, requireBroker, requireBrokerAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      UPDATE broker_carriers 
      SET status = 'active', 
          blocked_at = NULL, 
          blocked_by = NULL, 
          blocked_reason = NULL,
          updated_at = NOW()
      WHERE id = $1 AND broker_org_id = $2 AND status = 'blocked'
      RETURNING *
    `, [req.params.id, req.brokerOrg.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Carrier not found or not blocked' });
    }

    res.json({ message: 'Carrier unblocked', carrier: formatCarrierResponse(result.rows[0]) });
  } catch (error) {
    console.error('[Broker] Unblock carrier error:', error);
    res.status(500).json({ error: 'Failed to unblock carrier' });
  }
});

/**
 * GET /broker/carriers/:id/loads
 * Get load history with a carrier
 */
router.get('/carriers/:id/loads', authenticate, requireBroker, async (req, res) => {
  try {
    const { limit = 20, offset = 0 } = req.query;

    // Get carrier org ID
    const carrierResult = await pool.query(
      `SELECT carrier_org_id FROM broker_carriers WHERE id = $1 AND broker_org_id = $2`,
      [req.params.id, req.brokerOrg.id]
    );

    if (carrierResult.rows.length === 0) {
      return res.status(404).json({ error: 'Carrier not found' });
    }

    const carrierOrgId = carrierResult.rows[0].carrier_org_id;

    if (!carrierOrgId) {
      return res.json({ loads: [], total: 0 });
    }

    const result = await pool.query(`
      SELECT l.*, 
        a.carrier_pay, a.status as assignment_status, a.completed_at
      FROM loads l
      JOIN assignments a ON l.id = a.load_id
      WHERE l.posted_by_org_id = $1 AND a.carrier_org_id = $2
      ORDER BY l.created_at DESC
      LIMIT $3 OFFSET $4
    `, [req.brokerOrg.id, carrierOrgId, limit, offset]);

    const countResult = await pool.query(`
      SELECT COUNT(*) as total
      FROM loads l
      JOIN assignments a ON l.id = a.load_id
      WHERE l.posted_by_org_id = $1 AND a.carrier_org_id = $2
    `, [req.brokerOrg.id, carrierOrgId]);

    res.json({
      loads: result.rows,
      total: parseInt(countResult.rows[0].total),
      pagination: { limit: parseInt(limit), offset: parseInt(offset) }
    });
  } catch (error) {
    console.error('[Broker] Get carrier loads error:', error);
    res.status(500).json({ error: 'Failed to get loads' });
  }
});

// ============================================
// SHIPPER RELATIONSHIP ROUTES
// ============================================

/**
 * GET /broker/shippers
 * List shippers broker has relationships with
 */
router.get('/shippers', authenticate, requireBroker, async (req, res) => {
  try {
    const { status, search, limit = 50, offset = 0 } = req.query;

    let whereClause = 'WHERE bs.broker_org_id = $1';
    const params = [req.brokerOrg.id];
    let paramIndex = 2;

    if (status) {
      whereClause += ` AND bs.status = $${paramIndex++}`;
      params.push(status);
    }

    if (search) {
      whereClause += ` AND o.name ILIKE $${paramIndex++}`;
      params.push(`%${search}%`);
    }

    params.push(limit, offset);

    const result = await pool.query(`
      SELECT 
        bs.*,
        o.name as shipper_name,
        o.city as shipper_city,
        o.state as shipper_state,
        u.shipper_score,
        u.shipper_rating,
        u.shipper_rating_count,
        u.shipper_loads_posted as platform_loads_posted,
        u.shipper_loads_completed as platform_loads_completed,
        u.shipper_disputes as platform_disputes,
        u.shipper_cancellations as platform_cancellations
      FROM broker_shippers bs
      JOIN orgs o ON bs.shipper_org_id = o.id
      LEFT JOIN users u ON u.id = (
        SELECT user_id FROM memberships 
        WHERE org_id = o.id AND is_primary = true 
        LIMIT 1
      )
      ${whereClause}
      ORDER BY bs.total_revenue DESC, bs.created_at DESC
      LIMIT $${paramIndex++} OFFSET $${paramIndex}
    `, params);

    // Get counts
    const countResult = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status = 'active') as active_count,
        COUNT(*) FILTER (WHERE status = 'inactive') as inactive_count,
        COUNT(*) as total_count,
        COALESCE(SUM(total_revenue), 0) as total_revenue,
        COALESCE(SUM(total_margin), 0) as total_margin
      FROM broker_shippers
      WHERE broker_org_id = $1
    `, [req.brokerOrg.id]);

    res.json({
      shippers: result.rows.map(formatShipperResponse),
      summary: countResult.rows[0],
      pagination: { limit: parseInt(limit), offset: parseInt(offset) }
    });
  } catch (error) {
    console.error('[Broker] Get shippers error:', error);
    res.status(500).json({ error: 'Failed to get shippers' });
  }
});

/**
 * GET /broker/shippers/:id
 * Get shipper relationship details
 */
router.get('/shippers/:id', authenticate, requireBroker, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        bs.*,
        o.name as shipper_name,
        o.city as shipper_city,
        o.state as shipper_state,
        o.email as shipper_email,
        o.phone as shipper_phone
      FROM broker_shippers bs
      JOIN orgs o ON bs.shipper_org_id = o.id
      WHERE bs.id = $1 AND bs.broker_org_id = $2
    `, [req.params.id, req.brokerOrg.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Shipper not found' });
    }

    res.json({ shipper: formatShipperResponse(result.rows[0]) });
  } catch (error) {
    console.error('[Broker] Get shipper error:', error);
    res.status(500).json({ error: 'Failed to get shipper' });
  }
});

/**
 * GET /broker/discover-shippers
 * Discover shippers on platform
 */
router.get('/discover-shippers', authenticate, requireBroker, async (req, res) => {
  try {
    const { search, city, state, industry, limit = 20, offset = 0 } = req.query;

    let whereClause = `WHERE o.org_type = 'shipper' AND o.is_active = true`;
    const params = [];
    let paramIndex = 1;

    if (search) {
      whereClause += ` AND o.name ILIKE $${paramIndex++}`;
      params.push(`%${search}%`);
    }

    if (city) {
      whereClause += ` AND o.city ILIKE $${paramIndex++}`;
      params.push(`%${city}%`);
    }

    if (state) {
      whereClause += ` AND o.state = $${paramIndex++}`;
      params.push(state.toUpperCase());
    }

    params.push(req.brokerOrg.id, limit, offset);

    const result = await pool.query(`
      SELECT 
        o.id, o.name, o.city, o.state,
        u.shipper_score, u.shipper_rating, u.shipper_rating_count,
        u.shipper_loads_posted, u.shipper_loads_completed,
        bs.id as relationship_id,
        bs.status as relationship_status,
        cr.id as pending_request_id,
        cr.status as request_status,
        cr.attempt_number,
        (
          SELECT MAX(sent_at) FROM broker_connection_requests 
          WHERE broker_org_id = $${paramIndex} AND shipper_org_id = o.id
        ) as last_request_at,
        (
          SELECT was_declined FROM broker_connection_attempts
          WHERE broker_org_id = $${paramIndex} AND shipper_org_id = o.id
          ORDER BY attempt_at DESC LIMIT 1
        ) as was_ever_declined
      FROM orgs o
      LEFT JOIN users u ON u.id = (
        SELECT user_id FROM memberships 
        WHERE org_id = o.id AND is_primary = true 
        LIMIT 1
      )
      LEFT JOIN broker_shippers bs ON bs.shipper_org_id = o.id AND bs.broker_org_id = $${paramIndex}
      LEFT JOIN broker_connection_requests cr ON cr.shipper_org_id = o.id 
        AND cr.broker_org_id = $${paramIndex} AND cr.status = 'pending'
      ${whereClause}
      ORDER BY u.shipper_score DESC NULLS LAST, u.shipper_loads_completed DESC NULLS LAST
      LIMIT $${paramIndex + 1} OFFSET $${paramIndex + 2}
    `, params);

    res.json({
      shippers: result.rows.map(row => ({
        id: row.id,
        name: row.name,
        city: row.city,
        state: row.state,
        shipperScore: row.shipper_score ? parseFloat(row.shipper_score) : null,
        shipperRating: row.shipper_rating ? parseFloat(row.shipper_rating) : null,
        shipperRatingCount: row.shipper_rating_count,
        loadsPosted: row.shipper_loads_posted,
        loadsCompleted: row.shipper_loads_completed,
        relationshipId: row.relationship_id,
        relationshipStatus: row.relationship_status,
        pendingRequestId: row.pending_request_id,
        requestStatus: row.request_status,
        attemptNumber: row.attempt_number,
        wasEverDeclined: row.was_ever_declined,
      })),
      pagination: { limit: parseInt(limit), offset: parseInt(offset) }
    });
  } catch (error) {
    console.error('[Broker] Discover shippers error:', error);
    res.status(500).json({ error: 'Failed to discover shippers' });
  }
});

// ============================================
// CONNECTION REQUEST ROUTES
// ============================================

/**
 * GET /broker/connection-requests
 * List sent connection requests
 */
router.get('/connection-requests', authenticate, requireBroker, async (req, res) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;

    let whereClause = 'WHERE cr.broker_org_id = $1';
    const params = [req.brokerOrg.id];
    let paramIndex = 2;

    if (status && status !== 'all') {
      whereClause += ` AND cr.status = $${paramIndex++}`;
      params.push(status);
    }

    params.push(limit, offset);

    const result = await pool.query(`
      SELECT 
        cr.*,
        o.name as shipper_name,
        o.city as shipper_city,
        o.state as shipper_state,
        CASE 
          WHEN cr.status = 'expired' AND cr.attempt_number < 3 THEN
            CASE 
              WHEN cr.attempt_number = 1 AND cr.sent_at + INTERVAL '60 days' < NOW() THEN true
              WHEN cr.attempt_number = 2 AND cr.sent_at + INTERVAL '90 days' < NOW() THEN true
              ELSE false
            END
          ELSE false
        END as can_retry,
        CASE 
          WHEN cr.status = 'expired' AND cr.attempt_number < 3 THEN
            CASE 
              WHEN cr.attempt_number = 1 THEN GREATEST(0, EXTRACT(DAY FROM (cr.sent_at + INTERVAL '60 days') - NOW()))::int
              WHEN cr.attempt_number = 2 THEN GREATEST(0, EXTRACT(DAY FROM (cr.sent_at + INTERVAL '90 days') - NOW()))::int
              ELSE 0
            END
          ELSE 0
        END as days_until_retry
      FROM broker_connection_requests cr
      JOIN orgs o ON cr.shipper_org_id = o.id
      ${whereClause}
      ORDER BY 
        CASE cr.status 
          WHEN 'pending' THEN 1 
          WHEN 'accepted' THEN 2 
          WHEN 'expired' THEN 3 
          WHEN 'declined' THEN 4 
        END,
        cr.created_at DESC
      LIMIT $${paramIndex++} OFFSET $${paramIndex}
    `, params);

    // Get counts
    const countResult = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status = 'pending') as pending_count,
        COUNT(*) FILTER (WHERE status = 'accepted') as accepted_count,
        COUNT(*) FILTER (WHERE status = 'declined') as declined_count,
        COUNT(*) FILTER (WHERE status = 'expired') as expired_count
      FROM broker_connection_requests
      WHERE broker_org_id = $1
    `, [req.brokerOrg.id]);

    res.json({
      requests: result.rows.map(formatConnectionRequestResponse),
      counts: countResult.rows[0],
      pagination: { limit: parseInt(limit), offset: parseInt(offset) }
    });
  } catch (error) {
    console.error('[Broker] Get connection requests error:', error);
    res.status(500).json({ error: 'Failed to get connection requests' });
  }
});

/**
 * POST /broker/connection-requests
 * Send connection request to shipper
 */
router.post('/connection-requests', authenticate, requireBroker, requireBrokerAdmin, async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { shipperOrgId, message } = req.body;

    if (!shipperOrgId) {
      return res.status(400).json({ error: 'shipperOrgId is required' });
    }

    if (message && message.length > 500) {
      return res.status(400).json({ error: 'Message must be 500 characters or less' });
    }

    // Check if shipper exists
    const shipperResult = await pool.query(
      `SELECT id, name FROM orgs WHERE id = $1 AND org_type = 'shipper' AND is_active = true`,
      [shipperOrgId]
    );

    if (shipperResult.rows.length === 0) {
      return res.status(404).json({ error: 'Shipper not found' });
    }

    // Check if relationship already exists
    const existingRelation = await pool.query(
      `SELECT id FROM broker_shippers WHERE broker_org_id = $1 AND shipper_org_id = $2`,
      [req.brokerOrg.id, shipperOrgId]
    );

    if (existingRelation.rows.length > 0) {
      return res.status(409).json({ error: 'You already have a relationship with this shipper' });
    }

    // Check if can send request using our function
    const canSendResult = await pool.query(
      `SELECT can_broker_send_request($1, $2) as result`,
      [req.brokerOrg.id, shipperOrgId]
    );

    const canSend = canSendResult.rows[0].result;

    if (!canSend.can_send) {
      return res.status(400).json({ 
        error: canSend.reason,
        daysRemaining: canSend.days_remaining,
        attemptNumber: canSend.attempt_number
      });
    }

    await client.query('BEGIN');

    // Check for existing pending request
    const existingPending = await client.query(
      `SELECT id FROM broker_connection_requests 
       WHERE broker_org_id = $1 AND shipper_org_id = $2 AND status = 'pending'`,
      [req.brokerOrg.id, shipperOrgId]
    );

    if (existingPending.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'You already have a pending request to this shipper' });
    }

    // Create connection request
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 14); // 14 day expiry

    const result = await client.query(`
      INSERT INTO broker_connection_requests (
        broker_org_id, shipper_org_id, sent_by, message, 
        attempt_number, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [
      req.brokerOrg.id, shipperOrgId, req.user.id, message || null,
      canSend.attempt_number, expiresAt
    ]);

    // Record attempt
    await client.query(`
      INSERT INTO broker_connection_attempts (
        broker_org_id, shipper_org_id, request_id, attempt_number
      ) VALUES ($1, $2, $3, $4)
    `, [req.brokerOrg.id, shipperOrgId, result.rows[0].id, canSend.attempt_number]);

    await client.query('COMMIT');

    // TODO: Notify shipper of connection request

    res.status(201).json({
      message: 'Connection request sent',
      request: formatConnectionRequestResponse({
        ...result.rows[0],
        shipper_name: shipperResult.rows[0].name
      })
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[Broker] Create connection request error:', error);
    res.status(500).json({ error: 'Failed to send connection request' });
  } finally {
    client.release();
  }
});

/**
 * POST /broker/connection-requests/:id/retry
 * Retry an expired connection request
 */
router.post('/connection-requests/:id/retry', authenticate, requireBroker, requireBrokerAdmin, async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { message } = req.body;

    // Get original request
    const originalResult = await pool.query(`
      SELECT cr.*, o.name as shipper_name
      FROM broker_connection_requests cr
      JOIN orgs o ON cr.shipper_org_id = o.id
      WHERE cr.id = $1 AND cr.broker_org_id = $2 AND cr.status = 'expired'
    `, [req.params.id, req.brokerOrg.id]);

    if (originalResult.rows.length === 0) {
      return res.status(404).json({ error: 'Request not found or not expired' });
    }

    const original = originalResult.rows[0];

    // Check if can send
    const canSendResult = await pool.query(
      `SELECT can_broker_send_request($1, $2) as result`,
      [req.brokerOrg.id, original.shipper_org_id]
    );

    const canSend = canSendResult.rows[0].result;

    if (!canSend.can_send) {
      return res.status(400).json({ 
        error: canSend.reason,
        daysRemaining: canSend.days_remaining
      });
    }

    await client.query('BEGIN');

    // Create new request
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 14);

    const result = await client.query(`
      INSERT INTO broker_connection_requests (
        broker_org_id, shipper_org_id, sent_by, message, 
        attempt_number, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [
      req.brokerOrg.id, original.shipper_org_id, req.user.id, 
      message || original.message, canSend.attempt_number, expiresAt
    ]);

    // Record attempt
    await client.query(`
      INSERT INTO broker_connection_attempts (
        broker_org_id, shipper_org_id, request_id, attempt_number
      ) VALUES ($1, $2, $3, $4)
    `, [req.brokerOrg.id, original.shipper_org_id, result.rows[0].id, canSend.attempt_number]);

    await client.query('COMMIT');

    res.status(201).json({
      message: 'Connection request sent',
      request: formatConnectionRequestResponse({
        ...result.rows[0],
        shipper_name: original.shipper_name
      })
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[Broker] Retry connection request error:', error);
    res.status(500).json({ error: 'Failed to retry connection request' });
  } finally {
    client.release();
  }
});

// ============================================
// AVAILABLE LOADS FOR BROKER BIDDING
// ============================================

/**
 * GET /broker/available-loads
 * Get loads available for broker to bid on
 */
router.get('/available-loads', authenticate, requireBroker, async (req, res) => {
  try {
    const { loadType, minPrice, maxPrice, search, limit = 20, offset = 0 } = req.query;

    let whereClause = `WHERE l.status = 'posted' AND l.allow_offers = true`;
    const params = [];
    let paramIndex = 1;

    // Exclude broker's own loads
    whereClause += ` AND l.posted_by_org_id != $${paramIndex++}`;
    params.push(req.brokerOrg.id);

    if (loadType) {
      whereClause += ` AND l.load_type = $${paramIndex++}`;
      params.push(loadType);
    }

    if (minPrice) {
      whereClause += ` AND l.price >= $${paramIndex++}`;
      params.push(minPrice);
    }

    if (maxPrice) {
      whereClause += ` AND l.price <= $${paramIndex++}`;
      params.push(maxPrice);
    }

    if (search) {
      whereClause += ` AND (
        l.pickup_city ILIKE $${paramIndex} OR 
        l.delivery_city ILIKE $${paramIndex} OR 
        l.description ILIKE $${paramIndex}
      )`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    params.push(limit, offset);

    const result = await pool.query(`
      SELECT 
        l.*,
        poster_org.name as poster_org_name,
        poster_org.org_type as poster_org_type,
        u.shipper_score, u.shipper_rating,
        (SELECT COUNT(*) FROM offers WHERE load_id = l.id AND status = 'pending') as offer_count,
        EXISTS(
          SELECT 1 FROM offers 
          WHERE load_id = l.id AND carrier_org_id = $1 AND status IN ('pending', 'countered')
        ) as has_my_offer
      FROM loads l
      LEFT JOIN orgs poster_org ON l.posted_by_org_id = poster_org.id
      LEFT JOIN users u ON l.shipper_id = u.id
      ${whereClause}
      ORDER BY l.posted_at DESC
      LIMIT $${paramIndex++} OFFSET $${paramIndex}
    `, [req.brokerOrg.id, ...params]);

    res.json({
      loads: result.rows.map(row => ({
        id: row.id,
        description: row.description,
        loadType: row.load_type,
        price: row.price ? parseFloat(row.price) : null,
        distanceMiles: row.distance_miles ? parseFloat(row.distance_miles) : null,
        pickupCity: row.pickup_city,
        pickupState: row.pickup_state,
        pickupDate: row.pickup_date,
        deliveryCity: row.delivery_city,
        deliveryState: row.delivery_state,
        deliveryDate: row.delivery_date,
        weightLbs: row.weight_lbs,
        overnightHold: row.overnight_hold,
        sealRequired: row.seal_required,
        appointmentRequired: row.appointment_required,
        posterOrgName: row.poster_org_name,
        posterOrgType: row.poster_org_type,
        shipperScore: row.shipper_score ? parseFloat(row.shipper_score) : null,
        shipperRating: row.shipper_rating ? parseFloat(row.shipper_rating) : null,
        offerCount: parseInt(row.offer_count),
        hasMyOffer: row.has_my_offer,
        postedAt: row.posted_at,
      })),
      pagination: { limit: parseInt(limit), offset: parseInt(offset) }
    });
  } catch (error) {
    console.error('[Broker] Get available loads error:', error);
    res.status(500).json({ error: 'Failed to get loads' });
  }
});

// ============================================
// HELPER FUNCTIONS
// ============================================

function formatCarrierResponse(row) {
  return {
    id: row.id,
    carrierOrgId: row.carrier_org_id,
    carrierName: row.carrier_name,
    carrierMc: row.carrier_mc,
    carrierDot: row.carrier_dot,
    carrierCity: row.carrier_city,
    carrierState: row.carrier_state,
    carrierEmail: row.carrier_email,
    carrierPhone: row.carrier_phone,
    carrierVerification: row.carrier_verification,
    status: row.status,
    isPreferred: row.is_preferred,
    loadsCompleted: row.loads_completed,
    onTimeCount: row.on_time_count,
    lateCount: row.late_count,
    totalPaid: row.total_paid ? parseFloat(row.total_paid) : 0,
    claimsCount: row.claims_count,
    primaryContactName: row.primary_contact_name,
    primaryContactPhone: row.primary_contact_phone,
    primaryContactEmail: row.primary_contact_email,
    w9OnFile: row.w9_on_file,
    coiOnFile: row.coi_on_file,
    coiExpiresAt: row.coi_expires_at,
    cargoInsuranceOnFile: row.cargo_insurance_on_file,
    cargoInsuranceAmount: row.cargo_insurance_amount ? parseFloat(row.cargo_insurance_amount) : null,
    authorityVerified: row.authority_verified,
    notes: row.notes,
    internalNotes: row.internal_notes,
    acceptedAt: row.accepted_at,
    firstLoadAt: row.first_load_at,
    lastLoadAt: row.last_load_at,
    createdAt: row.created_at,
    // External carrier info (not on platform)
    externalMcNumber: row.external_mc_number,
    externalCompanyName: row.external_company_name,
    // Platform stats
    platformLoads: row.platform_loads,
    platformOnTime: row.platform_on_time ? parseFloat(row.platform_on_time) : null,
    driverCount: row.driver_count,
  };
}

function formatShipperResponse(row) {
  return {
    id: row.id,
    shipperOrgId: row.shipper_org_id,
    shipperName: row.shipper_name,
    shipperCity: row.shipper_city,
    shipperState: row.shipper_state,
    shipperEmail: row.shipper_email,
    shipperPhone: row.shipper_phone,
    status: row.status,
    relationshipSource: row.relationship_source,
    totalLoads: row.total_loads,
    totalRevenue: row.total_revenue ? parseFloat(row.total_revenue) : 0,
    totalMargin: row.total_margin ? parseFloat(row.total_margin) : 0,
    avgMarginPercent: row.avg_margin_percent ? parseFloat(row.avg_margin_percent) : null,
    onTimePaymentRate: row.on_time_payment_rate ? parseFloat(row.on_time_payment_rate) : null,
    commonLanes: row.common_lanes,
    primaryContactName: row.primary_contact_name,
    primaryContactPhone: row.primary_contact_phone,
    primaryContactEmail: row.primary_contact_email,
    firstLoadAt: row.first_load_at,
    lastLoadAt: row.last_load_at,
    createdAt: row.created_at,
    // Platform stats
    shipperScore: row.shipper_score ? parseFloat(row.shipper_score) : null,
    shipperRating: row.shipper_rating ? parseFloat(row.shipper_rating) : null,
    shipperRatingCount: row.shipper_rating_count,
    platformLoadsPosted: row.platform_loads_posted,
    platformLoadsCompleted: row.platform_loads_completed,
    platformDisputes: row.platform_disputes,
    platformCancellations: row.platform_cancellations,
  };
}

function formatConnectionRequestResponse(row) {
  return {
    id: row.id,
    shipperOrgId: row.shipper_org_id,
    shipperName: row.shipper_name,
    shipperCity: row.shipper_city,
    shipperState: row.shipper_state,
    status: row.status,
    message: row.message,
    attemptNumber: row.attempt_number,
    sentAt: row.sent_at,
    viewedAt: row.viewed_at,
    respondedAt: row.responded_at,
    expiresAt: row.expires_at,
    declineReason: row.decline_reason,
    canRetry: row.can_retry,
    daysUntilRetry: row.days_until_retry,
    createdAt: row.created_at,
  };
}

// ============================================
// CARRIER ROUTES - Managing broker relationships
// ============================================

/**
 * Middleware: Verify user is a carrier
 */
const requireCarrier = async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT 
        o.id as org_id,
        o.org_type,
        o.name as org_name,
        o.mc_number,
        m.role,
        m.permissions
      FROM memberships m
      JOIN orgs o ON m.org_id = o.id
      WHERE m.user_id = $1 AND m.is_active = true AND o.is_active = true
      ORDER BY m.is_primary DESC
      LIMIT 1
    `, [req.user.id]);

    if (result.rows.length === 0) {
      return res.status(403).json({ error: 'You must belong to an organization' });
    }

    const org = result.rows[0];

    if (org.org_type !== 'carrier') {
      return res.status(403).json({ error: 'This endpoint is for carriers only' });
    }

    req.carrierOrg = {
      id: org.org_id,
      name: org.org_name,
      type: org.org_type,
      mcNumber: org.mc_number,
      role: org.role,
      permissions: org.permissions
    };

    next();
  } catch (error) {
    console.error('[Carrier Middleware] Error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

/**
 * GET /broker/carrier/invites
 * Get broker invites for current carrier (pending_carrier status)
 */
router.get('/carrier/invites', authenticate, requireCarrier, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        bc.id,
        bc.broker_org_id,
        bc.status,
        bc.notes as message,
        bc.created_at,
        bo.name as broker_name,
        bo.mc_number as broker_mc,
        bo.city as broker_city,
        bo.state as broker_state,
        bo.email as broker_email,
        u.first_name as invited_by_first,
        u.last_name as invited_by_last
      FROM broker_carriers bc
      JOIN orgs bo ON bc.broker_org_id = bo.id
      LEFT JOIN users u ON bc.invited_by = u.id
      WHERE bc.carrier_org_id = $1 AND bc.status = 'pending_carrier'
      ORDER BY bc.created_at DESC
    `, [req.carrierOrg.id]);

    res.json({
      invites: result.rows.map(row => ({
        id: row.id,
        brokerOrgId: row.broker_org_id,
        brokerName: row.broker_name,
        brokerMc: row.broker_mc,
        brokerCity: row.broker_city,
        brokerState: row.broker_state,
        brokerEmail: row.broker_email,
        message: row.message,
        invitedBy: row.invited_by_first ? `${row.invited_by_first} ${row.invited_by_last}` : null,
        createdAt: row.created_at
      }))
    });
  } catch (error) {
    console.error('[Carrier] Get invites error:', error);
    res.status(500).json({ error: 'Failed to get broker invites' });
  }
});

/**
 * PUT /broker/carrier/invites/:id/accept
 * Accept broker invite
 */
router.put('/carrier/invites/:id/accept', authenticate, requireCarrier, async (req, res) => {
  try {
    const { id } = req.params;

    // Verify invite belongs to this carrier and is pending
    const invite = await pool.query(`
      SELECT * FROM broker_carriers 
      WHERE id = $1 AND carrier_org_id = $2 AND status = 'pending_carrier'
    `, [id, req.carrierOrg.id]);

    if (invite.rows.length === 0) {
      return res.status(404).json({ error: 'Invite not found or already processed' });
    }

    // Accept the invite
    await pool.query(`
      UPDATE broker_carriers 
      SET status = 'active', accepted_at = NOW(), updated_at = NOW()
      WHERE id = $1
    `, [id]);

    // TODO: Send notification to broker that carrier accepted

    res.json({ message: 'Invitation accepted - you are now connected with this broker' });
  } catch (error) {
    console.error('[Carrier] Accept invite error:', error);
    res.status(500).json({ error: 'Failed to accept invite' });
  }
});

/**
 * PUT /broker/carrier/invites/:id/decline
 * Decline broker invite
 */
router.put('/carrier/invites/:id/decline', authenticate, requireCarrier, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    // Verify invite belongs to this carrier and is pending
    const invite = await pool.query(`
      SELECT * FROM broker_carriers 
      WHERE id = $1 AND carrier_org_id = $2 AND status = 'pending_carrier'
    `, [id, req.carrierOrg.id]);

    if (invite.rows.length === 0) {
      return res.status(404).json({ error: 'Invite not found or already processed' });
    }

    // Decline the invite
    await pool.query(`
      UPDATE broker_carriers 
      SET status = 'declined', decline_reason = $2, updated_at = NOW()
      WHERE id = $1
    `, [id, reason || null]);

    // TODO: Send notification to broker that carrier declined

    res.json({ message: 'Invitation declined' });
  } catch (error) {
    console.error('[Carrier] Decline invite error:', error);
    res.status(500).json({ error: 'Failed to decline invite' });
  }
});

/**
 * GET /broker/carrier/brokers
 * Get list of brokers carrier is connected to (active relationships)
 */
router.get('/carrier/brokers', authenticate, requireCarrier, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        bc.id,
        bc.broker_org_id,
        bc.status,
        bc.loads_completed,
        bc.is_preferred,
        bc.created_at,
        bo.name as broker_name,
        bo.mc_number as broker_mc,
        bo.city as broker_city,
        bo.state as broker_state,
        bo.email as broker_email,
        bo.phone as broker_phone
      FROM broker_carriers bc
      JOIN orgs bo ON bc.broker_org_id = bo.id
      WHERE bc.carrier_org_id = $1 AND bc.status = 'active'
      ORDER BY bc.loads_completed DESC, bc.created_at DESC
    `, [req.carrierOrg.id]);

    res.json({
      brokers: result.rows.map(row => ({
        id: row.id,
        brokerOrgId: row.broker_org_id,
        brokerName: row.broker_name,
        brokerMc: row.broker_mc,
        brokerCity: row.broker_city,
        brokerState: row.broker_state,
        brokerEmail: row.broker_email,
        brokerPhone: row.broker_phone,
        loadsCompleted: row.loads_completed,
        isPreferred: row.is_preferred,
        status: row.status,
        connectedAt: row.created_at
      }))
    });
  } catch (error) {
    console.error('[Carrier] Get brokers error:', error);
    res.status(500).json({ error: 'Failed to get broker connections' });
  }
});

/**
 * POST /broker/carrier/request
 * Carrier requests to join a broker's network
 */
router.post('/carrier/request', authenticate, requireCarrier, async (req, res) => {
  try {
    const { brokerOrgId, message } = req.body;

    if (!brokerOrgId) {
      return res.status(400).json({ error: 'Broker org ID is required' });
    }

    // Verify broker exists
    const broker = await pool.query(
      `SELECT * FROM orgs WHERE id = $1 AND org_type = 'broker' AND is_active = true`,
      [brokerOrgId]
    );

    if (broker.rows.length === 0) {
      return res.status(404).json({ error: 'Broker not found' });
    }

    // Check for existing relationship
    const existing = await pool.query(
      `SELECT id, status FROM broker_carriers WHERE broker_org_id = $1 AND carrier_org_id = $2`,
      [brokerOrgId, req.carrierOrg.id]
    );

    if (existing.rows.length > 0) {
      const status = existing.rows[0].status;
      if (status === 'active') {
        return res.status(409).json({ error: 'Already connected with this broker' });
      } else if (status === 'pending_broker') {
        return res.status(409).json({ error: 'Request already sent, waiting for broker to accept' });
      } else if (status === 'pending_carrier') {
        return res.status(409).json({ error: 'Broker has already invited you - check your invites' });
      }
    }

    // Create request (pending_broker means waiting for broker approval)
    const result = await pool.query(`
      INSERT INTO broker_carriers (
        broker_org_id, carrier_org_id, status, notes, requested_by
      ) VALUES ($1, $2, 'pending_broker', $3, $4)
      ON CONFLICT (broker_org_id, carrier_org_id) 
      DO UPDATE SET status = 'pending_broker', notes = $3, requested_by = $4, updated_at = NOW()
      RETURNING *
    `, [brokerOrgId, req.carrierOrg.id, message || null, req.user.id]);

    // TODO: Send notification to broker about carrier request

    res.status(201).json({
      message: 'Request sent - waiting for broker to accept',
      request: {
        id: result.rows[0].id,
        brokerOrgId: brokerOrgId,
        brokerName: broker.rows[0].name,
        status: 'pending_broker'
      }
    });
  } catch (error) {
    console.error('[Carrier] Request broker error:', error);
    res.status(500).json({ error: 'Failed to send request' });
  }
});

/**
 * DELETE /broker/carrier/brokers/:id
 * Carrier leaves a broker's network
 */
router.delete('/carrier/brokers/:id', authenticate, requireCarrier, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(`
      DELETE FROM broker_carriers 
      WHERE id = $1 AND carrier_org_id = $2
      RETURNING *
    `, [id, req.carrierOrg.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Broker connection not found' });
    }

    res.json({ message: 'Disconnected from broker network' });
  } catch (error) {
    console.error('[Carrier] Leave broker error:', error);
    res.status(500).json({ error: 'Failed to leave broker network' });
  }
});

/**
 * GET /broker/carrier-requests
 * Broker views pending carrier requests (pending_broker status)
 */
router.get('/carrier-requests', authenticate, requireBroker, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        bc.id,
        bc.carrier_org_id,
        bc.status,
        bc.notes as message,
        bc.created_at,
        co.name as carrier_name,
        co.mc_number as carrier_mc,
        co.dot_number as carrier_dot,
        co.city as carrier_city,
        co.state as carrier_state,
        co.loads_completed,
        co.on_time_rate,
        u.first_name as requested_by_first,
        u.last_name as requested_by_last
      FROM broker_carriers bc
      JOIN orgs co ON bc.carrier_org_id = co.id
      LEFT JOIN users u ON bc.requested_by = u.id
      WHERE bc.broker_org_id = $1 AND bc.status = 'pending_broker'
      ORDER BY bc.created_at DESC
    `, [req.brokerOrg.id]);

    res.json({
      requests: result.rows.map(row => ({
        id: row.id,
        carrierOrgId: row.carrier_org_id,
        carrierName: row.carrier_name,
        carrierMc: row.carrier_mc,
        carrierDot: row.carrier_dot,
        carrierCity: row.carrier_city,
        carrierState: row.carrier_state,
        loadsCompleted: row.loads_completed,
        onTimeRate: row.on_time_rate,
        message: row.message,
        requestedBy: row.requested_by_first ? `${row.requested_by_first} ${row.requested_by_last}` : null,
        createdAt: row.created_at
      }))
    });
  } catch (error) {
    console.error('[Broker] Get carrier requests error:', error);
    res.status(500).json({ error: 'Failed to get carrier requests' });
  }
});

/**
 * PUT /broker/carrier-requests/:id/accept
 * Broker accepts carrier request
 */
router.put('/carrier-requests/:id/accept', authenticate, requireBroker, requireBrokerAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    // Verify request belongs to this broker and is pending
    const request = await pool.query(`
      SELECT * FROM broker_carriers 
      WHERE id = $1 AND broker_org_id = $2 AND status = 'pending_broker'
    `, [id, req.brokerOrg.id]);

    if (request.rows.length === 0) {
      return res.status(404).json({ error: 'Request not found or already processed' });
    }

    // Accept the request
    await pool.query(`
      UPDATE broker_carriers 
      SET status = 'active', accepted_at = NOW(), accepted_by = $2, updated_at = NOW()
      WHERE id = $1
    `, [id, req.user.id]);

    // TODO: Send notification to carrier that broker accepted

    res.json({ message: 'Carrier request accepted - they are now in your network' });
  } catch (error) {
    console.error('[Broker] Accept carrier request error:', error);
    res.status(500).json({ error: 'Failed to accept request' });
  }
});

/**
 * PUT /broker/carrier-requests/:id/decline
 * Broker declines carrier request
 */
router.put('/carrier-requests/:id/decline', authenticate, requireBroker, requireBrokerAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    // Verify request belongs to this broker and is pending
    const request = await pool.query(`
      SELECT * FROM broker_carriers 
      WHERE id = $1 AND broker_org_id = $2 AND status = 'pending_broker'
    `, [id, req.brokerOrg.id]);

    if (request.rows.length === 0) {
      return res.status(404).json({ error: 'Request not found or already processed' });
    }

    // Decline the request
    await pool.query(`
      UPDATE broker_carriers 
      SET status = 'declined', decline_reason = $2, updated_at = NOW()
      WHERE id = $1
    `, [id, reason || null]);

    // TODO: Send notification to carrier that broker declined

    res.json({ message: 'Carrier request declined' });
  } catch (error) {
    console.error('[Broker] Decline carrier request error:', error);
    res.status(500).json({ error: 'Failed to decline request' });
  }
});

module.exports = router;
