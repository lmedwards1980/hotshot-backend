// backend_api/src/routes/notifications.js
// Notification API routes

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const notificationService = require('../services/notificationService');

// ============================================
// DEVICE TOKEN MANAGEMENT
// ============================================

/**
 * POST /api/notifications/register-token
 * Register device token for push notifications
 */
router.post('/register-token', authenticate, async (req, res) => {
  try {
    const { token, platform = 'android' } = req.body;

    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }

    const validPlatforms = ['ios', 'android', 'web'];
    if (!validPlatforms.includes(platform)) {
      return res.status(400).json({ error: 'Invalid platform. Must be ios, android, or web' });
    }

    const result = await notificationService.registerDeviceToken(
      req.user.id,
      token,
      platform
    );

    if (result.success) {
      res.json({ message: 'Device token registered successfully' });
    } else {
      res.status(500).json({ error: result.error || 'Failed to register token' });
    }
  } catch (error) {
    console.error('[Notifications] Register token error:', error);
    res.status(500).json({ error: 'Failed to register device token' });
  }
});

/**
 * DELETE /api/notifications/unregister-token
 * Remove device token (e.g., on logout)
 */
router.delete('/unregister-token', authenticate, async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }

    const result = await notificationService.removeDeviceToken(req.user.id, token);

    if (result.success) {
      res.json({ message: 'Device token removed successfully' });
    } else {
      res.status(500).json({ error: result.error || 'Failed to remove token' });
    }
  } catch (error) {
    console.error('[Notifications] Unregister token error:', error);
    res.status(500).json({ error: 'Failed to remove device token' });
  }
});

// ============================================
// NOTIFICATION RETRIEVAL
// ============================================

/**
 * GET /api/notifications
 * Get user's notifications
 * Query params: limit, offset, unread_only
 */
router.get('/', authenticate, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const offset = parseInt(req.query.offset) || 0;
    const unreadOnly = req.query.unread_only === 'true';

    const result = await notificationService.getUserNotifications(
      req.user.id,
      limit,
      offset,
      unreadOnly
    );

    res.json({
      notifications: result.notifications,
      unreadCount: result.unreadCount,
      limit,
      offset,
    });
  } catch (error) {
    console.error('[Notifications] Get notifications error:', error);
    res.status(500).json({ error: 'Failed to get notifications' });
  }
});

/**
 * GET /api/notifications/unread-count
 * Get unread notification count only
 */
router.get('/unread-count', authenticate, async (req, res) => {
  try {
    const result = await notificationService.getUserNotifications(
      req.user.id,
      1,
      0,
      true
    );

    res.json({ unreadCount: result.unreadCount });
  } catch (error) {
    console.error('[Notifications] Unread count error:', error);
    res.status(500).json({ error: 'Failed to get unread count' });
  }
});

// ============================================
// NOTIFICATION ACTIONS
// ============================================

/**
 * PUT /api/notifications/:id/read
 * Mark notification as read
 */
router.put('/:id/read', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await notificationService.markAsRead(id, req.user.id);

    if (result.success) {
      res.json({ message: 'Notification marked as read' });
    } else {
      res.status(500).json({ error: result.error || 'Failed to mark as read' });
    }
  } catch (error) {
    console.error('[Notifications] Mark read error:', error);
    res.status(500).json({ error: 'Failed to mark notification as read' });
  }
});

/**
 * PUT /api/notifications/read-all
 * Mark all notifications as read
 */
router.put('/read-all', authenticate, async (req, res) => {
  try {
    const result = await notificationService.markAllAsRead(req.user.id);

    if (result.success) {
      res.json({ message: 'All notifications marked as read' });
    } else {
      res.status(500).json({ error: result.error || 'Failed to mark all as read' });
    }
  } catch (error) {
    console.error('[Notifications] Mark all read error:', error);
    res.status(500).json({ error: 'Failed to mark all notifications as read' });
  }
});

/**
 * DELETE /api/notifications/:id
 * Delete a notification
 */
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await notificationService.deleteNotification(id, req.user.id);

    if (result.success) {
      res.json({ message: 'Notification deleted' });
    } else {
      res.status(500).json({ error: result.error || 'Failed to delete notification' });
    }
  } catch (error) {
    console.error('[Notifications] Delete error:', error);
    res.status(500).json({ error: 'Failed to delete notification' });
  }
});

// ============================================
// ADMIN / TESTING ENDPOINTS
// ============================================

/**
 * POST /api/notifications/test
 * Send a test notification to yourself (for testing)
 */
router.post('/test', authenticate, async (req, res) => {
  try {
    const { title, body } = req.body;

    const result = await notificationService.sendNotification(
      req.user.id,
      'GENERIC',
      {
        title: title || 'Test Notification',
        body: body || 'This is a test notification from Hotshot!',
        data: { test: true },
      }
    );

    if (result.success) {
      res.json({ 
        message: 'Test notification sent',
        delivered: result.delivered,
        reason: result.reason,
      });
    } else {
      res.status(500).json({ error: result.error || 'Failed to send test notification' });
    }
  } catch (error) {
    console.error('[Notifications] Test send error:', error);
    res.status(500).json({ error: 'Failed to send test notification' });
  }
});

/**
 * POST /api/notifications/send
 * Admin endpoint to send notification to a user
 */
router.post('/send', authenticate, async (req, res) => {
  try {
    // TODO: Add admin role check
    // if (req.user.role !== 'admin') {
    //   return res.status(403).json({ error: 'Admin access required' });
    // }

    const { userId, type, data } = req.body;

    if (!userId || !type) {
      return res.status(400).json({ error: 'userId and type are required' });
    }

    const result = await notificationService.sendNotification(userId, type, data || {});

    if (result.success) {
      res.json({ 
        message: 'Notification sent',
        ...result,
      });
    } else {
      res.status(500).json({ error: result.error || 'Failed to send notification' });
    }
  } catch (error) {
    console.error('[Notifications] Admin send error:', error);
    res.status(500).json({ error: 'Failed to send notification' });
  }
});

module.exports = router;
