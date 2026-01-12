const express = require('express');
const router = express.Router();
const { pool } = require('../db/pool');
const { authenticate } = require('../middleware/auth');

// GET /api/announcements - Get active announcements for user
router.get('/', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role || 'shipper';

    // Get active announcements
    const result = await pool.query(`
      SELECT 
        a.id,
        a.type,
        a.title,
        a.message,
        a.action_text,
        a.action_url,
        a.priority,
        a.start_date,
        a.end_date
      FROM announcements a
      LEFT JOIN announcement_dismissals ad 
        ON a.id = ad.announcement_id AND ad.user_id = $1
      WHERE a.is_active = true
        AND a.start_date <= NOW()
        AND (a.end_date IS NULL OR a.end_date >= NOW())
        AND (a.target_role = 'all' OR a.target_role = $2)
        AND ad.id IS NULL
      ORDER BY a.priority DESC, a.created_at DESC
      LIMIT 5
    `, [userId, userRole]);

    res.json({ announcements: result.rows });
  } catch (error) {
    console.error('[Announcements] Error fetching:', error);
    
    // Return empty array if table doesn't exist yet
    if (error.code === '42P01') {
      return res.json({ announcements: [] });
    }
    
    res.json({ announcements: [] });
  }
});

// POST /api/announcements/:id/dismiss - Dismiss an announcement
router.post('/:id/dismiss', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const announcementId = req.params.id;

    await pool.query(`
      INSERT INTO announcement_dismissals (user_id, announcement_id)
      VALUES ($1, $2)
      ON CONFLICT (user_id, announcement_id) DO NOTHING
    `, [userId, announcementId]);

    res.json({ success: true });
  } catch (error) {
    console.error('[Announcements] Error dismissing:', error);
    res.json({ success: true });
  }
});

// POST /api/announcements - Create announcement (admin only)
router.post('/', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const {
      type,
      title,
      message,
      actionText,
      actionUrl,
      targetRole,
      priority,
      startDate,
      endDate,
    } = req.body;

    const result = await pool.query(`
      INSERT INTO announcements (
        type, title, message, action_text, action_url,
        target_role, priority, start_date, end_date, is_active
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)
      RETURNING *
    `, [
      type || 'info',
      title,
      message,
      actionText || null,
      actionUrl || null,
      targetRole || 'all',
      priority || 0,
      startDate || new Date(),
      endDate || null,
    ]);

    res.status(201).json({ announcement: result.rows[0] });
  } catch (error) {
    console.error('[Announcements] Error creating:', error);
    res.status(500).json({ error: 'Failed to create announcement' });
  }
});

// DELETE /api/announcements/:id - Delete announcement (admin only)
router.delete('/:id', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { id } = req.params;
    await pool.query('DELETE FROM announcement_dismissals WHERE announcement_id = $1', [id]);
    await pool.query('DELETE FROM announcements WHERE id = $1', [id]);

    res.json({ success: true });
  } catch (error) {
    console.error('[Announcements] Error deleting:', error);
    res.status(500).json({ error: 'Failed to delete announcement' });
  }
});

module.exports = router;
