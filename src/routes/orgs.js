// backend_api/src/routes/orgs.js
// Organization management: invites, driver management, document review, compliance

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { pool } = require('../db/pool');
const { authenticate } = require('../middleware/auth');

// ============================================
// MIDDLEWARE: Verify org membership and role
// ============================================

const requireOrgRole = (...allowedRoles) => {
  return async (req, res, next) => {
    try {
      const { orgId } = req.params;
      
      if (!orgId) {
        return res.status(400).json({ error: 'Organization ID required' });
      }

      // Check user's membership in this org
      const result = await pool.query(`
        SELECT m.role, m.permissions, o.org_type, o.name as org_name
        FROM memberships m
        JOIN orgs o ON m.org_id = o.id
        WHERE m.user_id = $1 AND m.org_id = $2 AND m.is_active = true AND o.is_active = true
      `, [req.user.id, orgId]);

      if (result.rows.length === 0) {
        return res.status(403).json({ error: 'Not a member of this organization' });
      }

      const membership = result.rows[0];

      if (allowedRoles.length > 0 && !allowedRoles.includes(membership.role)) {
        return res.status(403).json({ 
          error: 'Insufficient permissions',
          required: allowedRoles,
          current: membership.role
        });
      }

      // Attach org info to request
      req.org = {
        id: orgId,
        type: membership.org_type,
        name: membership.org_name,
        role: membership.role,
        permissions: membership.permissions
      };

      next();
    } catch (error) {
      console.error('[Orgs] Role check error:', error);
      res.status(500).json({ error: 'Authorization check failed' });
    }
  };
};

// Helper: Check if user is platform admin
const isPlatformAdmin = async (userId) => {
  const result = await pool.query(
    `SELECT id FROM admin_users WHERE id = $1 OR id IN (SELECT id FROM users WHERE id = $1 AND role = 'admin')`,
    [userId]
  );
  return result.rows.length > 0;
};

// ============================================
// ORG INFO
// ============================================

// GET /api/orgs/:orgId - Get org details
router.get('/:orgId', authenticate, requireOrgRole(), async (req, res) => {
  try {
    const { orgId } = req.params;

    const result = await pool.query(`
      SELECT 
        o.*,
        (SELECT COUNT(*) FROM memberships WHERE org_id = o.id AND is_active = true) as member_count,
        (SELECT COUNT(*) FROM memberships WHERE org_id = o.id AND role = 'driver' AND is_active = true) as driver_count
      FROM orgs o
      WHERE o.id = $1
    `, [orgId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    res.json({ org: result.rows[0] });
  } catch (error) {
    console.error('[Orgs] Get org error:', error);
    res.status(500).json({ error: 'Failed to get organization' });
  }
});

// ============================================
// INVITES
// ============================================

// POST /api/orgs/:orgId/invites - Create invite
router.post('/:orgId/invites', authenticate, requireOrgRole('carrier_admin', 'dispatcher', 'broker_admin', 'shipper_admin'), async (req, res) => {
  try {
    const { orgId } = req.params;
    const { email, role, firstName, lastName, phone, message } = req.body;

    // Validate role based on org type
    const validRoles = {
      carrier: ['driver', 'dispatcher'],
      broker: ['broker_agent'],
      shipper: ['shipping_clerk']
    };

    const allowedRoles = validRoles[req.org.type] || [];
    if (role && !allowedRoles.includes(role)) {
      return res.status(400).json({ 
        error: `Invalid role for ${req.org.type} organization`,
        allowedRoles 
      });
    }

    // Default role based on org type
    const inviteRole = role || (req.org.type === 'carrier' ? 'driver' : allowedRoles[0]);

    // Check if user already exists and is in this org
    if (email) {
      const existingUser = await pool.query(`
        SELECT u.id, m.id as membership_id
        FROM users u
        LEFT JOIN memberships m ON u.id = m.user_id AND m.org_id = $2
        WHERE u.email = $1
      `, [email.toLowerCase(), orgId]);

      if (existingUser.rows.length > 0 && existingUser.rows[0].membership_id) {
        return res.status(409).json({ error: 'User is already a member of this organization' });
      }
    }

    // Check for existing pending invite
    if (email) {
      const existingInvite = await pool.query(`
        SELECT id FROM org_invites 
        WHERE org_id = $1 AND email = $2 AND status = 'pending' AND expires_at > NOW()
      `, [orgId, email.toLowerCase()]);

      if (existingInvite.rows.length > 0) {
        return res.status(409).json({ error: 'Pending invite already exists for this email' });
      }
    }

    // Generate invite token
    const token = crypto.randomBytes(32).toString('hex');

    // Create invite
    const result = await pool.query(`
      INSERT INTO org_invites (org_id, invited_by, email, role, token, status, expires_at)
      VALUES ($1, $2, $3, $4, $5, 'pending', NOW() + INTERVAL '7 days')
      RETURNING *
    `, [orgId, req.user.id, email?.toLowerCase() || null, inviteRole, token]);

    const invite = result.rows[0];

    // TODO: Send email invite if email provided
    // await sendInviteEmail(email, token, req.org.name, inviteRole);

    res.status(201).json({
      message: 'Invite created',
      invite: {
        id: invite.id,
        email: invite.email,
        role: invite.role,
        token: invite.token,
        inviteUrl: `hotshot://invite/${invite.token}`,
        expiresAt: invite.expires_at
      }
    });
  } catch (error) {
    console.error('[Orgs] Create invite error:', error);
    res.status(500).json({ error: 'Failed to create invite' });
  }
});

// GET /api/orgs/:orgId/invites - List invites
router.get('/:orgId/invites', authenticate, requireOrgRole('carrier_admin', 'dispatcher', 'broker_admin', 'shipper_admin'), async (req, res) => {
  try {
    const { orgId } = req.params;
    const { status = 'pending' } = req.query;

    const result = await pool.query(`
      SELECT 
        i.*,
        u.first_name as invited_by_first_name,
        u.last_name as invited_by_last_name
      FROM org_invites i
      JOIN users u ON i.invited_by = u.id
      WHERE i.org_id = $1
        AND ($2 = 'all' OR i.status = $2)
      ORDER BY i.created_at DESC
    `, [orgId, status]);

    res.json({ invites: result.rows });
  } catch (error) {
    console.error('[Orgs] List invites error:', error);
    res.status(500).json({ error: 'Failed to list invites' });
  }
});

// DELETE /api/orgs/:orgId/invites/:inviteId - Cancel invite
router.delete('/:orgId/invites/:inviteId', authenticate, requireOrgRole('carrier_admin', 'dispatcher', 'broker_admin', 'shipper_admin'), async (req, res) => {
  try {
    const { orgId, inviteId } = req.params;

    const result = await pool.query(`
      UPDATE org_invites
      SET status = 'cancelled'
      WHERE id = $1 AND org_id = $2 AND status = 'pending'
      RETURNING id
    `, [inviteId, orgId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Invite not found or already processed' });
    }

    res.json({ message: 'Invite cancelled' });
  } catch (error) {
    console.error('[Orgs] Cancel invite error:', error);
    res.status(500).json({ error: 'Failed to cancel invite' });
  }
});

// GET /api/orgs/invites/:token - Get invite details (public)
router.get('/invites/:token', async (req, res) => {
  try {
    const { token } = req.params;

    const result = await pool.query(`
      SELECT 
        i.id, i.email, i.role, i.expires_at, i.status,
        o.id as org_id, o.name as org_name, o.org_type,
        u.first_name as invited_by_first_name, u.last_name as invited_by_last_name
      FROM org_invites i
      JOIN orgs o ON i.org_id = o.id
      JOIN users u ON i.invited_by = u.id
      WHERE i.token = $1
    `, [token]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Invite not found' });
    }

    const invite = result.rows[0];

    if (invite.status !== 'pending') {
      return res.status(410).json({ error: 'Invite already used or cancelled', status: invite.status });
    }

    if (new Date(invite.expires_at) < new Date()) {
      return res.status(410).json({ error: 'Invite expired' });
    }

    res.json({
      invite: {
        id: invite.id,
        email: invite.email,
        role: invite.role,
        expiresAt: invite.expires_at,
        org: {
          id: invite.org_id,
          name: invite.org_name,
          type: invite.org_type
        },
        invitedBy: {
          firstName: invite.invited_by_first_name,
          lastName: invite.invited_by_last_name
        }
      }
    });
  } catch (error) {
    console.error('[Orgs] Get invite error:', error);
    res.status(500).json({ error: 'Failed to get invite' });
  }
});

// POST /api/orgs/invites/:token/accept - Accept invite (existing user)
router.post('/invites/:token/accept', authenticate, async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { token } = req.params;

    await client.query('BEGIN');

    // Get and validate invite
    const inviteResult = await client.query(`
      SELECT i.*, o.org_type, o.name as org_name
      FROM org_invites i
      JOIN orgs o ON i.org_id = o.id
      WHERE i.token = $1 AND i.status = 'pending' AND i.expires_at > NOW()
      FOR UPDATE
    `, [token]);

    if (inviteResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Invalid, expired, or already used invite' });
    }

    const invite = inviteResult.rows[0];

    // Check if user already in this org
    const existingMembership = await client.query(`
      SELECT id FROM memberships WHERE user_id = $1 AND org_id = $2
    `, [req.user.id, invite.org_id]);

    if (existingMembership.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Already a member of this organization' });
    }

    // Create membership
    await client.query(`
      INSERT INTO memberships (user_id, org_id, role, is_primary, is_active)
      VALUES ($1, $2, $3, false, true)
    `, [req.user.id, invite.org_id, invite.role]);

    // Update invite status
    await client.query(`
      UPDATE org_invites
      SET status = 'accepted', accepted_at = NOW()
      WHERE id = $1
    `, [invite.id]);

    // If driver joining carrier, set approval status to pending
    if (invite.role === 'driver') {
      await client.query(`
        UPDATE users
        SET approval_status = 'pending_documents'
        WHERE id = $1 AND approval_status IN ('pending', 'approved')
      `, [req.user.id]);
    }

    await client.query('COMMIT');

    res.json({
      message: 'Successfully joined organization',
      org: {
        id: invite.org_id,
        name: invite.org_name,
        type: invite.org_type,
        role: invite.role
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[Orgs] Accept invite error:', error);
    res.status(500).json({ error: 'Failed to accept invite' });
  } finally {
    client.release();
  }
});

// ============================================
// DRIVER MANAGEMENT
// ============================================

// GET /api/orgs/:orgId/drivers - List drivers in org
router.get('/:orgId/drivers', authenticate, requireOrgRole('carrier_admin', 'dispatcher'), async (req, res) => {
  try {
    const { orgId } = req.params;
    const { status, approvalStatus } = req.query;

    let whereClause = `WHERE m.org_id = $1 AND m.role = 'driver' AND m.is_active = true`;
    const params = [orgId];
    let paramIndex = 2;

    if (approvalStatus) {
      whereClause += ` AND u.approval_status = $${paramIndex}`;
      params.push(approvalStatus);
      paramIndex++;
    }

    const result = await pool.query(`
      SELECT 
        u.id,
        u.email,
        u.first_name,
        u.last_name,
        u.phone,
        u.profile_picture_url,
        u.approval_status,
        u.is_verified,
        u.verified_at,
        u.is_available,
        u.driver_lat,
        u.driver_lng,
        u.location_updated_at,
        u.vehicle_type,
        u.license_plate,
        u.has_cdl,
        u.rating,
        u.rating_count,
        u.created_at,
        m.joined_at,
        (SELECT COUNT(*) FROM loads WHERE driver_id = u.id AND status = 'delivered') as completed_loads,
        (SELECT COUNT(*) FROM driver_documents WHERE user_id = u.id AND status = 'approved') as approved_docs,
        (SELECT COUNT(*) FROM driver_documents WHERE user_id = u.id AND status = 'pending') as pending_docs
      FROM users u
      JOIN memberships m ON u.id = m.user_id
      ${whereClause}
      ORDER BY u.first_name, u.last_name
    `, params);

    res.json({ drivers: result.rows });
  } catch (error) {
    console.error('[Orgs] List drivers error:', error);
    res.status(500).json({ error: 'Failed to list drivers' });
  }
});

// GET /api/orgs/:orgId/drivers/:driverId - Get driver details
router.get('/:orgId/drivers/:driverId', authenticate, requireOrgRole('carrier_admin', 'dispatcher'), async (req, res) => {
  try {
    const { orgId, driverId } = req.params;

    // Verify driver is in this org
    const memberCheck = await pool.query(`
      SELECT m.id FROM memberships m
      WHERE m.user_id = $1 AND m.org_id = $2 AND m.role = 'driver' AND m.is_active = true
    `, [driverId, orgId]);

    if (memberCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Driver not found in this organization' });
    }

    // Get driver details
    const driverResult = await pool.query(`
      SELECT 
        u.*,
        (SELECT COUNT(*) FROM loads WHERE driver_id = u.id AND status = 'delivered') as completed_loads,
        (SELECT COALESCE(SUM(driver_payout), 0) FROM loads WHERE driver_id = u.id AND status = 'delivered') as total_earnings
      FROM users u
      WHERE u.id = $1
    `, [driverId]);

    // Get driver documents
    const docsResult = await pool.query(`
      SELECT 
        id, document_type, file_url, file_name, status, expires_at,
        uploaded_at, reviewed_at, rejection_reason
      FROM driver_documents
      WHERE user_id = $1
      ORDER BY uploaded_at DESC
    `, [driverId]);

    // Get recent loads
    const loadsResult = await pool.query(`
      SELECT id, status, pickup_city, pickup_state, delivery_city, delivery_state,
             driver_payout, delivered_at, created_at
      FROM loads
      WHERE driver_id = $1
      ORDER BY created_at DESC
      LIMIT 10
    `, [driverId]);

    const driver = driverResult.rows[0];

    res.json({
      driver: {
        id: driver.id,
        email: driver.email,
        firstName: driver.first_name,
        lastName: driver.last_name,
        phone: driver.phone,
        profilePictureUrl: driver.profile_picture_url,
        approvalStatus: driver.approval_status,
        approvalNotes: driver.approval_notes,
        isVerified: driver.is_verified,
        verifiedAt: driver.verified_at,
        isAvailable: driver.is_available,
        vehicleType: driver.vehicle_type,
        licensePlate: driver.license_plate,
        hasCdl: driver.has_cdl,
        rating: driver.rating,
        ratingCount: driver.rating_count,
        completedLoads: driver.completed_loads,
        totalEarnings: driver.total_earnings,
        createdAt: driver.created_at
      },
      documents: docsResult.rows,
      recentLoads: loadsResult.rows
    });
  } catch (error) {
    console.error('[Orgs] Get driver error:', error);
    res.status(500).json({ error: 'Failed to get driver details' });
  }
});

// PUT /api/orgs/:orgId/drivers/:driverId/approve - Approve driver
router.put('/:orgId/drivers/:driverId/approve', authenticate, requireOrgRole('carrier_admin'), async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { orgId, driverId } = req.params;
    const { notes } = req.body;

    await client.query('BEGIN');

    // Verify driver is in this org
    const memberCheck = await client.query(`
      SELECT m.id FROM memberships m
      WHERE m.user_id = $1 AND m.org_id = $2 AND m.role = 'driver' AND m.is_active = true
    `, [driverId, orgId]);

    if (memberCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Driver not found in this organization' });
    }

    // Check all required documents are approved
    const docCheck = await client.query(`
      SELECT 
        (SELECT COUNT(*) FROM driver_documents WHERE user_id = $1 AND status = 'pending') as pending_count,
        (SELECT COUNT(*) FROM driver_documents WHERE user_id = $1 AND status = 'rejected') as rejected_count
    `, [driverId]);

    const docs = docCheck.rows[0];
    if (parseInt(docs.pending_count) > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ 
        error: 'Cannot approve driver with pending documents',
        pendingCount: parseInt(docs.pending_count)
      });
    }

    // Update driver approval status
    await client.query(`
      UPDATE users
      SET 
        approval_status = 'approved',
        approval_notes = $2,
        approved_by = $3,
        approved_at = NOW(),
        verified_driver = true,
        verified_at = NOW()
      WHERE id = $1
    `, [driverId, notes || null, req.user.id]);

    await client.query('COMMIT');

    // TODO: Send notification to driver

    res.json({ 
      message: 'Driver approved successfully',
      driverId,
      approvedAt: new Date()
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[Orgs] Approve driver error:', error);
    res.status(500).json({ error: 'Failed to approve driver' });
  } finally {
    client.release();
  }
});

// PUT /api/orgs/:orgId/drivers/:driverId/reject - Reject driver
router.put('/:orgId/drivers/:driverId/reject', authenticate, requireOrgRole('carrier_admin'), async (req, res) => {
  try {
    const { orgId, driverId } = req.params;
    const { reason, category } = req.body;

    if (!reason) {
      return res.status(400).json({ error: 'Rejection reason is required' });
    }

    // Verify driver is in this org
    const memberCheck = await pool.query(`
      SELECT m.id FROM memberships m
      WHERE m.user_id = $1 AND m.org_id = $2 AND m.role = 'driver' AND m.is_active = true
    `, [driverId, orgId]);

    if (memberCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Driver not found in this organization' });
    }

    // Update driver status
    await pool.query(`
      UPDATE users
      SET 
        approval_status = 'rejected',
        rejection_reason = $2,
        rejection_category = $3,
        approved_by = $4,
        approved_at = NOW()
      WHERE id = $1
    `, [driverId, reason, category || null, req.user.id]);

    // TODO: Send notification to driver

    res.json({ 
      message: 'Driver rejected',
      driverId,
      reason
    });
  } catch (error) {
    console.error('[Orgs] Reject driver error:', error);
    res.status(500).json({ error: 'Failed to reject driver' });
  }
});

// DELETE /api/orgs/:orgId/drivers/:driverId - Remove driver from org
router.delete('/:orgId/drivers/:driverId', authenticate, requireOrgRole('carrier_admin'), async (req, res) => {
  try {
    const { orgId, driverId } = req.params;
    const { reason } = req.body;

    // Check for active loads
    const activeLoads = await pool.query(`
      SELECT id FROM loads
      WHERE driver_id = $1 AND status IN ('assigned', 'en_route_pickup', 'picked_up', 'en_route_delivery')
    `, [driverId]);

    if (activeLoads.rows.length > 0) {
      return res.status(400).json({ 
        error: 'Cannot remove driver with active loads',
        activeLoadCount: activeLoads.rows.length
      });
    }

    // Deactivate membership
    await pool.query(`
      UPDATE memberships
      SET is_active = false
      WHERE user_id = $1 AND org_id = $2
    `, [driverId, orgId]);

    res.json({ message: 'Driver removed from organization' });
  } catch (error) {
    console.error('[Orgs] Remove driver error:', error);
    res.status(500).json({ error: 'Failed to remove driver' });
  }
});

// ============================================
// DOCUMENT REVIEW
// ============================================

// GET /api/orgs/:orgId/documents/pending - Get pending documents
router.get('/:orgId/documents/pending', authenticate, requireOrgRole('carrier_admin', 'dispatcher'), async (req, res) => {
  try {
    const { orgId } = req.params;

    const result = await pool.query(`
      SELECT 
        d.id,
        d.user_id,
        d.document_type,
        d.file_url,
        d.file_name,
        d.status,
        d.expires_at,
        d.uploaded_at,
        u.first_name,
        u.last_name,
        u.email,
        u.profile_picture_url
      FROM driver_documents d
      JOIN users u ON d.user_id = u.id
      JOIN memberships m ON u.id = m.user_id
      WHERE m.org_id = $1 AND m.role = 'driver' AND m.is_active = true
        AND d.status = 'pending'
      ORDER BY d.uploaded_at ASC
    `, [orgId]);

    res.json({ documents: result.rows });
  } catch (error) {
    console.error('[Orgs] Get pending docs error:', error);
    res.status(500).json({ error: 'Failed to get pending documents' });
  }
});

// PUT /api/orgs/:orgId/documents/:docId/review - Review document
router.put('/:orgId/documents/:docId/review', authenticate, requireOrgRole('carrier_admin'), async (req, res) => {
  try {
    const { orgId, docId } = req.params;
    const { action, rejectionReason, expiresAt } = req.body;

    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'Action must be approve or reject' });
    }

    if (action === 'reject' && !rejectionReason) {
      return res.status(400).json({ error: 'Rejection reason required' });
    }

    // Verify document belongs to a driver in this org
    const docCheck = await pool.query(`
      SELECT d.id, d.user_id, d.document_type
      FROM driver_documents d
      JOIN memberships m ON d.user_id = m.user_id
      WHERE d.id = $1 AND m.org_id = $2 AND m.is_active = true
    `, [docId, orgId]);

    if (docCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const doc = docCheck.rows[0];

    // Update document status
    if (action === 'approve') {
      await pool.query(`
        UPDATE driver_documents
        SET 
          status = 'approved',
          reviewed_at = NOW(),
          expires_at = $2,
          rejection_reason = NULL
        WHERE id = $1
      `, [docId, expiresAt || null]);
    } else {
      await pool.query(`
        UPDATE driver_documents
        SET 
          status = 'rejected',
          reviewed_at = NOW(),
          rejection_reason = $2
        WHERE id = $1
      `, [docId, rejectionReason]);
    }

    // Check if all docs now approved for this driver
    const docStatus = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status = 'approved') as approved,
        COUNT(*) FILTER (WHERE status = 'pending') as pending,
        COUNT(*) FILTER (WHERE status = 'rejected') as rejected
      FROM driver_documents
      WHERE user_id = $1
    `, [doc.user_id]);

    const counts = docStatus.rows[0];

    // Update driver's approval status if all docs approved
    if (parseInt(counts.pending) === 0 && parseInt(counts.rejected) === 0 && parseInt(counts.approved) > 0) {
      await pool.query(`
        UPDATE users
        SET approval_status = 'documents_approved'
        WHERE id = $1 AND approval_status IN ('pending_documents', 'documents_submitted')
      `, [doc.user_id]);
    }

    res.json({ 
      message: `Document ${action}d`,
      documentId: docId,
      driverId: doc.user_id,
      documentType: doc.document_type,
      newStatus: action === 'approve' ? 'approved' : 'rejected',
      driverDocStatus: {
        approved: parseInt(counts.approved),
        pending: parseInt(counts.pending),
        rejected: parseInt(counts.rejected)
      }
    });
  } catch (error) {
    console.error('[Orgs] Review document error:', error);
    res.status(500).json({ error: 'Failed to review document' });
  }
});

// ============================================
// COMPLIANCE
// ============================================

// GET /api/orgs/:orgId/compliance - Get compliance overview
router.get('/:orgId/compliance', authenticate, requireOrgRole('carrier_admin', 'dispatcher'), async (req, res) => {
  try {
    const { orgId } = req.params;
    const { daysAhead = 30 } = req.query;

    // Get expiring documents
    const expiringDocs = await pool.query(`
      SELECT 
        d.id,
        d.user_id,
        d.document_type,
        d.expires_at,
        d.status,
        u.first_name,
        u.last_name,
        u.email,
        EXTRACT(DAY FROM d.expires_at - NOW()) as days_until_expiry
      FROM driver_documents d
      JOIN users u ON d.user_id = u.id
      JOIN memberships m ON u.id = m.user_id
      WHERE m.org_id = $1 AND m.role = 'driver' AND m.is_active = true
        AND d.status = 'approved'
        AND d.expires_at IS NOT NULL
        AND d.expires_at <= NOW() + INTERVAL '1 day' * $2
      ORDER BY d.expires_at ASC
    `, [orgId, parseInt(daysAhead)]);

    // Get driver compliance summary
    const driverSummary = await pool.query(`
      SELECT 
        u.id,
        u.first_name,
        u.last_name,
        u.approval_status,
        COUNT(d.id) FILTER (WHERE d.status = 'approved') as approved_docs,
        COUNT(d.id) FILTER (WHERE d.status = 'pending') as pending_docs,
        COUNT(d.id) FILTER (WHERE d.status = 'rejected') as rejected_docs,
        COUNT(d.id) FILTER (WHERE d.expires_at < NOW()) as expired_docs,
        MIN(d.expires_at) FILTER (WHERE d.status = 'approved' AND d.expires_at > NOW()) as next_expiry
      FROM users u
      JOIN memberships m ON u.id = m.user_id
      LEFT JOIN driver_documents d ON u.id = d.user_id
      WHERE m.org_id = $1 AND m.role = 'driver' AND m.is_active = true
      GROUP BY u.id, u.first_name, u.last_name, u.approval_status
      ORDER BY expired_docs DESC, pending_docs DESC, next_expiry ASC
    `, [orgId]);

    // Count summary
    const summary = {
      totalDrivers: driverSummary.rows.length,
      approvedDrivers: driverSummary.rows.filter(d => d.approval_status === 'approved').length,
      pendingDrivers: driverSummary.rows.filter(d => ['pending', 'pending_documents', 'documents_submitted'].includes(d.approval_status)).length,
      expiringDocuments: expiringDocs.rows.length,
      expiredDocuments: expiringDocs.rows.filter(d => d.days_until_expiry <= 0).length
    };

    res.json({
      summary,
      expiringDocuments: expiringDocs.rows,
      driverCompliance: driverSummary.rows
    });
  } catch (error) {
    console.error('[Orgs] Compliance error:', error);
    res.status(500).json({ error: 'Failed to get compliance data' });
  }
});

// ============================================
// PLATFORM ADMIN: Document Review (for both carrier and platform admin)
// ============================================

// PUT /api/documents/:docId/admin-review - Platform admin review
router.put('/documents/:docId/admin-review', authenticate, async (req, res) => {
  try {
    // Check if user is platform admin
    const isAdmin = await isPlatformAdmin(req.user.id);
    if (!isAdmin) {
      return res.status(403).json({ error: 'Platform admin access required' });
    }

    const { docId } = req.params;
    const { action, rejectionReason, expiresAt } = req.body;

    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'Action must be approve or reject' });
    }

    // Get document
    const docResult = await pool.query(
      `SELECT * FROM driver_documents WHERE id = $1`,
      [docId]
    );

    if (docResult.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const doc = docResult.rows[0];

    // Update document
    if (action === 'approve') {
      await pool.query(`
        UPDATE driver_documents
        SET status = 'approved', reviewed_at = NOW(), expires_at = $2
        WHERE id = $1
      `, [docId, expiresAt || null]);
    } else {
      await pool.query(`
        UPDATE driver_documents
        SET status = 'rejected', reviewed_at = NOW(), rejection_reason = $2
        WHERE id = $1
      `, [docId, rejectionReason]);
    }

    res.json({
      message: `Document ${action}d by platform admin`,
      documentId: docId
    });
  } catch (error) {
    console.error('[Orgs] Admin review error:', error);
    res.status(500).json({ error: 'Failed to review document' });
  }
});

module.exports = router;
