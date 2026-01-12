// backend_api/src/services/loadNotifications.js
// Helper to send notifications for load lifecycle events

const notificationService = require('./notificationService');
const { pool } = require('../db/pool');

/**
 * Get load details for notification (fetches shipper/driver info)
 */
const getLoadNotificationData = async (loadId) => {
  const result = await pool.query(`
    SELECT 
      l.*,
      s.id as shipper_user_id,
      s.first_name as shipper_first_name,
      s.last_name as shipper_last_name,
      s.company_name as shipper_company,
      d.id as driver_user_id,
      d.first_name as driver_first_name,
      d.last_name as driver_last_name
    FROM loads l
    JOIN users s ON l.shipper_id = s.id
    LEFT JOIN users d ON l.driver_id = d.id
    WHERE l.id = $1
  `, [loadId]);

  if (result.rows.length === 0) return null;

  const load = result.rows[0];
  return {
    loadId: load.id,
    shipperId: load.shipper_user_id,
    shipperName: load.shipper_company || `${load.shipper_first_name} ${load.shipper_last_name}`.trim(),
    driverId: load.driver_user_id,
    driverName: load.driver_first_name && load.driver_last_name 
      ? `${load.driver_first_name} ${load.driver_last_name}`.trim()
      : 'Driver',
    pickupCity: load.pickup_city,
    pickupState: load.pickup_state,
    deliveryCity: load.delivery_city,
    deliveryState: load.delivery_state,
    pickupDate: load.pickup_date,
    payout: load.driver_payout,
    price: load.price,
    status: load.status,
  };
};

// ============================================
// LOAD LIFECYCLE NOTIFICATIONS
// ============================================

/**
 * When a driver accepts a load
 * - Notify shipper that their load was accepted
 */
const onLoadAccepted = async (loadId, driverId) => {
  try {
    const data = await getLoadNotificationData(loadId);
    if (!data || !data.shipperId) return;

    // Get driver name
    const driverResult = await pool.query(
      'SELECT first_name, last_name FROM users WHERE id = $1',
      [driverId]
    );
    const driverName = driverResult.rows[0] 
      ? `${driverResult.rows[0].first_name} ${driverResult.rows[0].last_name}`.trim()
      : 'A driver';

    await notificationService.notifyShipperDriverAccepted(
      data.shipperId,
      driverName,
      data
    );

    console.log(`[LoadNotifications] Notified shipper ${data.shipperId} of driver acceptance`);
  } catch (error) {
    console.error('[LoadNotifications] onLoadAccepted error:', error);
  }
};

/**
 * When load status changes
 * - Notify shipper of progress
 */
const onStatusChange = async (loadId, newStatus, oldStatus) => {
  try {
    const data = await getLoadNotificationData(loadId);
    if (!data || !data.shipperId) return;

    // Only notify shipper for certain status changes
    const notifyStatuses = [
      'en_route_pickup',
      'at_pickup', 
      'picked_up',
      'en_route_delivery',
      'at_delivery',
      'delivered',
    ];

    if (notifyStatuses.includes(newStatus)) {
      await notificationService.notifyShipperStatusChange(
        data.shipperId,
        newStatus,
        data.driverName,
        data
      );
      console.log(`[LoadNotifications] Notified shipper ${data.shipperId} of status: ${newStatus}`);
    }
  } catch (error) {
    console.error('[LoadNotifications] onStatusChange error:', error);
  }
};

/**
 * When a load is cancelled
 * - Notify the other party
 */
const onLoadCancelled = async (loadId, cancelledBy, cancelledByRole) => {
  try {
    const data = await getLoadNotificationData(loadId);
    if (!data) return;

    if (cancelledByRole === 'shipper' && data.driverId) {
      // Shipper cancelled - notify driver
      await notificationService.sendNotification(
        data.driverId,
        'LOAD_CANCELLED_BY_SHIPPER',
        {
          shipperName: data.shipperName,
          pickupCity: data.pickupCity,
          deliveryCity: data.deliveryCity,
          loadId,
        }
      );
      console.log(`[LoadNotifications] Notified driver ${data.driverId} of shipper cancellation`);
    } else if (cancelledByRole === 'driver' && data.shipperId) {
      // Driver cancelled - notify shipper
      await notificationService.sendNotification(
        data.shipperId,
        'LOAD_CANCELLED_BY_DRIVER',
        {
          driverName: data.driverName,
          pickupCity: data.pickupCity,
          deliveryCity: data.deliveryCity,
          loadId,
        }
      );
      console.log(`[LoadNotifications] Notified shipper ${data.shipperId} of driver cancellation`);
    }
  } catch (error) {
    console.error('[LoadNotifications] onLoadCancelled error:', error);
  }
};

/**
 * When an offer is sent to a driver
 */
const onOfferSent = async (offerId, loadId, driverId) => {
  try {
    const data = await getLoadNotificationData(loadId);
    if (!data) return;

    await notificationService.notifyDriverOfOffer(driverId, data, offerId);
    console.log(`[LoadNotifications] Notified driver ${driverId} of new offer`);
  } catch (error) {
    console.error('[LoadNotifications] onOfferSent error:', error);
  }
};

/**
 * When driver responds to an offer
 */
const onOfferResponse = async (offerId, loadId, response, driverId, counterAmount = null) => {
  try {
    const data = await getLoadNotificationData(loadId);
    if (!data || !data.shipperId) return;

    // Get driver name
    const driverResult = await pool.query(
      'SELECT first_name, last_name FROM users WHERE id = $1',
      [driverId]
    );
    const driverName = driverResult.rows[0] 
      ? `${driverResult.rows[0].first_name} ${driverResult.rows[0].last_name}`.trim()
      : 'A driver';

    if (response === 'declined') {
      await notificationService.sendNotification(
        data.shipperId,
        'DRIVER_DECLINED_OFFER',
        { driverName, loadId, offerId }
      );
    } else if (response === 'countered' && counterAmount) {
      await notificationService.sendNotification(
        data.shipperId,
        'DRIVER_COUNTER_OFFER',
        { driverName, counterAmount, loadId, offerId }
      );
    }
    // Note: 'accepted' is handled by onLoadAccepted

    console.log(`[LoadNotifications] Notified shipper of offer ${response}`);
  } catch (error) {
    console.error('[LoadNotifications] onOfferResponse error:', error);
  }
};

/**
 * When payment is processed for a load
 */
const onPaymentProcessed = async (loadId, driverId, amount, paymentId) => {
  try {
    await notificationService.notifyDriverPayment(driverId, amount, loadId, paymentId);
    console.log(`[LoadNotifications] Notified driver ${driverId} of payment`);
  } catch (error) {
    console.error('[LoadNotifications] onPaymentProcessed error:', error);
  }
};

/**
 * When shipper rates driver
 */
const onDriverRated = async (loadId, driverId, isHot) => {
  try {
    const data = await getLoadNotificationData(loadId);
    if (!data) return;

    await notificationService.notifyDriverRating(
      driverId,
      data.shipperName,
      isHot,
      loadId
    );
    console.log(`[LoadNotifications] Notified driver ${driverId} of rating`);
  } catch (error) {
    console.error('[LoadNotifications] onDriverRated error:', error);
  }
};

module.exports = {
  getLoadNotificationData,
  onLoadAccepted,
  onStatusChange,
  onLoadCancelled,
  onOfferSent,
  onOfferResponse,
  onPaymentProcessed,
  onDriverRated,
};
