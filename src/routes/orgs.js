const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const auth = require('../middleware/auth');

// ═══════════════════════════════════════════════════════════════════════════════
// ORGANIZATIONS
// ═══════════════════════════════════════════════════════════════════════════════

// POST /orgs - Create a new organization
router.post('/', auth, async (req, res) => {
  const client = await pool.connect();
  
  try {
    const userId = req.user.id;
    const {
      orgType,
      name,
      dbaName,
      email,
      phone,
      address,
      city,
      state,
      zip,
      // Carrier fields
      mcNumber,
      dotNumber,
      // Broker fields
      brokerMcNumber,
      bondAmount,
      bondExpiry,
    } = req.body;

    // Validate required fields
    if (!orgType || !name) {
      return res.status(400).json({ error: 'Organization type and name are required' });
    }

    if (!['shipper', 'broker', 'carrier'].includes(orgType)) {
      return res.status(400).json({ error: 'Invalid organization type' });
    }

    await client.query('BEGIN');

    // Create the organization
    const orgResult = await client.query(`
      INSERT INTO orgs (
        org_type, name, dba_name, email, phone,
        address, city, state, zip,
        mc_number, dot_number,
        broker_mc_number, bond_amount, bond_expiry
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING *
    `, [
      orgType, name, dbaName, email, phone,
      address, city, state, zip,
      mcNumber, dotNumber,
      brokerMcNumber, bondAmount, bondExpiry
    ]);

    const org = orgResult.rows[0];

    // Determine admin role based on org type
    let adminRole;
    switch (orgType) {
      case 'shipper': adminRole = 'shipper_admin'; break;
      case 'broker': adminRole = 'broker_admin'; break;
      case 'carrier': adminRole = 'carrier_admin'; break;
    }

    // Create membership for the creator as admin
    await client.query(`
      INSERT INTO memberships (user_id, org_id, role, is_primary)
      VALUES ($1, $2, $3, true)
    `, [userId, org.id, adminRole]);

    // Initialize trust signals for carriers
    if (orgType === 'carrier') {
      await client.query(`
        INSERT INTO trust_signals (org_id)
        VALUES ($1)
      `, [org.id]);
    }

    await client.query('COMMIT');

    res.status(201).json({
      message: 'Organization created',
      org: formatOrg(org),
      role: adminRole
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Create org error:', error);
    res.status(500).json({ error: 'Failed to create organization' });
  } finally {
    client.release();
  }
});

// GET /orgs - List user's organizations
router.get('/', auth, async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await pool.query(`
      SELECT 
        o.*,
        m.role,
        m.is_primary,
        m.joined_at
      FROM orgs o
      JOIN memberships m ON o.id = m.org_id
      WHERE m.user_id = $1 AND m.is_active = true AND o.is_active = true
      ORDER BY m.is_primary DESC, m.joined_at ASC
    `, [userId]);

    res.json({
      orgs: result.rows.map(row => ({
        ...formatOrg(row),
        role: row.role,
        isPrimary: row.is_primary,
        joinedAt: row.joined_at
      }))
    });

  } catch (error) {
    console.error('List orgs error:', error);
    res.status(500).json({ error: 'Failed to list organizations' });
  }
});

// GET /orgs/:id - Get single organization
router.get('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    // Check membership
    const memberCheck = await pool.query(`
      SELECT role FROM memberships 
      WHERE user_id = $1 AND org_id = $2 AND is_active = true
    `, [userId, id]);

    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Not a member of this organization' });
    }

    const result = await pool.query(`
      SELECT o.*, ts.completion_rate, ts.on_time_rate, ts.claim_rate, ts.total_loads, ts.completed_loads
      FROM orgs o
      LEFT JOIN trust_signals ts ON o.id = ts.org_id
      WHERE o.id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    const org = result.rows[0];

    res.json({
      org: {
        ...formatOrg(org),
        trustSignals: {
          completionRate: org.completion_rate,
          onTimeRate: org.on_time_rate,
          claimRate: org.claim_rate,
          totalLoads: org.total_loads,
          completedLoads: org.completed_loads
        }
      },
      role: memberCheck.rows[0].role
    });

  } catch (error) {
    console.error('Get org error:', error);
    res.status(500).json({ error: 'Failed to get organization' });
  }
});

// PUT /orgs/:id - Update organization
router.put('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    // Check if user is admin
    const memberCheck = await pool.query(`
      SELECT role FROM memberships 
      WHERE user_id = $1 AND org_id = $2 AND is_active = true
    `, [userId, id]);

    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Not a member of this organization' });
    }

    const role = memberCheck.rows[0].role;
    if (!role.endsWith('_admin')) {
      return res.status(403).json({ error: 'Only admins can update organization' });
    }

    const {
      name,
      dbaName,
      email,
      phone,
      address,
      city,
      state,
      zip,
      mcNumber,
      dotNumber,
      brokerMcNumber,
      bondAmount,
      bondExpiry,
      paymentTerms
    } = req.body;

    const result = await pool.query(`
      UPDATE orgs SET
        name = COALESCE($1, name),
        dba_name = COALESCE($2, dba_name),
        email = COALESCE($3, email),
        phone = COALESCE($4, phone),
        address = COALESCE($5, address),
        city = COALESCE($6, city),
        state = COALESCE($7, state),
        zip = COALESCE($8, zip),
        mc_number = COALESCE($9, mc_number),
        dot_number = COALESCE($10, dot_number),
        broker_mc_number = COALESCE($11, broker_mc_number),
        bond_amount = COALESCE($12, bond_amount),
        bond_expiry = COALESCE($13, bond_expiry),
        payment_terms = COALESCE($14, payment_terms),
        updated_at = NOW()
      WHERE id = $15
      RETURNING *
    `, [
      name, dbaName, email, phone, address, city, state, zip,
      mcNumber, dotNumber, brokerMcNumber, bondAmount, bondExpiry,
      paymentTerms, id
    ]);

    res.json({
      message: 'Organization updated',
      org: formatOrg(result.rows[0])
    });

  } catch (error) {
    console.error('Update org error:', error);
    res.status(500).json({ error: 'Failed to update organization' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// MEMBERSHIPS
// ═══════════════════════════════════════════════════════════════════════════════

// GET /orgs/:id/members - List organization members
router.get('/:id/members', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    // Check membership
    const memberCheck = await pool.query(`
      SELECT role FROM memberships 
      WHERE user_id = $1 AND org_id = $2 AND is_active = true
    `, [userId, id]);

    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Not a member of this organization' });
    }

    const result = await pool.query(`
      SELECT 
        m.id as membership_id,
        m.role,
        m.is_primary,
        m.is_active,
        m.joined_at,
        m.permissions,
        u.id as user_id,
        u.email,
        u.first_name,
        u.last_name,
        u.phone,
        u.profile_image_url
      FROM memberships m
      JOIN users u ON m.user_id = u.id
      WHERE m.org_id = $1 AND m.is_active = true
      ORDER BY m.is_primary DESC, m.joined_at ASC
    `, [id]);

    res.json({
      members: result.rows.map(row => ({
        membershipId: row.membership_id,
        role: row.role,
        isPrimary: row.is_primary,
        joinedAt: row.joined_at,
        permissions: row.permissions,
        user: {
          id: row.user_id,
          email: row.email,
          firstName: row.first_name,
          lastName: row.last_name,
          phone: row.phone,
          profileImageUrl: row.profile_image_url
        }
      }))
    });

  } catch (error) {
    console.error('List members error:', error);
    res.status(500).json({ error: 'Failed to list members' });
  }
});

// PUT /orgs/:id/members/:userId - Update member role
router.put('/:id/members/:memberId', auth, async (req, res) => {
  try {
    const { id, memberId } = req.params;
    const userId = req.user.id;
    const { role, permissions } = req.body;

    // Check if requester is admin
    const adminCheck = await pool.query(`
      SELECT role FROM memberships 
      WHERE user_id = $1 AND org_id = $2 AND is_active = true
    `, [userId, id]);

    if (adminCheck.rows.length === 0 || !adminCheck.rows[0].role.endsWith('_admin')) {
      return res.status(403).json({ error: 'Only admins can update members' });
    }

    // Get org type to validate role
    const orgResult = await pool.query('SELECT org_type FROM orgs WHERE id = $1', [id]);
    const orgType = orgResult.rows[0].org_type;

    // Validate role matches org type
    const validRoles = {
      shipper: ['shipper_admin', 'shipping_clerk'],
      broker: ['broker_admin', 'broker_agent'],
      carrier: ['carrier_admin', 'dispatcher', 'driver']
    };

    if (role && !validRoles[orgType].includes(role)) {
      return res.status(400).json({ error: `Invalid role for ${orgType} organization` });
    }

    const result = await pool.query(`
      UPDATE memberships SET
        role = COALESCE($1, role),
        permissions = COALESCE($2, permissions)
      WHERE id = $3 AND org_id = $4
      RETURNING *
    `, [role, permissions ? JSON.stringify(permissions) : null, memberId, id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Membership not found' });
    }

    res.json({
      message: 'Member updated',
      membership: {
        id: result.rows[0].id,
        role: result.rows[0].role,
        permissions: result.rows[0].permissions
      }
    });

  } catch (error) {
    console.error('Update member error:', error);
    res.status(500).json({ error: 'Failed to update member' });
  }
});

// DELETE /orgs/:id/members/:memberId - Remove member
router.delete('/:id/members/:memberId', auth, async (req, res) => {
  try {
    const { id, memberId } = req.params;
    const userId = req.user.id;

    // Check if requester is admin
    const adminCheck = await pool.query(`
      SELECT role FROM memberships 
      WHERE user_id = $1 AND org_id = $2 AND is_active = true
    `, [userId, id]);

    if (adminCheck.rows.length === 0 || !adminCheck.rows[0].role.endsWith('_admin')) {
      return res.status(403).json({ error: 'Only admins can remove members' });
    }

    // Can't remove yourself if you're the only admin
    const memberResult = await pool.query(`
      SELECT user_id, role FROM memberships WHERE id = $1 AND org_id = $2
    `, [memberId, id]);

    if (memberResult.rows.length === 0) {
      return res.status(404).json({ error: 'Membership not found' });
    }

    if (memberResult.rows[0].user_id === userId) {
      const adminCount = await pool.query(`
        SELECT COUNT(*) FROM memberships 
        WHERE org_id = $1 AND role LIKE '%_admin' AND is_active = true
      `, [id]);

      if (parseInt(adminCount.rows[0].count) <= 1) {
        return res.status(400).json({ error: 'Cannot remove the only admin' });
      }
    }

    // Soft delete
    await pool.query(`
      UPDATE memberships SET is_active = false WHERE id = $1
    `, [memberId]);

    res.json({ message: 'Member removed' });

  } catch (error) {
    console.error('Remove member error:', error);
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// INVITES
// ═══════════════════════════════════════════════════════════════════════════════

// POST /orgs/:id/invites - Create invite
router.post('/:id/invites', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const { email, role } = req.body;

    if (!email || !role) {
      return res.status(400).json({ error: 'Email and role are required' });
    }

    // Check if requester is admin
    const adminCheck = await pool.query(`
      SELECT role FROM memberships 
      WHERE user_id = $1 AND org_id = $2 AND is_active = true
    `, [userId, id]);

    if (adminCheck.rows.length === 0 || !adminCheck.rows[0].role.endsWith('_admin')) {
      return res.status(403).json({ error: 'Only admins can send invites' });
    }

    // Get org to validate role
    const orgResult = await pool.query('SELECT org_type, name FROM orgs WHERE id = $1', [id]);
    if (orgResult.rows.length === 0) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    const org = orgResult.rows[0];
    const validRoles = {
      shipper: ['shipper_admin', 'shipping_clerk'],
      broker: ['broker_admin', 'broker_agent'],
      carrier: ['carrier_admin', 'dispatcher', 'driver']
    };

    if (!validRoles[org.org_type].includes(role)) {
      return res.status(400).json({ error: `Invalid role for ${org.org_type} organization` });
    }

    // Check if already a member
    const existingMember = await pool.query(`
      SELECT m.id FROM memberships m
      JOIN users u ON m.user_id = u.id
      WHERE u.email = $1 AND m.org_id = $2 AND m.is_active = true
    `, [email, id]);

    if (existingMember.rows.length > 0) {
      return res.status(400).json({ error: 'User is already a member' });
    }

    // Check for pending invite
    const existingInvite = await pool.query(`
      SELECT id FROM org_invites 
      WHERE email = $1 AND org_id = $2 AND status = 'pending' AND expires_at > NOW()
    `, [email, id]);

    if (existingInvite.rows.length > 0) {
      return res.status(400).json({ error: 'Pending invite already exists for this email' });
    }

    // Create invite
    const result = await pool.query(`
      INSERT INTO org_invites (org_id, invited_by, email, role)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [id, userId, email, role]);

    const invite = result.rows[0];

    // TODO: Send email with invite link
    // const inviteUrl = `${process.env.APP_URL}/invite/${invite.token}`;

    res.status(201).json({
      message: 'Invite sent',
      invite: {
        id: invite.id,
        email: invite.email,
        role: invite.role,
        token: invite.token,
        expiresAt: invite.expires_at
      }
    });

  } catch (error) {
    console.error('Create invite error:', error);
    res.status(500).json({ error: 'Failed to create invite' });
  }
});

// GET /orgs/:id/invites - List pending invites
router.get('/:id/invites', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    // Check membership
    const memberCheck = await pool.query(`
      SELECT role FROM memberships 
      WHERE user_id = $1 AND org_id = $2 AND is_active = true
    `, [userId, id]);

    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Not a member of this organization' });
    }

    const result = await pool.query(`
      SELECT i.*, u.first_name as invited_by_name, u.email as invited_by_email
      FROM org_invites i
      JOIN users u ON i.invited_by = u.id
      WHERE i.org_id = $1 AND i.status = 'pending' AND i.expires_at > NOW()
      ORDER BY i.created_at DESC
    `, [id]);

    res.json({
      invites: result.rows.map(row => ({
        id: row.id,
        email: row.email,
        role: row.role,
        status: row.status,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        invitedBy: {
          name: row.invited_by_name,
          email: row.invited_by_email
        }
      }))
    });

  } catch (error) {
    console.error('List invites error:', error);
    res.status(500).json({ error: 'Failed to list invites' });
  }
});

// DELETE /orgs/:id/invites/:inviteId - Cancel invite
router.delete('/:id/invites/:inviteId', auth, async (req, res) => {
  try {
    const { id, inviteId } = req.params;
    const userId = req.user.id;

    // Check if requester is admin
    const adminCheck = await pool.query(`
      SELECT role FROM memberships 
      WHERE user_id = $1 AND org_id = $2 AND is_active = true
    `, [userId, id]);

    if (adminCheck.rows.length === 0 || !adminCheck.rows[0].role.endsWith('_admin')) {
      return res.status(403).json({ error: 'Only admins can cancel invites' });
    }

    await pool.query(`
      UPDATE org_invites SET status = 'expired' 
      WHERE id = $1 AND org_id = $2
    `, [inviteId, id]);

    res.json({ message: 'Invite cancelled' });

  } catch (error) {
    console.error('Cancel invite error:', error);
    res.status(500).json({ error: 'Failed to cancel invite' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ACCEPT INVITE (Public route - uses token)
// ═══════════════════════════════════════════════════════════════════════════════

// POST /orgs/invites/:token/accept - Accept invite
router.post('/invites/:token/accept', auth, async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { token } = req.params;
    const userId = req.user.id;

    await client.query('BEGIN');

    // Get invite
    const inviteResult = await client.query(`
      SELECT i.*, o.name as org_name, o.org_type
      FROM org_invites i
      JOIN orgs o ON i.org_id = o.id
      WHERE i.token = $1 AND i.status = 'pending' AND i.expires_at > NOW()
    `, [token]);

    if (inviteResult.rows.length === 0) {
      return res.status(404).json({ error: 'Invalid or expired invite' });
    }

    const invite = inviteResult.rows[0];

    // Check if user email matches invite (optional - could allow any logged in user)
    const userResult = await client.query('SELECT email FROM users WHERE id = $1', [userId]);
    const userEmail = userResult.rows[0].email;

    if (userEmail.toLowerCase() !== invite.email.toLowerCase()) {
      return res.status(403).json({ 
        error: 'This invite was sent to a different email address',
        inviteEmail: invite.email 
      });
    }

    // Check if already a member
    const existingMember = await client.query(`
      SELECT id FROM memberships 
      WHERE user_id = $1 AND org_id = $2 AND is_active = true
    `, [userId, invite.org_id]);

    if (existingMember.rows.length > 0) {
      return res.status(400).json({ error: 'You are already a member of this organization' });
    }

    // Create membership
    await client.query(`
      INSERT INTO memberships (user_id, org_id, role)
      VALUES ($1, $2, $3)
    `, [userId, invite.org_id, invite.role]);

    // Update invite status
    await client.query(`
      UPDATE org_invites SET status = 'accepted', accepted_at = NOW()
      WHERE id = $1
    `, [invite.id]);

    await client.query('COMMIT');

    res.json({
      message: 'Invite accepted',
      org: {
        id: invite.org_id,
        name: invite.org_name,
        type: invite.org_type
      },
      role: invite.role
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Accept invite error:', error);
    res.status(500).json({ error: 'Failed to accept invite' });
  } finally {
    client.release();
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET INVITE INFO (Public - for showing invite details before accepting)
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/invites/:token', async (req, res) => {
  try {
    const { token } = req.params;

    const result = await pool.query(`
      SELECT i.email, i.role, i.expires_at, o.name as org_name, o.org_type
      FROM org_invites i
      JOIN orgs o ON i.org_id = o.id
      WHERE i.token = $1 AND i.status = 'pending' AND i.expires_at > NOW()
    `, [token]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Invalid or expired invite' });
    }

    const invite = result.rows[0];

    res.json({
      invite: {
        email: invite.email,
        role: invite.role,
        expiresAt: invite.expires_at,
        org: {
          name: invite.org_name,
          type: invite.org_type
        }
      }
    });

  } catch (error) {
    console.error('Get invite error:', error);
    res.status(500).json({ error: 'Failed to get invite info' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function formatOrg(org) {
  return {
    id: org.id,
    type: org.org_type,
    name: org.name,
    dbaName: org.dba_name,
    email: org.email,
    phone: org.phone,
    address: org.address,
    city: org.city,
    state: org.state,
    zip: org.zip,
    // Carrier
    mcNumber: org.mc_number,
    dotNumber: org.dot_number,
    authorityStatus: org.authority_status,
    // Broker
    brokerMcNumber: org.broker_mc_number,
    bondAmount: org.bond_amount,
    bondExpiry: org.bond_expiry,
    // Status
    verificationStatus: org.verification_status,
    verifiedAt: org.verified_at,
    // Trust
    loadsCompleted: org.loads_completed,
    onTimeRate: org.on_time_rate,
    claimRate: org.claim_rate,
    // Billing
    paymentTerms: org.payment_terms,
    // Meta
    isActive: org.is_active,
    createdAt: org.created_at,
    updatedAt: org.updated_at
  };
}

module.exports = router;
