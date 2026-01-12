// Company Routes - Team management
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { pool } = require('../db/pool');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// Middleware: Check if user is admin/owner
const requireAdmin = async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT shipper_role, company_id FROM users WHERE id = $1',
      [req.user.id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const { shipper_role, company_id } = result.rows[0];
    
    // If no company, treat user as owner of their own "solo" account
    if (!company_id) {
      req.companyId = null;
      req.shipperRole = 'owner';
      return next();
    }
    
    if (!['admin', 'owner'].includes(shipper_role)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    
    req.companyId = company_id;
    req.shipperRole = shipper_role;
    next();
  } catch (error) {
    console.error('[Company] Auth check error:', error);
    res.status(500).json({ error: 'Authorization failed' });
  }
};

/**
 * GET /company/team
 * Get all team members
 */
router.get('/team', authenticate, requireAdmin, async (req, res) => {
  try {
    // If no company, return just the current user
    if (!req.companyId) {
      const userResult = await pool.query(
        `SELECT id, email, first_name, last_name, phone, shipper_role, 
                is_active, created_at, last_login_at
         FROM users WHERE id = $1`,
        [req.user.id]
      );
      
      if (userResult.rows.length === 0) {
        return res.json({ members: [] });
      }
      
      const row = userResult.rows[0];
      return res.json({
        members: [{
          id: row.id,
          email: row.email,
          firstName: row.first_name,
          lastName: row.last_name,
          phone: row.phone,
          shipperRole: 'owner',
          department: null,
          isActive: row.is_active,
          createdAt: row.created_at,
          lastLoginAt: row.last_login_at,
        }]
      });
    }
    
    const result = await pool.query(
      `SELECT 
        id, email, first_name, last_name, phone,
        shipper_role, department, is_active,
        created_at, last_login_at
       FROM users 
       WHERE company_id = $1 AND role = 'shipper'
       ORDER BY created_at DESC`,
      [req.companyId]
    );

    const members = result.rows.map(row => ({
      id: row.id,
      email: row.email,
      firstName: row.first_name,
      lastName: row.last_name,
      phone: row.phone,
      shipperRole: row.shipper_role || 'viewer',
      department: row.department,
      isActive: row.is_active,
      createdAt: row.created_at,
      lastLoginAt: row.last_login_at,
    }));

    res.json({ members });
  } catch (error) {
    console.error('[Company] Get team error:', error);
    res.status(500).json({ error: 'Failed to get team members' });
  }
});

/**
 * PUT /company/team/:userId/role
 * Update team member's role
 */
router.put('/team/:userId/role', authenticate, requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { role } = req.body;

    const validRoles = ['admin', 'approver', 'shipper', 'verifier', 'viewer'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    // Check if user belongs to same company
    const userCheck = await pool.query(
      'SELECT company_id, shipper_role FROM users WHERE id = $1',
      [userId]
    );

    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (userCheck.rows[0].company_id !== req.companyId) {
      return res.status(403).json({ error: 'User not in your company' });
    }

    // Can't demote an owner
    if (userCheck.rows[0].shipper_role === 'owner' && req.shipperRole !== 'owner') {
      return res.status(403).json({ error: 'Cannot modify owner role' });
    }

    await pool.query(
      'UPDATE users SET shipper_role = $1, updated_at = NOW() WHERE id = $2',
      [role, userId]
    );

    res.json({ message: 'Role updated successfully' });
  } catch (error) {
    console.error('[Company] Update role error:', error);
    res.status(500).json({ error: 'Failed to update role' });
  }
});

/**
 * PUT /company/team/:userId/status
 * Activate/deactivate team member
 */
router.put('/team/:userId/status', authenticate, requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { isActive } = req.body;

    // Check if user belongs to same company
    const userCheck = await pool.query(
      'SELECT company_id, shipper_role FROM users WHERE id = $1',
      [userId]
    );

    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (userCheck.rows[0].company_id !== req.companyId) {
      return res.status(403).json({ error: 'User not in your company' });
    }

    // Can't deactivate owner
    if (userCheck.rows[0].shipper_role === 'owner') {
      return res.status(403).json({ error: 'Cannot deactivate owner' });
    }

    await pool.query(
      'UPDATE users SET is_active = $1, updated_at = NOW() WHERE id = $2',
      [isActive, userId]
    );

    res.json({ message: isActive ? 'Account activated' : 'Account deactivated' });
  } catch (error) {
    console.error('[Company] Update status error:', error);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

/**
 * POST /company/team/:userId/reset-password
 * Send password reset email to team member
 */
router.post('/team/:userId/reset-password', authenticate, requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;

    // Check if user belongs to same company
    const userCheck = await pool.query(
      'SELECT company_id, email, first_name FROM users WHERE id = $1',
      [userId]
    );

    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (userCheck.rows[0].company_id !== req.companyId) {
      return res.status(403).json({ error: 'User not in your company' });
    }

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    // Store reset token (you'd need a password_resets table or store on user)
    // For now, just return success (implement email sending later)
    
    console.log(`[Company] Password reset requested for ${userCheck.rows[0].email}`);

    res.json({ message: 'Password reset email sent' });
  } catch (error) {
    console.error('[Company] Reset password error:', error);
    res.status(500).json({ error: 'Failed to send reset email' });
  }
});

/**
 * POST /company/invite
 * Send invitation to new team member
 */
router.post('/invite', authenticate, requireAdmin, async (req, res) => {
  try {
    const { email, firstName, lastName, role, department } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
    
    // If no company, create one first
    if (!req.companyId) {
      return res.status(400).json({ 
        error: 'Please set up your company first',
        code: 'NO_COMPANY'
      });
    }

    const validRoles = ['admin', 'approver', 'shipper', 'verifier', 'viewer'];
    if (role && !validRoles.includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    // Check if email already in company
    const existingUser = await pool.query(
      'SELECT id FROM users WHERE email = $1 AND company_id = $2',
      [email.toLowerCase(), req.companyId]
    );

    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: 'User already in company' });
    }

    // Check for existing pending invitation
    const existingInvite = await pool.query(
      `SELECT id FROM company_invitations 
       WHERE email = $1 AND company_id = $2 AND status = 'pending'`,
      [email.toLowerCase(), req.companyId]
    );

    if (existingInvite.rows.length > 0) {
      return res.status(400).json({ error: 'Invitation already pending for this email' });
    }

    // Check user limit
    const countResult = await pool.query(
      'SELECT COUNT(*) as count FROM users WHERE company_id = $1 AND is_active = true',
      [req.companyId]
    );
    
    const planResult = await pool.query(
      `SELECT sp.max_users FROM companies c
       JOIN subscription_plans sp ON c.plan_id = sp.id
       WHERE c.id = $1`,
      [req.companyId]
    );

    if (planResult.rows.length > 0) {
      const currentCount = parseInt(countResult.rows[0].count);
      const maxUsers = planResult.rows[0].max_users;
      
      if (currentCount >= maxUsers) {
        return res.status(403).json({ 
          error: 'User limit reached. Please upgrade your plan.',
          code: 'USER_LIMIT_REACHED'
        });
      }
    }

    // Generate invitation token
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    await pool.query(
      `INSERT INTO company_invitations 
       (company_id, email, first_name, last_name, role, department, invited_by, token, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        req.companyId,
        email.toLowerCase(),
        firstName || null,
        lastName || null,
        role || 'viewer',
        department || null,
        req.user.id,
        token,
        expiresAt
      ]
    );

    // TODO: Send email with invitation link
    console.log(`[Company] Invitation sent to ${email} with token ${token}`);

    res.status(201).json({ 
      message: 'Invitation sent',
      token // Include for testing - remove in production
    });
  } catch (error) {
    console.error('[Company] Invite error:', error);
    res.status(500).json({ error: 'Failed to send invitation' });
  }
});

/**
 * GET /company/invitations
 * Get all pending invitations
 */
router.get('/invitations', authenticate, requireAdmin, async (req, res) => {
  try {
    // If no company, return empty
    if (!req.companyId) {
      return res.json({ invitations: [] });
    }
    
    const result = await pool.query(
      `SELECT 
        id, email, first_name, last_name, role, department,
        status, expires_at, created_at
       FROM company_invitations
       WHERE company_id = $1
       ORDER BY created_at DESC`,
      [req.companyId]
    );

    const invitations = result.rows.map(row => ({
      id: row.id,
      email: row.email,
      firstName: row.first_name,
      lastName: row.last_name,
      role: row.role,
      department: row.department,
      status: row.status,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    }));

    res.json({ invitations });
  } catch (error) {
    console.error('[Company] Get invitations error:', error);
    res.status(500).json({ error: 'Failed to get invitations' });
  }
});

/**
 * DELETE /company/invitations/:inviteId
 * Cancel an invitation
 */
router.delete('/invitations/:inviteId', authenticate, requireAdmin, async (req, res) => {
  try {
    const { inviteId } = req.params;

    const result = await pool.query(
      `UPDATE company_invitations 
       SET status = 'cancelled'
       WHERE id = $1 AND company_id = $2
       RETURNING id`,
      [inviteId, req.companyId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Invitation not found' });
    }

    res.json({ message: 'Invitation cancelled' });
  } catch (error) {
    console.error('[Company] Cancel invitation error:', error);
    res.status(500).json({ error: 'Failed to cancel invitation' });
  }
});

/**
 * POST /company/invitations/:inviteId/resend
 * Resend an invitation
 */
router.post('/invitations/:inviteId/resend', authenticate, requireAdmin, async (req, res) => {
  try {
    const { inviteId } = req.params;

    // Generate new token and extend expiry
    const newToken = crypto.randomBytes(32).toString('hex');
    const newExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const result = await pool.query(
      `UPDATE company_invitations 
       SET token = $1, expires_at = $2, status = 'pending'
       WHERE id = $3 AND company_id = $4
       RETURNING email`,
      [newToken, newExpiry, inviteId, req.companyId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Invitation not found' });
    }

    // TODO: Resend email
    console.log(`[Company] Invitation resent to ${result.rows[0].email}`);

    res.json({ message: 'Invitation resent' });
  } catch (error) {
    console.error('[Company] Resend invitation error:', error);
    res.status(500).json({ error: 'Failed to resend invitation' });
  }
});

/**
 * GET /company/info
 * Get company information (with graceful fallback for solo users)
 */
router.get('/info', authenticate, async (req, res) => {
  try {
    // Get user's company
    const userResult = await pool.query(
      'SELECT company_id, first_name, last_name, email, company_name FROM users WHERE id = $1',
      [req.user.id]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];

    // If no company, return default solo company info
    if (!user.company_id) {
      return res.json({
        company: {
          id: null,
          name: user.company_name || `${user.first_name || 'My'} ${user.last_name || 'Company'}`.trim(),
          displayName: user.company_name || null,
          email: user.email,
          phone: null,
          address: null,
          city: null,
          state: null,
          zip: null,
          logoUrl: null,
          plan: {
            id: 'free',
            name: 'Free',
            maxUsers: 1,
            priceMonthly: 0,
          },
          teamCount: 1,
          subscriptionStatus: 'active',
          createdAt: null,
          needsSetup: true, // Flag for frontend to show setup prompt
        }
      });
    }

    const companyId = user.company_id;

    const result = await pool.query(
      `SELECT c.*, sp.name as plan_name, sp.max_users, sp.price_monthly
       FROM companies c
       LEFT JOIN subscription_plans sp ON c.plan_id = sp.id
       WHERE c.id = $1`,
      [companyId]
    );

    if (result.rows.length === 0) {
      // Company ID set but company doesn't exist - return default
      return res.json({
        company: {
          id: null,
          name: user.company_name || 'My Company',
          displayName: null,
          email: user.email,
          phone: null,
          address: null,
          city: null,
          state: null,
          zip: null,
          logoUrl: null,
          plan: {
            id: 'free',
            name: 'Free',
            maxUsers: 1,
            priceMonthly: 0,
          },
          teamCount: 1,
          subscriptionStatus: 'active',
          createdAt: null,
          needsSetup: true,
        }
      });
    }

    const company = result.rows[0];

    // Get team count
    const countResult = await pool.query(
      'SELECT COUNT(*) as count FROM users WHERE company_id = $1 AND is_active = true',
      [companyId]
    );

    res.json({
      company: {
        id: company.id,
        name: company.name,
        displayName: company.display_name,
        email: company.email,
        phone: company.phone,
        address: company.address,
        city: company.city,
        state: company.state,
        zip: company.zip,
        logoUrl: company.logo_url,
        plan: {
          id: company.plan_id,
          name: company.plan_name || 'Free',
          maxUsers: company.max_users || 1,
          priceMonthly: company.price_monthly || 0,
        },
        teamCount: parseInt(countResult.rows[0].count),
        subscriptionStatus: company.subscription_status || 'active',
        createdAt: company.created_at,
        needsSetup: false,
      }
    });
  } catch (error) {
    console.error('[Company] Get info error:', error);
    res.status(500).json({ error: 'Failed to get company info' });
  }
});

/**
 * PUT /company/info
 * Update company information
 */
router.put('/info', authenticate, async (req, res) => {
  try {
    const { name, displayName, email, phone, address, city, state, zip } = req.body;
    
    // Get user's company
    const userResult = await pool.query(
      'SELECT company_id FROM users WHERE id = $1',
      [req.user.id]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const companyId = userResult.rows[0].company_id;

    // If no company exists, create one
    if (!companyId) {
      const newCompany = await pool.query(
        `INSERT INTO companies (name, display_name, email, phone, address, city, state, zip)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [name, displayName, email, phone, address, city, state, zip]
      );
      
      // Link user to new company
      await pool.query(
        'UPDATE users SET company_id = $1, shipper_role = $2 WHERE id = $3',
        [newCompany.rows[0].id, 'owner', req.user.id]
      );
      
      return res.json({ message: 'Company created successfully' });
    }

    // Update existing company
    await pool.query(
      `UPDATE companies SET 
        name = COALESCE($1, name),
        display_name = $2,
        email = COALESCE($3, email),
        phone = $4,
        address = $5,
        city = $6,
        state = $7,
        zip = $8,
        updated_at = NOW()
       WHERE id = $9`,
      [name, displayName, email, phone, address, city, state, zip, companyId]
    );

    res.json({ message: 'Company updated successfully' });
  } catch (error) {
    console.error('[Company] Update info error:', error);
    res.status(500).json({ error: 'Failed to update company info' });
  }
});

/**
 * POST /company/upgrade
 * Upgrade subscription plan
 */
router.post('/upgrade', authenticate, async (req, res) => {
  try {
    const { planId } = req.body;
    
    // Get user's company
    const userResult = await pool.query(
      'SELECT company_id, shipper_role FROM users WHERE id = $1',
      [req.user.id]
    );

    if (!userResult.rows[0]?.company_id) {
      return res.status(400).json({ error: 'Please set up your company first' });
    }
    
    if (!['admin', 'owner'].includes(userResult.rows[0].shipper_role)) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const companyId = userResult.rows[0].company_id;

    // Update plan
    await pool.query(
      'UPDATE companies SET plan_id = $1, updated_at = NOW() WHERE id = $2',
      [planId, companyId]
    );

    res.json({ message: 'Plan upgraded successfully' });
  } catch (error) {
    console.error('[Company] Upgrade error:', error);
    res.status(500).json({ error: 'Failed to upgrade plan' });
  }
});

module.exports = router;
