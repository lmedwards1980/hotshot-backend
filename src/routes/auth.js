// Auth Routes - With Company & Team Support + Org/Role Model
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { pool } = require('../db/pool');
const { generateToken, authenticate } = require('../middleware/auth');

const router = express.Router();

/**
 * Helper: Generate URL-safe slug from company name
 */
const generateSlug = (name) => {
  let slug = name.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return slug + '-' + crypto.randomBytes(3).toString('hex');
};

/**
 * Helper: Get user's orgs and roles
 */
const getUserOrgs = async (userId) => {
  const result = await pool.query(`
    SELECT 
      o.id,
      o.org_type as type,
      o.name,
      o.verification_status,
      m.role,
      m.is_primary,
      m.permissions
    FROM memberships m
    JOIN orgs o ON m.org_id = o.id
    WHERE m.user_id = $1 AND m.is_active = true AND o.is_active = true
    ORDER BY m.is_primary DESC, m.joined_at ASC
  `, [userId]);
  
  return result.rows.map(row => ({
    id: row.id,
    type: row.type,
    name: row.name,
    verificationStatus: row.verification_status,
    role: row.role,
    isPrimary: row.is_primary,
    permissions: row.permissions
  }));
};

/**
 * Helper: Create org and membership for user
 */
const createOrgForUser = async (client, userId, orgData) => {
  const { orgType, orgName, mcNumber, dotNumber, brokerMcNumber } = orgData;
  
  if (!orgType || !orgName) return null;
  
  if (!['shipper', 'broker', 'carrier'].includes(orgType)) return null;

  // Create org
  const orgResult = await client.query(`
    INSERT INTO orgs (org_type, name, mc_number, dot_number, broker_mc_number)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING *
  `, [orgType, orgName, mcNumber || null, dotNumber || null, brokerMcNumber || null]);

  const org = orgResult.rows[0];

  // Determine admin role
  let adminRole;
  switch (orgType) {
    case 'shipper': adminRole = 'shipper_admin'; break;
    case 'broker': adminRole = 'broker_admin'; break;
    case 'carrier': adminRole = 'carrier_admin'; break;
  }

  // Create membership
  await client.query(`
    INSERT INTO memberships (user_id, org_id, role, is_primary)
    VALUES ($1, $2, $3, true)
  `, [userId, org.id, adminRole]);

  // Initialize trust signals for carriers
  if (orgType === 'carrier') {
    try {
      await client.query(`INSERT INTO trust_signals (org_id) VALUES ($1)`, [org.id]);
    } catch (e) {
      console.log('[Auth] Trust signals table may not exist, skipping');
    }
  }

  return {
    id: org.id,
    type: org.org_type,
    name: org.name,
    verificationStatus: org.verification_status,
    role: adminRole,
    isPrimary: true
  };
};

/**
 * POST /auth/register
 * Register a new user (optionally with org)
 */
router.post('/register', async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      email,
      password,
      firstName,
      lastName,
      phone,
      // Account type: 'solo' or 'company'
      accountType = 'solo',
      // Company fields (if accountType === 'company')
      companyName,
      department,
      jobTitle,
      // NEW: Org fields for new org model
      orgType,      // 'shipper', 'broker', 'carrier'
      orgName,      // Organization name
      mcNumber,     // Carrier MC number
      dotNumber,    // Carrier DOT number
      brokerMcNumber, // Broker MC number
      // Legacy support
      name,
      userType,
      role,
      referralCode
    } = req.body;

    // Handle legacy 'name' field
    let fName = firstName;
    let lName = lastName;
    if (!fName && name) {
      const nameParts = name.trim().split(' ');
      fName = nameParts[0] || '';
      lName = nameParts.slice(1).join(' ') || '';
    }

    // Determine role
    const userRole = role || userType || 'shipper';

    // Validate required fields
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Check if email already exists
    const existing = await client.query(
      'SELECT id FROM users WHERE email = $1',
      [email.toLowerCase()]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({
        error: 'Email already registered',
        code: 'USER_EXISTS'
      });
    }

    await client.query('BEGIN');

    // Hash password
    const passwordHash = await bcrypt.hash(password, 12);

    // Generate referral code
    const newReferralCode = `${(fName || 'USR').substring(0, 3).toUpperCase()}${Date.now().toString(36).toUpperCase()}`.substring(0, 8);

    // Check referral code
    let referredById = null;
    if (referralCode) {
      const referrer = await client.query(
        'SELECT id FROM users WHERE referral_code = $1',
        [referralCode.toUpperCase()]
      );
      if (referrer.rows.length > 0) {
        referredById = referrer.rows[0].id;
      }
    }

    let companyId = null;
    // FIX: Use NULL for org-based registration, 'shipper' for legacy (valid constraint value)
    let shipperRole = null;
    let userCompanyName = null;

    // Handle company account type (legacy) - only if NOT using new org model
    if (!orgType && accountType === 'company' && companyName) {
      const slug = generateSlug(companyName);

      const companyResult = await client.query(
        `INSERT INTO companies (name, display_name, slug, email, plan_id, subscription_status, subscription_started_at)
         VALUES ($1, $2, $3, $4, 'solo', 'active', NOW())
         RETURNING id`,
        [companyName.trim(), companyName.trim(), slug, email.toLowerCase()]
      );

      companyId = companyResult.rows[0].id;
      shipperRole = 'owner'; // Valid value for constraint
    } else if (!orgType && companyName) {
      userCompanyName = companyName.trim();
      shipperRole = 'shipper'; // Valid value for constraint
    }

    // FIX: For org-based registration, shipper_role stays NULL (roles in memberships table)
    // For legacy shipper without company, use 'shipper' as default
    if (!orgType && userRole === 'shipper' && !shipperRole) {
      shipperRole = 'shipper'; // Valid default for legacy shipper registration
    }

    // Create user
    const result = await client.query(
      `INSERT INTO users (
        email, phone, password_hash, first_name, last_name, role,
        referral_code, referred_by,
        account_type, company_id, company_name, department, job_title, shipper_role,
        approval_status
      )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING id, email, phone, first_name, last_name, role, referral_code,
                 account_type, company_id, company_name, department, job_title, shipper_role,
                 approval_status, created_at`,
      [
        email.toLowerCase(),
        phone,
        passwordHash,
        fName,
        lName,
        userRole,
        newReferralCode,
        referredById,
        accountType,
        companyId,
        userCompanyName,
        department || null,
        jobTitle || null,
        // FIX: For org-based or driver registration, use NULL; otherwise use computed shipperRole
        orgType ? null : (userRole === 'shipper' ? shipperRole : null),
        userRole === 'driver' ? 'pending' : 'approved'
      ]
    );

    const user = result.rows[0];

    // Update company owner_id if company was created
    if (companyId) {
      await client.query(
        'UPDATE companies SET owner_id = $1 WHERE id = $2',
        [user.id, companyId]
      );
    }

    // NEW: Create org if orgType and orgName provided
    let createdOrg = null;
    if (orgType && orgName) {
      createdOrg = await createOrgForUser(client, user.id, {
        orgType,
        orgName,
        mcNumber,
        dotNumber,
        brokerMcNumber
      });
    }

    // If referred, create referral record
    if (referredById) {
      try {
        await client.query(
          `INSERT INTO referrals (referrer_id, referred_id, status)
           VALUES ($1, $2, 'pending')`,
          [referredById, user.id]
        );
      } catch (e) {
        console.log('[Auth] Referral tracking skipped');
      }
    }

    await client.query('COMMIT');

    // Generate token
    const token = generateToken(user.id);

    // Get company info if exists (legacy)
    let companyInfo = null;
    if (user.company_id) {
      const companyRes = await pool.query(
        'SELECT id, name, display_name, slug, plan_id FROM companies WHERE id = $1',
        [user.company_id]
      );
      if (companyRes.rows.length > 0) {
        companyInfo = companyRes.rows[0];
      }
    }

    // Get all orgs (including just-created one)
    const orgs = await getUserOrgs(user.id);

    res.status(201).json({
      message: 'Registration successful',
      user: {
        id: user.id,
        email: user.email,
        phone: user.phone,
        name: `${user.first_name} ${user.last_name}`.trim(),
        firstName: user.first_name,
        lastName: user.last_name,
        userType: user.role,
        role: user.role,
        referralCode: user.referral_code,
        approvalStatus: user.approval_status,
        accountType: user.account_type,
        companyId: user.company_id,
        companyName: companyInfo?.name || user.company_name,
        department: user.department,
        jobTitle: user.job_title,
        shipperRole: user.shipper_role,
        company: companyInfo,
      },
      // NEW: Include orgs
      orgs,
      primaryOrg: orgs.find(o => o.isPrimary) || orgs[0] || null,
      token,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[Auth] Register error:', error);
    res.status(500).json({ error: 'Registration failed' });
  } finally {
    client.release();
  }
});

/**
 * POST /auth/register/invite
 * Register via company invitation
 */
router.post('/register/invite', async (req, res) => {
  const client = await pool.connect();

  try {
    const { token: inviteToken, password, firstName, lastName, phone } = req.body;

    if (!inviteToken || !password) {
      return res.status(400).json({ error: 'Invite token and password are required' });
    }

    // Find valid invitation
    const inviteResult = await client.query(
      `SELECT i.*, c.name as company_name, c.plan_id
       FROM company_invitations i
       JOIN companies c ON i.company_id = c.id
       WHERE i.token = $1 AND i.status = 'pending' AND i.expires_at > NOW()`,
      [inviteToken]
    );

    if (inviteResult.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired invitation' });
    }

    const invite = inviteResult.rows[0];

    // Check if company can add more users
    const canAddResult = await client.query(
      'SELECT can_company_add_user($1) as can_add',
      [invite.company_id]
    );

    if (!canAddResult.rows[0].can_add) {
      return res.status(403).json({
        error: 'Company has reached user limit. Please upgrade your plan.',
        code: 'USER_LIMIT_REACHED'
      });
    }

    // Check if email already registered
    const existing = await client.query(
      'SELECT id FROM users WHERE email = $1',
      [invite.email.toLowerCase()]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    await client.query('BEGIN');

    // Hash password
    const passwordHash = await bcrypt.hash(password, 12);

    // Generate referral code
    const fName = firstName || invite.first_name || 'USR';
    const referralCode = `${fName.substring(0, 3).toUpperCase()}${Date.now().toString(36).toUpperCase()}`.substring(0, 8);

    // FIX: Map invite.role to valid constraint values
    let mappedRole = invite.role || 'viewer';
    // Ensure the role is valid for the constraint
    const validRoles = ['owner', 'admin', 'approver', 'shipper', 'verifier', 'viewer'];
    if (!validRoles.includes(mappedRole)) {
      mappedRole = 'viewer'; // Default to viewer if invalid
    }

    // Create user
    const userResult = await client.query(
      `INSERT INTO users (
        email, phone, password_hash, first_name, last_name, role,
        referral_code, account_type, company_id, department, job_title, shipper_role,
        approval_status
      )
       VALUES ($1, $2, $3, $4, $5, 'shipper', $6, 'company', $7, $8, $9, $10, 'approved')
       RETURNING id, email, phone, first_name, last_name, role, referral_code,
                 account_type, company_id, department, job_title, shipper_role`,
      [
        invite.email.toLowerCase(),
        phone,
        passwordHash,
        firstName || invite.first_name,
        lastName || invite.last_name,
        referralCode,
        invite.company_id,
        invite.department,
        null,
        mappedRole // FIX: Use mapped valid role
      ]
    );

    const user = userResult.rows[0];

    // Update invitation status
    await client.query(
      `UPDATE company_invitations
       SET status = 'accepted', accepted_at = NOW(), accepted_by = $1
       WHERE id = $2`,
      [user.id, invite.id]
    );

    await client.query('COMMIT');

    // Generate token
    const token = generateToken(user.id);

    // Get orgs
    const orgs = await getUserOrgs(user.id);

    res.status(201).json({
      message: 'Registration successful',
      user: {
        id: user.id,
        email: user.email,
        phone: user.phone,
        name: `${user.first_name} ${user.last_name}`.trim(),
        firstName: user.first_name,
        lastName: user.last_name,
        userType: 'shipper',
        accountType: 'company',
        companyId: user.company_id,
        companyName: invite.company_name,
        department: user.department,
        shipperRole: user.shipper_role,
      },
      orgs,
      primaryOrg: orgs.find(o => o.isPrimary) || orgs[0] || null,
      token,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[Auth] Invite register error:', error);
    res.status(500).json({ error: 'Registration failed' });
  } finally {
    client.release();
  }
});

/**
 * GET /auth/invite/:token
 * Get invitation details (for pre-filling signup form)
 */
router.get('/invite/:token', async (req, res) => {
  try {
    const { token } = req.params;

    const result = await pool.query(
      `SELECT i.email, i.first_name, i.last_name, i.department, i.role,
              c.name as company_name, c.display_name, c.logo_url
       FROM company_invitations i
       JOIN companies c ON i.company_id = c.id
       WHERE i.token = $1 AND i.status = 'pending' AND i.expires_at > NOW()`,
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Invalid or expired invitation' });
    }

    const invite = result.rows[0];
    res.json({
      email: invite.email,
      firstName: invite.first_name,
      lastName: invite.last_name,
      department: invite.department,
      role: invite.role,
      companyName: invite.company_name,
      companyDisplayName: invite.display_name,
      companyLogo: invite.logo_url,
    });
  } catch (error) {
    console.error('[Auth] Get invite error:', error);
    res.status(500).json({ error: 'Failed to get invitation' });
  }
});

/**
 * POST /auth/login
 * Login with email and password
 */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Find user with company info
    const result = await pool.query(
      `SELECT u.id, u.email, u.phone, u.first_name, u.last_name, u.role,
              u.password_hash, u.is_active, u.account_type, u.company_id,
              u.company_name, u.department, u.job_title, u.shipper_role,
              c.name as org_company_name, c.display_name, c.plan_id, c.slug
       FROM users u
       LEFT JOIN companies c ON u.company_id = c.id
       WHERE u.email = $1`,
      [email.toLowerCase()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        error: 'Invalid email or password',
        code: 'INVALID_CREDENTIALS'
      });
    }

    const user = result.rows[0];

    if (!user.is_active) {
      return res.status(403).json({
        error: 'Account deactivated',
        code: 'ACCOUNT_DEACTIVATED'
      });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({
        error: 'Invalid email or password',
        code: 'INVALID_CREDENTIALS'
      });
    }

    // Update last login
    await pool.query(
      'UPDATE users SET last_login_at = NOW() WHERE id = $1',
      [user.id]
    );

    const token = generateToken(user.id);

    // Build company object if exists (legacy)
    let company = null;
    if (user.company_id) {
      company = {
        id: user.company_id,
        name: user.org_company_name,
        displayName: user.display_name,
        planId: user.plan_id,
        slug: user.slug,
      };
    }

    // NEW: Get user's orgs and roles
    const orgs = await getUserOrgs(user.id);
    const primaryOrg = orgs.find(o => o.isPrimary) || orgs[0] || null;

    res.json({
      message: 'Login successful',
      user: {
        id: user.id,
        email: user.email,
        phone: user.phone,
        name: `${user.first_name} ${user.last_name}`.trim(),
        firstName: user.first_name,
        lastName: user.last_name,
        userType: user.role,
        role: user.role,
        accountType: user.account_type,
        companyId: user.company_id,
        companyName: company?.name || user.company_name,
        department: user.department,
        jobTitle: user.job_title,
        shipperRole: user.shipper_role,
        company,
      },
      // NEW: Include orgs and primary org
      orgs,
      primaryOrg,
      token,
    });
  } catch (error) {
    console.error('[Auth] Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

/**
 * GET /auth/me
 * Get current user profile
 */
router.get('/me', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.email, u.phone, u.first_name, u.last_name, u.role,
              u.avatar_url, u.is_verified, u.created_at, u.account_type,
              u.company_id, u.company_name, u.department, u.job_title, u.shipper_role,
              c.name as org_company_name, c.display_name, c.plan_id, c.slug, c.logo_url
       FROM users u
       LEFT JOIN companies c ON u.company_id = c.id
       WHERE u.id = $1`,
      [req.user.id]
    );

    const user = result.rows[0];

    // Build company object (legacy)
    let company = null;
    if (user.company_id) {
      const teamCount = await pool.query(
        'SELECT COUNT(*) as count FROM users WHERE company_id = $1 AND is_active = true',
        [user.company_id]
      );

      company = {
        id: user.company_id,
        name: user.org_company_name,
        displayName: user.display_name,
        planId: user.plan_id,
        slug: user.slug,
        logoUrl: user.logo_url,
        teamCount: parseInt(teamCount.rows[0].count),
      };
    }

    // NEW: Get user's orgs
    const orgs = await getUserOrgs(user.id);
    const primaryOrg = orgs.find(o => o.isPrimary) || orgs[0] || null;

    res.json({
      id: user.id,
      email: user.email,
      phone: user.phone,
      name: `${user.first_name} ${user.last_name}`.trim(),
      firstName: user.first_name,
      lastName: user.last_name,
      userType: user.role,
      role: user.role,
      avatarUrl: user.avatar_url,
      isVerified: user.is_verified,
      createdAt: user.created_at,
      accountType: user.account_type,
      companyId: user.company_id,
      companyName: company?.name || user.company_name,
      department: user.department,
      jobTitle: user.job_title,
      shipperRole: user.shipper_role,
      company,
      // NEW: Include orgs
      orgs,
      primaryOrg,
    });
  } catch (error) {
    console.error('[Auth] Get profile error:', error);
    res.status(500).json({ error: 'Failed to get profile' });
  }
});

/**
 * PUT /auth/fcm-token
 * Update FCM token for push notifications
 */
router.put('/fcm-token', authenticate, async (req, res) => {
  try {
    const { fcmToken, platform } = req.body;

    await pool.query(
      `INSERT INTO device_tokens (user_id, token, platform)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, token) DO UPDATE SET platform = $3, updated_at = NOW()`,
      [req.user.id, fcmToken, platform || 'android']
    );

    res.json({ message: 'FCM token updated' });
  } catch (error) {
    console.error('[Auth] FCM token error:', error);
    res.status(500).json({ error: 'Failed to update FCM token' });
  }
});

/**
 * GET /auth/plans
 * Get available subscription plans
 */
router.get('/plans', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, max_users, price_monthly, price_yearly, features
       FROM subscription_plans
       WHERE is_active = true
       ORDER BY sort_order`
    );

    res.json({ plans: result.rows });
  } catch (error) {
    console.error('[Auth] Get plans error:', error);
    res.status(500).json({ error: 'Failed to get plans' });
  }
});

// ============================================
// PASSWORD RESET FLOW
// ============================================

/**
 * Helper: Generate 6-digit reset code
 */
const generateResetCode = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

/**
 * POST /auth/forgot-password
 * Send password reset code to email
 */
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Find user
    const userResult = await pool.query(
      'SELECT id, email, first_name FROM users WHERE email = $1 AND is_active = true',
      [email.toLowerCase()]
    );

    // Always return success to prevent email enumeration
    if (userResult.rows.length === 0) {
      return res.json({
        message: 'If an account exists with this email, a reset code has been sent.',
        codeSent: true
      });
    }

    const user = userResult.rows[0];

    // Generate 6-digit code
    const resetCode = generateResetCode();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    // Delete any existing reset codes for this user
    await pool.query(
      'DELETE FROM password_reset_codes WHERE user_id = $1',
      [user.id]
    );

    // Store reset code
    await pool.query(
      `INSERT INTO password_reset_codes (user_id, code, expires_at)
       VALUES ($1, $2, $3)`,
      [user.id, resetCode, expiresAt]
    );

    // TODO: Send email with reset code
    // await sendResetCodeEmail(user.email, user.first_name, resetCode);
    console.log(`[Auth] Password reset code for ${user.email}: ${resetCode}`);

    res.json({
      message: 'If an account exists with this email, a reset code has been sent.',
      codeSent: true,
      // Include code in dev environment only (remove in production)
      ...(process.env.NODE_ENV === 'development' && { devCode: resetCode })
    });
  } catch (error) {
    console.error('[Auth] Forgot password error:', error);
    res.status(500).json({ error: 'Failed to process request' });
  }
});

/**
 * POST /auth/verify-reset-code
 * Verify the reset code is valid
 */
router.post('/verify-reset-code', async (req, res) => {
  try {
    const { email, code } = req.body;

    if (!email || !code) {
      return res.status(400).json({ error: 'Email and code are required' });
    }

    // Find user and valid reset code
    const result = await pool.query(
      `SELECT prc.id, prc.user_id, prc.attempts, u.email
       FROM password_reset_codes prc
       JOIN users u ON prc.user_id = u.id
       WHERE u.email = $1
         AND prc.code = $2
         AND prc.expires_at > NOW()
         AND prc.used_at IS NULL`,
      [email.toLowerCase(), code]
    );

    if (result.rows.length === 0) {
      // Increment attempts if code exists but is wrong
      await pool.query(
        `UPDATE password_reset_codes prc
         SET attempts = attempts + 1
         FROM users u
         WHERE prc.user_id = u.id AND u.email = $1 AND prc.expires_at > NOW()`,
        [email.toLowerCase()]
      );

      return res.status(400).json({
        error: 'Invalid or expired code',
        valid: false
      });
    }

    const resetRecord = result.rows[0];

    // Check if too many attempts
    if (resetRecord.attempts >= 5) {
      return res.status(429).json({
        error: 'Too many attempts. Please request a new code.',
        valid: false
      });
    }

    // Generate a temporary token for the reset step
    const resetToken = crypto.randomBytes(32).toString('hex');

    // Update record with token
    await pool.query(
      `UPDATE password_reset_codes
       SET reset_token = $1, verified_at = NOW()
       WHERE id = $2`,
      [resetToken, resetRecord.id]
    );

    res.json({
      message: 'Code verified successfully',
      valid: true,
      resetToken
    });
  } catch (error) {
    console.error('[Auth] Verify reset code error:', error);
    res.status(500).json({ error: 'Failed to verify code' });
  }
});

/**
 * POST /auth/reset-password
 * Reset password using verified reset token
 */
router.post('/reset-password', async (req, res) => {
  const client = await pool.connect();

  try {
    const { email, code, resetToken, newPassword } = req.body;

    if (!newPassword) {
      return res.status(400).json({ error: 'New password is required' });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    // Verify the reset - accept either code or resetToken
    let query, params;

    if (resetToken) {
      // Using the token from verify-reset-code step
      query = `
        SELECT prc.id, prc.user_id
        FROM password_reset_codes prc
        JOIN users u ON prc.user_id = u.id
        WHERE prc.reset_token = $1
          AND prc.expires_at > NOW()
          AND prc.used_at IS NULL
          AND prc.verified_at IS NOT NULL`;
      params = [resetToken];
    } else if (email && code) {
      // Direct reset with email + code (for apps that skip verify step)
      query = `
        SELECT prc.id, prc.user_id
        FROM password_reset_codes prc
        JOIN users u ON prc.user_id = u.id
        WHERE u.email = $1
          AND prc.code = $2
          AND prc.expires_at > NOW()
          AND prc.used_at IS NULL`;
      params = [email.toLowerCase(), code];
    } else {
      return res.status(400).json({
        error: 'Either resetToken or email+code is required'
      });
    }

    const result = await pool.query(query, params);

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired reset request' });
    }

    const resetRecord = result.rows[0];

    await client.query('BEGIN');

    // Hash new password
    const passwordHash = await bcrypt.hash(newPassword, 12);

    // Update user password
    await client.query(
      `UPDATE users
       SET password_hash = $1, updated_at = NOW()
       WHERE id = $2`,
      [passwordHash, resetRecord.user_id]
    );

    // Mark reset code as used
    await client.query(
      `UPDATE password_reset_codes
       SET used_at = NOW()
       WHERE id = $1`,
      [resetRecord.id]
    );

    // Invalidate all other reset codes for this user
    await client.query(
      `DELETE FROM password_reset_codes
       WHERE user_id = $1 AND id != $2`,
      [resetRecord.user_id, resetRecord.id]
    );

    await client.query('COMMIT');

    // TODO: Send password changed confirmation email
    // await sendPasswordChangedEmail(user.email);

    res.json({
      message: 'Password reset successfully',
      success: true
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[Auth] Reset password error:', error);
    res.status(500).json({ error: 'Failed to reset password' });
  } finally {
    client.release();
  }
});

/**
 * POST /auth/change-password
 * Change password for authenticated user (legacy support for driver app)
 */
router.post('/change-password', authenticate, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current password and new password are required' });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }

    // Get current password hash
    const userResult = await pool.query(
      'SELECT password_hash FROM users WHERE id = $1',
      [req.user.id]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Verify current password
    const valid = await bcrypt.compare(currentPassword, userResult.rows[0].password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    // Hash new password
    const passwordHash = await bcrypt.hash(newPassword, 12);

    // Update password
    await pool.query(
      `UPDATE users
       SET password_hash = $1, updated_at = NOW()
       WHERE id = $2`,
      [passwordHash, req.user.id]
    );

    res.json({
      message: 'Password changed successfully',
      success: true
    });
  } catch (error) {
    console.error('[Auth] Change password error:', error);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

module.exports = router;
