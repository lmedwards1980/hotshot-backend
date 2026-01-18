// Users Routes - Profile management
const express = require('express');
const { pool } = require('../db/pool');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

/**
 * GET /users/profile
 * Get current user's profile
 */
router.get('/profile', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
        u.id, u.email, u.phone, u.first_name, u.last_name, u.role,
        u.avatar_url, u.is_verified, u.created_at
       FROM users u
       WHERE u.id = $1`,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];

    // Get stats for shippers
    let stats = null;
    if (user.role === 'shipper') {
      const statsResult = await pool.query(
        `SELECT 
          COUNT(*) as total_loads,
          COUNT(*) FILTER (WHERE status NOT IN ('delivered', 'cancelled')) as active_loads,
          COALESCE(SUM(price) FILTER (WHERE status = 'delivered'), 0) as total_spent
         FROM loads WHERE shipper_id = $1`,
        [req.user.id]
      );
      stats = {
        totalLoads: parseInt(statsResult.rows[0].total_loads) || 0,
        activeLoads: parseInt(statsResult.rows[0].active_loads) || 0,
        totalSpent: parseFloat(statsResult.rows[0].total_spent) || 0,
      };
    }

    res.json({
      user: {
        id: user.id,
        email: user.email,
        phone: user.phone,
        firstName: user.first_name,
        lastName: user.last_name,
        name: `${user.first_name || ''} ${user.last_name || ''}`.trim(),
        role: user.role,
        userType: user.role,
        avatarUrl: user.avatar_url,
        isVerified: user.is_verified,
        createdAt: user.created_at,
        accountType: 'solo',
        companyId: null,
        companyName: null,
        department: null,
        jobTitle: null,
        shipperRole: 'user',
        company: null,
        stats,
      }
    });
  } catch (error) {
    console.error('[Users] Get profile error:', error);
    res.status(500).json({ error: 'Failed to get profile' });
  }
});

/**
 * PUT /users/profile
 * Update current user's profile
 */
router.put('/profile', authenticate, async (req, res) => {
  try {
    const {
      firstName,
      lastName,
      phone,
    } = req.body;

    const result = await pool.query(
      `UPDATE users SET
        first_name = COALESCE($1, first_name),
        last_name = COALESCE($2, last_name),
        phone = COALESCE($3, phone),
        updated_at = NOW()
       WHERE id = $4
       RETURNING id, email, phone, first_name, last_name`,
      [firstName, lastName, phone, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];

    res.json({
      message: 'Profile updated',
      user: {
        id: user.id,
        email: user.email,
        phone: user.phone,
        firstName: user.first_name,
        lastName: user.last_name,
      }
    });
  } catch (error) {
    console.error('[Users] Update profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

/**
 * POST /users/profile/photo
 * Upload profile photo
 */
router.post('/profile/photo', authenticate, async (req, res) => {
  try {
    // For now, just accept a URL directly
    // In production, you'd handle multipart/form-data upload to S3
    const { url } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'Photo URL is required' });
    }

    await pool.query(
      'UPDATE users SET avatar_url = $1, updated_at = NOW() WHERE id = $2',
      [url, req.user.id]
    );

    res.json({ 
      message: 'Profile photo updated',
      url 
    });
  } catch (error) {
    console.error('[Users] Upload photo error:', error);
    res.status(500).json({ error: 'Failed to upload photo' });
  }
});

/**
 * DELETE /users/profile
 * Deactivate account (soft delete)
 */
router.delete('/profile', authenticate, async (req, res) => {
  try {
    await pool.query(
      'UPDATE users SET is_active = false, updated_at = NOW() WHERE id = $1',
      [req.user.id]
    );

    res.json({ message: 'Account deactivated' });
  } catch (error) {
    console.error('[Users] Deactivate error:', error);
    res.status(500).json({ error: 'Failed to deactivate account' });
  }
});

/**
 * PUT /users/password
 * Change password
 */
router.put('/password', authenticate, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const bcrypt = require('bcryptjs');

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password are required' });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }

    // Verify current password
    const user = await pool.query(
      'SELECT password_hash FROM users WHERE id = $1',
      [req.user.id]
    );

    if (user.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const valid = await bcrypt.compare(currentPassword, user.rows[0].password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    // Update password
    const newHash = await bcrypt.hash(newPassword, 12);
    await pool.query(
      'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
      [newHash, req.user.id]
    );

    res.json({ message: 'Password updated successfully' });
  } catch (error) {
    console.error('[Users] Change password error:', error);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

module.exports = router;
