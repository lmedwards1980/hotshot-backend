// Auth Routes - With Company & Team Support
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
 * POST /auth/register
 * Register a new shipper (solo or company)
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
    let shipperRole = 'user';
    let userCompanyName = null;

    // Handle company account type
    if (accountType === 'company' && companyName) {
      // Create company first
      const slug = generateSlug(companyName);
      
      const companyResult = await client.query(
        `INSERT INTO companies (name, display_name, slug, email, plan_id, subscription_status, subscription_started_at)
         VALUES ($1, $2, $3, $4, 'solo', 'active', NOW())
         RETURNING id`,
        [companyName.trim(), companyName.trim(), slug, email.toLowerCase()]
      );
      
      companyId = companyResult.rows[0].id;
      shipperRole = 'owner'; // First user is owner
    } else if (companyName) {
      // Solo shipper with company name (display only)
      userCompanyName = companyName.trim();
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
        userRole === 'shipper' ? shipperRole : null,
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

    // Get company info if exists
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
        invite.role || 'user'
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

    // Build company object if exists
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

    // Build company object
    let company = null;
    if (user.company_id) {
      // Get team count
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

module.exports = router;
