// backend_api/src/services/notificationService.js
// Push notification service using Firebase Cloud Messaging

const admin = require('firebase-admin');
const { pool } = require('../db/pool');

// ============================================
// FIREBASE INITIALIZATION (safe - checks if already initialized)
// ============================================

const getFirebaseApp = () => {
  // Check if already initialized
  if (admin.apps.length > 0) {
    return admin.apps[0];
  }

  try {
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
    
    if (!process.env.FIREBASE_PROJECT_ID || !privateKey) {
      console.warn('[Notifications] Firebase not configured - push notifications disabled');
      return null;
    }

    const app = admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: privateKey,
      }),
    });

    console.log('[Notifications] Firebase initialized successfully');
    return app;
  } catch (error) {
    // If it's a duplicate app error, just return the existing app
    if (error.code === 'app/duplicate-app') {
      console.log('[Notifications] Using existing Firebase app');
      return admin.apps[0];
    }
    console.error('[Notifications] Firebase initialization error:', error.message);
    return null;
  }
};

// ============================================
// NOTIFICATION TEMPLATES
// ============================================

const NOTIFICATION_TEMPLATES = {
  // Driver notifications
  LOAD_OFFER_RECEIVED: (data) => ({
    title: '🚚 New Load Offer!',
    body: `${data.shipperName} wants you for ${data.pickupCity} → ${data.deliveryCity}. $${data.payout} payout.`,
    data: { type: 'load_offer', loadId: data.loadId, offerId: data.offerId },
  }),

  LOAD_ASSIGNED: (data) => ({
    title: '✅ Load Accepted!',
    body: `You got the load! ${data.pickupCity} → ${data.deliveryCity}. Pickup: ${data.pickupDate}`,
    data: { type: 'load_assigned', loadId: data.loadId },
  }),

  PAYMENT_RECEIVED: (data) => ({
    title: '💰 Payment Received!',
    body: `$${data.amount} has been added to your account for load #${data.loadId?.slice(-6)}`,
    data: { type: 'payment_received', loadId: data.loadId, paymentId: data.paymentId },
  }),

  RATING_RECEIVED: (data) => ({
    title: data.isHot ? '🔥 Hot Rating!' : '⭐ New Rating',
    body: data.isHot 
      ? `${data.shipperName} rated you HOT! Keep up the great work!`
      : `${data.shipperName} left you a rating.`,
    data: { type: 'rating_received', loadId: data.loadId },
  }),

  LOAD_CANCELLED_BY_SHIPPER: (data) => ({
    title: '❌ Load Cancelled',
    body: `${data.shipperName} cancelled the load ${data.pickupCity} → ${data.deliveryCity}`,
    data: { type: 'load_cancelled', loadId: data.loadId },
  }),

  // Shipper notifications
  DRIVER_ACCEPTED: (data) => ({
    title: '🎉 Driver Accepted!',
    body: `${data.driverName} accepted your load to ${data.deliveryCity}!`,
    data: { type: 'driver_accepted', loadId: data.loadId },
  }),

  DRIVER_EN_ROUTE_PICKUP: (data) => ({
    title: '🚗 Driver On The Way',
    body: `${data.driverName} is heading to pickup. ETA: ${data.eta || 'Calculating...'}`,
    data: { type: 'status_update', loadId: data.loadId, status: 'en_route_pickup' },
  }),

  DRIVER_AT_PICKUP: (data) => ({
    title: '📍 Driver Arrived at Pickup',
    body: `${data.driverName} has arrived at the pickup location.`,
    data: { type: 'status_update', loadId: data.loadId, status: 'at_pickup' },
  }),

  LOAD_PICKED_UP: (data) => ({
    title: '📦 Load Picked Up!',
    body: `${data.driverName} picked up your shipment. On the way to ${data.deliveryCity}!`,
    data: { type: 'status_update', loadId: data.loadId, status: 'picked_up' },
  }),

  DRIVER_EN_ROUTE_DELIVERY: (data) => ({
    title: '🚚 In Transit',
    body: `Your shipment is on the way to ${data.deliveryCity}. ETA: ${data.eta || 'Calculating...'}`,
    data: { type: 'status_update', loadId: data.loadId, status: 'en_route_delivery' },
  }),

  DRIVER_AT_DELIVERY: (data) => ({
    title: '📍 Driver Arrived at Delivery',
    body: `${data.driverName} has arrived at the delivery location.`,
    data: { type: 'status_update', loadId: data.loadId, status: 'at_delivery' },
  }),

  LOAD_DELIVERED: (data) => ({
    title: '✅ Delivered!',
    body: `Your shipment to ${data.deliveryCity} has been delivered! Rate your driver.`,
    data: { type: 'load_delivered', loadId: data.loadId },
  }),

  DRIVER_DECLINED_OFFER: (data) => ({
    title: '❌ Offer Declined',
    body: `${data.driverName} declined your load offer. Try other drivers!`,
    data: { type: 'offer_declined', loadId: data.loadId, offerId: data.offerId },
  }),

  DRIVER_COUNTER_OFFER: (data) => ({
    title: '💬 Counter Offer',
    body: `${data.driverName} countered with $${data.counterAmount} for your load.`,
    data: { type: 'counter_offer', loadId: data.loadId, offerId: data.offerId },
  }),

  LOAD_CANCELLED_BY_DRIVER: (data) => ({
    title: '⚠️ Driver Cancelled',
    body: `${data.driverName} cancelled. Your load is back on the market.`,
    data: { type: 'load_cancelled', loadId: data.loadId },
  }),

  // General
  GENERIC: (data) => ({
    title: data.title || 'Hotshot',
    body: data.body || '',
    data: data.data || {},
  }),

  ANNOUNCEMENT: (data) => ({
    title: '📢 ' + (data.title || 'Announcement'),
    body: data.body,
    data: { type: 'announcement', ...data.data },
  }),
};

// ============================================
// CORE NOTIFICATION FUNCTIONS
// ============================================

const sendNotification = async (userId, templateType, templateData, saveToDb = true) => {
  try {
    const templateFn = NOTIFICATION_TEMPLATES[templateType];
    if (!templateFn) {
      console.error(`[Notifications] Unknown template: ${templateType}`);
      return { success: false, error: 'Unknown template' };
    }

    const notification = templateFn(templateData);
    
    // Save to database first
    let dbNotificationId = null;
    if (saveToDb) {
      try {
        const dbResult = await pool.query(`
          INSERT INTO notifications (user_id, type, title, body, data)
          VALUES ($1, $2, $3, $4, $5)
          RETURNING id
        `, [userId, templateType, notification.title, notification.body, JSON.stringify(notification.data)]);
        dbNotificationId = dbResult.rows[0]?.id;
      } catch (dbError) {
        console.error('[Notifications] Failed to save to DB:', dbError.message);
      }
    }

    // Get user's device tokens
    const tokensResult = await pool.query(`
      SELECT token, platform FROM device_tokens
      WHERE user_id = $1 AND is_active = true
    `, [userId]);

    if (tokensResult.rows.length === 0) {
      console.log(`[Notifications] No device tokens for user ${userId}`);
      return { success: true, delivered: false, reason: 'no_tokens', dbNotificationId };
    }

    // Send push notification via Firebase
    const firebaseApp = getFirebaseApp();
    if (!firebaseApp) {
      console.warn('[Notifications] Firebase not available');
      return { success: true, delivered: false, reason: 'firebase_not_configured', dbNotificationId };
    }

    const tokens = tokensResult.rows.map(r => r.token);
    
    const message = {
      notification: {
        title: notification.title,
        body: notification.body,
      },
      data: {
        ...Object.fromEntries(
          Object.entries(notification.data || {}).map(([k, v]) => [k, String(v)])
        ),
        notificationId: dbNotificationId?.toString() || '',
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
      },
      android: {
        priority: 'high',
        notification: {
          sound: 'default',
          channelId: 'hotshot_notifications',
        },
      },
      apns: {
        payload: {
          aps: {
            sound: 'default',
            badge: 1,
          },
        },
      },
      tokens: tokens,
    };

    const response = await admin.messaging().sendEachForMulticast(message);
    
    console.log(`[Notifications] Sent to ${userId}: ${response.successCount}/${tokens.length} delivered`);

    // Handle failed tokens
    if (response.failureCount > 0) {
      response.responses.forEach(async (resp, idx) => {
        if (!resp.success) {
          const errorCode = resp.error?.code;
          if (errorCode === 'messaging/registration-token-not-registered' ||
              errorCode === 'messaging/invalid-registration-token') {
            await pool.query(
              'UPDATE device_tokens SET is_active = false WHERE token = $1',
              [tokens[idx]]
            );
          }
        }
      });
    }

    return { 
      success: true, 
      delivered: response.successCount > 0,
      successCount: response.successCount,
      failureCount: response.failureCount,
      dbNotificationId,
    };

  } catch (error) {
    console.error('[Notifications] Send error:', error);
    return { success: false, error: error.message };
  }
};

const sendBulkNotification = async (userIds, templateType, templateData) => {
  const results = await Promise.all(
    userIds.map(userId => sendNotification(userId, templateType, templateData))
  );
  return results;
};

// ============================================
// DEVICE TOKEN MANAGEMENT
// ============================================

const registerDeviceToken = async (userId, token, platform = 'android') => {
  try {
    await pool.query(`
      INSERT INTO device_tokens (user_id, token, platform, is_active, updated_at)
      VALUES ($1, $2, $3, true, NOW())
      ON CONFLICT (user_id, token) 
      DO UPDATE SET is_active = true, platform = $3, updated_at = NOW()
    `, [userId, token, platform]);

    console.log(`[Notifications] Registered token for user ${userId}`);
    return { success: true };
  } catch (error) {
    console.error('[Notifications] Token registration error:', error);
    return { success: false, error: error.message };
  }
};

const removeDeviceToken = async (userId, token) => {
  try {
    await pool.query(
      'UPDATE device_tokens SET is_active = false WHERE user_id = $1 AND token = $2',
      [userId, token]
    );
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

const removeAllDeviceTokens = async (userId) => {
  try {
    await pool.query(
      'UPDATE device_tokens SET is_active = false WHERE user_id = $1',
      [userId]
    );
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

// ============================================
// NOTIFICATION QUERIES
// ============================================

const getUserNotifications = async (userId, limit = 50, offset = 0, unreadOnly = false) => {
  try {
    let query = `
      SELECT id, type, title, body, data, is_read, created_at
      FROM notifications
      WHERE user_id = $1
    `;
    const params = [userId];

    if (unreadOnly) {
      query += ' AND is_read = false';
    }

    query += ' ORDER BY created_at DESC LIMIT $2 OFFSET $3';
    params.push(limit, offset);

    const result = await pool.query(query, params);

    const countResult = await pool.query(
      'SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND is_read = false',
      [userId]
    );

    return {
      notifications: result.rows,
      unreadCount: parseInt(countResult.rows[0].count) || 0,
    };
  } catch (error) {
    console.error('[Notifications] Get notifications error:', error);
    return { notifications: [], unreadCount: 0 };
  }
};

const markAsRead = async (notificationId, userId) => {
  try {
    await pool.query(`
      UPDATE notifications 
      SET is_read = true, read_at = NOW()
      WHERE id = $1 AND user_id = $2
    `, [notificationId, userId]);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

const markAllAsRead = async (userId) => {
  try {
    await pool.query(`
      UPDATE notifications 
      SET is_read = true, read_at = NOW()
      WHERE user_id = $1 AND is_read = false
    `, [userId]);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

const deleteNotification = async (notificationId, userId) => {
  try {
    await pool.query(
      'DELETE FROM notifications WHERE id = $1 AND user_id = $2',
      [notificationId, userId]
    );
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

// ============================================
// CONVENIENCE FUNCTIONS
// ============================================

const notifyDriverOfOffer = async (driverId, loadData, offerId) => {
  return sendNotification(driverId, 'LOAD_OFFER_RECEIVED', { ...loadData, offerId });
};

const notifyShipperDriverAccepted = async (shipperId, driverName, loadData) => {
  return sendNotification(shipperId, 'DRIVER_ACCEPTED', { driverName, ...loadData });
};

const notifyShipperStatusChange = async (shipperId, status, driverName, loadData) => {
  const statusTemplates = {
    'en_route_pickup': 'DRIVER_EN_ROUTE_PICKUP',
    'at_pickup': 'DRIVER_AT_PICKUP',
    'picked_up': 'LOAD_PICKED_UP',
    'en_route_delivery': 'DRIVER_EN_ROUTE_DELIVERY',
    'at_delivery': 'DRIVER_AT_DELIVERY',
    'delivered': 'LOAD_DELIVERED',
  };

  const templateType = statusTemplates[status];
  if (!templateType) return { success: false, error: 'Unknown status' };

  return sendNotification(shipperId, templateType, { driverName, ...loadData });
};

const notifyDriverPayment = async (driverId, amount, loadId, paymentId) => {
  return sendNotification(driverId, 'PAYMENT_RECEIVED', { amount, loadId, paymentId });
};

const notifyDriverRating = async (driverId, shipperName, isHot, loadId) => {
  return sendNotification(driverId, 'RATING_RECEIVED', { shipperName, isHot, loadId });
};

// ============================================
// EXPORTS
// ============================================

module.exports = {
  sendNotification,
  sendBulkNotification,
  registerDeviceToken,
  removeDeviceToken,
  removeAllDeviceTokens,
  getUserNotifications,
  markAsRead,
  markAllAsRead,
  deleteNotification,
  notifyDriverOfOffer,
  notifyShipperDriverAccepted,
  notifyShipperStatusChange,
  notifyDriverPayment,
  notifyDriverRating,
  NOTIFICATION_TEMPLATES,
};
