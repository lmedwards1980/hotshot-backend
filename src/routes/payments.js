// backend_api/src/routes/payments.js
// Payment routes with full Stripe integration

const express = require('express');
const router = express.Router();
const { pool } = require('../db/pool');
const { authenticate, requireUserType } = require('../middleware/auth');
const stripeService = require('../services/stripeService');

// ============================================
// STRIPE SETUP (Mobile SDK initialization)
// ============================================

/**
 * POST /payments/setup-intent
 * Create SetupIntent for adding a payment method (Shipper)
 */
router.post('/setup-intent', authenticate, async (req, res) => {
  try {
    const user = req.user;
    
    // Get or create Stripe customer
    const customerId = await stripeService.getOrCreateCustomer(
      user.id,
      user.email,
      `${user.first_name} ${user.last_name}`
    );
    
    // Create setup intent
    const { clientSecret, setupIntentId } = await stripeService.createSetupIntent(customerId);
    
    res.json({
      clientSecret,
      setupIntentId,
      customerId,
    });
  } catch (error) {
    console.error('[Payments] Setup intent error:', error);
    res.status(500).json({ error: 'Failed to create setup intent' });
  }
});

/**
 * POST /payments/payment-sheet
 * Get payment sheet params for mobile SDK
 */
router.post('/payment-sheet', authenticate, async (req, res) => {
  try {
    const { loadId } = req.body;
    const user = req.user;
    
    // Get load details
    const loadResult = await pool.query(
      'SELECT * FROM loads WHERE id = $1 AND shipper_id = $2',
      [loadId, user.id]
    );
    
    if (loadResult.rows.length === 0) {
      return res.status(404).json({ error: 'Load not found' });
    }
    
    const load = loadResult.rows[0];
    
    // Get or create customer
    const customerId = await stripeService.getOrCreateCustomer(
      user.id,
      user.email,
      `${user.first_name} ${user.last_name}`
    );
    
    // Create ephemeral key for mobile SDK
    const ephemeralKey = await stripeService.createEphemeralKey(
      customerId,
      req.body.stripeVersion || '2023-10-16'
    );
    
    // Create payment intent
    const { paymentIntentId, clientSecret } = await stripeService.createPaymentIntent(
      loadId,
      parseFloat(load.price),
      customerId
    );
    
    // Store payment intent ID with load
    await pool.query(
      'UPDATE loads SET stripe_payment_intent_id = $1 WHERE id = $2',
      [paymentIntentId, loadId]
    );
    
    res.json({
      paymentIntent: clientSecret,
      ephemeralKey: ephemeralKey.secret,
      customer: customerId,
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
    });
  } catch (error) {
    console.error('[Payments] Payment sheet error:', error);
    res.status(500).json({ error: 'Failed to create payment sheet' });
  }
});

// ============================================
// PAYMENT METHODS (Shipper)
// ============================================

/**
 * GET /payments/methods
 * Get saved payment methods
 */
router.get('/methods', authenticate, async (req, res) => {
  try {
    const user = req.user;
    
    // Check if user has Stripe customer ID
    const userResult = await pool.query(
      'SELECT stripe_customer_id FROM users WHERE id = $1',
      [user.id]
    );
    
    if (!userResult.rows[0]?.stripe_customer_id) {
      return res.json({ cards: [], defaultMethod: null });
    }
    
    const customerId = userResult.rows[0].stripe_customer_id;
    const cards = await stripeService.getPaymentMethods(customerId);
    
    // Get default
    const customer = await stripeService.stripe.customers.retrieve(customerId);
    const defaultMethod = customer.invoice_settings?.default_payment_method;
    
    res.json({
      cards,
      defaultMethod,
    });
  } catch (error) {
    console.error('[Payments] Get methods error:', error);
    res.status(500).json({ error: 'Failed to get payment methods' });
  }
});

/**
 * DELETE /payments/methods/:id
 * Remove a payment method
 */
router.delete('/methods/:id', authenticate, async (req, res) => {
  try {
    await stripeService.deletePaymentMethod(req.params.id);
    res.json({ success: true });
  } catch (error) {
    console.error('[Payments] Delete method error:', error);
    res.status(500).json({ error: 'Failed to delete payment method' });
  }
});

/**
 * POST /payments/methods/default
 * Set default payment method
 */
router.post('/methods/default', authenticate, async (req, res) => {
  try {
    const { paymentMethodId } = req.body;
    
    const userResult = await pool.query(
      'SELECT stripe_customer_id FROM users WHERE id = $1',
      [req.user.id]
    );
    
    if (!userResult.rows[0]?.stripe_customer_id) {
      return res.status(400).json({ error: 'No Stripe customer found' });
    }
    
    await stripeService.setDefaultPaymentMethod(
      userResult.rows[0].stripe_customer_id,
      paymentMethodId
    );
    
    res.json({ success: true });
  } catch (error) {
    console.error('[Payments] Set default error:', error);
    res.status(500).json({ error: 'Failed to set default method' });
  }
});

// ============================================
// LOAD PAYMENTS (Shipper pays for load)
// ============================================

/**
 * POST /payments/pay-for-load
 * Create payment intent and optionally charge for a load
 */
router.post('/pay-for-load', authenticate, requireUserType('shipper'), async (req, res) => {
  try {
    const { loadId, paymentMethodId } = req.body;
    
    // Get load
    const loadResult = await pool.query(
      'SELECT * FROM loads WHERE id = $1 AND shipper_id = $2',
      [loadId, req.user.id]
    );
    
    if (loadResult.rows.length === 0) {
      return res.status(404).json({ error: 'Load not found' });
    }
    
    const load = loadResult.rows[0];
    
    if (load.payment_status === 'paid' || load.payment_status === 'authorized') {
      return res.status(400).json({ error: 'Load already paid' });
    }
    
    // Get customer ID
    const customerId = await stripeService.getOrCreateCustomer(
      req.user.id,
      req.user.email,
      `${req.user.first_name} ${req.user.last_name}`
    );
    
    // Create payment intent (authorize, don't capture yet)
    const { paymentIntentId, clientSecret, status } = await stripeService.createPaymentIntent(
      loadId,
      parseFloat(load.price),
      customerId,
      paymentMethodId
    );
    
    // Update load with payment info
    await pool.query(`
      UPDATE loads 
      SET stripe_payment_intent_id = $1, 
          payment_status = $2,
          updated_at = NOW()
      WHERE id = $3
    `, [paymentIntentId, status === 'requires_capture' ? 'authorized' : 'pending', loadId]);
    
    res.json({
      success: true,
      paymentIntentId,
      clientSecret,
      status,
    });
  } catch (error) {
    console.error('[Payments] Pay for load error:', error);
    res.status(500).json({ error: error.message || 'Failed to process payment' });
  }
});

/**
 * POST /payments/capture/:loadId
 * Capture payment after delivery (called by system or admin)
 */
router.post('/capture/:loadId', authenticate, async (req, res) => {
  try {
    const { loadId } = req.params;
    
    // Get load with payment intent
    const loadResult = await pool.query(
      'SELECT * FROM loads WHERE id = $1',
      [loadId]
    );
    
    if (loadResult.rows.length === 0) {
      return res.status(404).json({ error: 'Load not found' });
    }
    
    const load = loadResult.rows[0];
    
    if (!load.stripe_payment_intent_id) {
      return res.status(400).json({ error: 'No payment to capture' });
    }
    
    if (load.payment_status === 'captured') {
      return res.status(400).json({ error: 'Payment already captured' });
    }
    
    // Capture the payment
    const { status, amountCaptured } = await stripeService.capturePayment(
      load.stripe_payment_intent_id
    );
    
    // Update load
    await pool.query(`
      UPDATE loads 
      SET payment_status = 'captured',
          updated_at = NOW()
      WHERE id = $1
    `, [loadId]);
    
    // Transfer to driver (if driver is connected)
    if (load.driver_id) {
      const driverResult = await pool.query(
        'SELECT stripe_account_id FROM users WHERE id = $1',
        [load.driver_id]
      );
      
      if (driverResult.rows[0]?.stripe_account_id) {
        const driverPayout = parseFloat(load.driver_payout);
        
        const transfer = await stripeService.transferToDriver(
          driverResult.rows[0].stripe_account_id,
          driverPayout,
          loadId
        );
        
        // Record the transfer
        await pool.query(`
          UPDATE loads 
          SET payout_status = 'transferred',
              stripe_transfer_id = $1,
              payout_at = NOW()
          WHERE id = $2
        `, [transfer.transferId, loadId]);
        
        console.log(`[Payments] Transferred $${driverPayout} to driver for load ${loadId}`);
      }
    }
    
    res.json({
      success: true,
      status,
      amountCaptured,
    });
  } catch (error) {
    console.error('[Payments] Capture error:', error);
    res.status(500).json({ error: 'Failed to capture payment' });
  }
});

/**
 * POST /payments/refund/:loadId
 * Refund a payment (for cancellations)
 */
router.post('/refund/:loadId', authenticate, async (req, res) => {
  try {
    const { loadId } = req.params;
    const { amount } = req.body; // Optional partial refund
    
    const loadResult = await pool.query(
      'SELECT * FROM loads WHERE id = $1 AND (shipper_id = $2 OR $3 = true)',
      [loadId, req.user.id, req.user.role === 'admin']
    );
    
    if (loadResult.rows.length === 0) {
      return res.status(404).json({ error: 'Load not found' });
    }
    
    const load = loadResult.rows[0];
    
    if (!load.stripe_payment_intent_id) {
      return res.status(400).json({ error: 'No payment to refund' });
    }
    
    // If payment was only authorized (not captured), cancel it
    if (load.payment_status === 'authorized') {
      await stripeService.cancelPayment(load.stripe_payment_intent_id);
      await pool.query(
        'UPDATE loads SET payment_status = $1 WHERE id = $2',
        ['cancelled', loadId]
      );
      return res.json({ success: true, action: 'cancelled' });
    }
    
    // If captured, refund
    const refund = await stripeService.refundPayment(
      load.stripe_payment_intent_id,
      amount
    );
    
    await pool.query(
      'UPDATE loads SET payment_status = $1 WHERE id = $2',
      [amount ? 'partially_refunded' : 'refunded', loadId]
    );
    
    res.json({
      success: true,
      action: 'refunded',
      ...refund,
    });
  } catch (error) {
    console.error('[Payments] Refund error:', error);
    res.status(500).json({ error: 'Failed to refund payment' });
  }
});

// ============================================
// STRIPE CONNECT (Driver Onboarding)
// ============================================

/**
 * POST /payments/connect/onboard
 * Start Stripe Connect onboarding for driver
 */
router.post('/connect/onboard', authenticate, requireUserType('driver'), async (req, res) => {
  try {
    const { returnUrl, refreshUrl } = req.body;
    const user = req.user;
    
    // Get or create Connect account
    const accountId = await stripeService.getOrCreateConnectAccount(user.id, user.email);
    
    // Create onboarding link
    const onboardingUrl = await stripeService.createOnboardingLink(
      accountId,
      returnUrl || 'hotshot-platform://stripe-return',
      refreshUrl || 'hotshot-platform://stripe-refresh'
    );
    
    res.json({
      url: onboardingUrl,
      accountId,
    });
  } catch (error) {
    console.error('[Payments] Connect onboard error:', error);
    res.status(500).json({ error: 'Failed to create onboarding link' });
  }
});

/**
 * GET /payments/connect/status
 * Get driver's Stripe Connect account status
 */
router.get('/connect/status', authenticate, requireUserType('driver'), async (req, res) => {
  try {
    const userResult = await pool.query(
      'SELECT stripe_account_id FROM users WHERE id = $1',
      [req.user.id]
    );
    
    if (!userResult.rows[0]?.stripe_account_id) {
      return res.json({
        connected: false,
        chargesEnabled: false,
        payoutsEnabled: false,
      });
    }
    
    const status = await stripeService.getConnectAccountStatus(
      userResult.rows[0].stripe_account_id
    );
    
    res.json({
      connected: true,
      ...status,
    });
  } catch (error) {
    console.error('[Payments] Connect status error:', error);
    res.status(500).json({ error: 'Failed to get account status' });
  }
});

/**
 * GET /payments/connect/dashboard
 * Get link to Stripe Express dashboard for driver
 */
router.get('/connect/dashboard', authenticate, requireUserType('driver'), async (req, res) => {
  try {
    const userResult = await pool.query(
      'SELECT stripe_account_id FROM users WHERE id = $1',
      [req.user.id]
    );
    
    if (!userResult.rows[0]?.stripe_account_id) {
      return res.status(400).json({ error: 'Stripe account not set up' });
    }
    
    const url = await stripeService.createDashboardLink(
      userResult.rows[0].stripe_account_id
    );
    
    res.json({ url });
  } catch (error) {
    console.error('[Payments] Dashboard link error:', error);
    res.status(500).json({ error: 'Failed to create dashboard link' });
  }
});

/**
 * GET /payments/connect/balance
 * Get driver's available balance
 */
router.get('/connect/balance', authenticate, requireUserType('driver'), async (req, res) => {
  try {
    const userResult = await pool.query(
      'SELECT stripe_account_id FROM users WHERE id = $1',
      [req.user.id]
    );
    
    if (!userResult.rows[0]?.stripe_account_id) {
      return res.json({ available: 0, pending: 0 });
    }
    
    const balance = await stripeService.getDriverBalance(
      userResult.rows[0].stripe_account_id
    );
    
    res.json(balance);
  } catch (error) {
    console.error('[Payments] Balance error:', error);
    res.status(500).json({ error: 'Failed to get balance' });
  }
});

/**
 * POST /payments/connect/instant-payout
 * Request instant payout for driver
 */
router.post('/connect/instant-payout', authenticate, requireUserType('driver'), async (req, res) => {
  try {
    const { amount } = req.body;
    
    const userResult = await pool.query(
      'SELECT stripe_account_id FROM users WHERE id = $1',
      [req.user.id]
    );
    
    if (!userResult.rows[0]?.stripe_account_id) {
      return res.status(400).json({ error: 'Stripe account not set up' });
    }
    
    const payout = await stripeService.createInstantPayout(
      userResult.rows[0].stripe_account_id,
      amount
    );
    
    res.json(payout);
  } catch (error) {
    console.error('[Payments] Instant payout error:', error);
    res.status(500).json({ error: error.message || 'Failed to create payout' });
  }
});

// ============================================
// WEBHOOKS
// ============================================

/**
 * POST /payments/webhook
 * Handle Stripe webhooks
 */
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  
  try {
    const event = stripeService.constructWebhookEvent(req.body, sig);
    
    console.log(`[Stripe Webhook] ${event.type}`);
    
    switch (event.type) {
      case 'payment_intent.succeeded':
        // Payment captured successfully
        const paymentIntent = event.data.object;
        if (paymentIntent.metadata.loadId) {
          await pool.query(
            'UPDATE loads SET payment_status = $1 WHERE stripe_payment_intent_id = $2',
            ['captured', paymentIntent.id]
          );
        }
        break;
        
      case 'payment_intent.payment_failed':
        // Payment failed
        const failedIntent = event.data.object;
        if (failedIntent.metadata.loadId) {
          await pool.query(
            'UPDATE loads SET payment_status = $1 WHERE stripe_payment_intent_id = $2',
            ['failed', failedIntent.id]
          );
        }
        break;
        
      case 'account.updated':
        // Connect account updated (driver completed onboarding)
        const account = event.data.object;
        if (account.metadata?.userId) {
          // Could notify driver that account is ready
          console.log(`[Stripe] Account ${account.id} updated for user ${account.metadata.userId}`);
        }
        break;
        
      case 'transfer.created':
        // Transfer to driver created
        console.log(`[Stripe] Transfer ${event.data.object.id} created`);
        break;
        
      case 'payout.paid':
        // Driver payout completed
        console.log(`[Stripe] Payout ${event.data.object.id} paid`);
        break;
    }
    
    res.json({ received: true });
  } catch (error) {
    console.error('[Stripe Webhook] Error:', error);
    res.status(400).json({ error: error.message });
  }
});

// ============================================
// EARNINGS HISTORY (for drivers)
// ============================================

/**
 * GET /payments/earnings
 * Get driver's earnings history
 */
router.get('/earnings', authenticate, requireUserType('driver'), async (req, res) => {
  try {
    const { period = 'week' } = req.query;
    
    let dateFilter = '';
    if (period === 'week') {
      dateFilter = "AND l.delivered_at >= NOW() - INTERVAL '7 days'";
    } else if (period === 'month') {
      dateFilter = "AND l.delivered_at >= NOW() - INTERVAL '30 days'";
    } else if (period === 'year') {
      dateFilter = "AND l.delivered_at >= NOW() - INTERVAL '365 days'";
    }
    
    // Get earnings summary
    const summaryResult = await pool.query(`
      SELECT 
        COUNT(*) as total_loads,
        COALESCE(SUM(driver_payout), 0) as total_earnings,
        COALESCE(SUM(CASE WHEN payout_status = 'transferred' THEN driver_payout ELSE 0 END), 0) as paid_earnings,
        COALESCE(SUM(CASE WHEN payout_status != 'transferred' AND status = 'delivered' THEN driver_payout ELSE 0 END), 0) as pending_earnings
      FROM loads l
      WHERE driver_id = $1 
      AND status IN ('delivered', 'completed')
      ${dateFilter}
    `, [req.user.id]);
    
    // Get recent loads
    const loadsResult = await pool.query(`
      SELECT 
        id, pickup_city, pickup_state, delivery_city, delivery_state,
        driver_payout, payout_status, delivered_at, status
      FROM loads
      WHERE driver_id = $1 
      AND status IN ('delivered', 'completed')
      ${dateFilter}
      ORDER BY delivered_at DESC
      LIMIT 20
    `, [req.user.id]);
    
    res.json({
      summary: {
        totalLoads: parseInt(summaryResult.rows[0].total_loads) || 0,
        totalEarnings: parseFloat(summaryResult.rows[0].total_earnings) || 0,
        paidEarnings: parseFloat(summaryResult.rows[0].paid_earnings) || 0,
        pendingEarnings: parseFloat(summaryResult.rows[0].pending_earnings) || 0,
      },
      loads: loadsResult.rows.map(l => ({
        id: l.id,
        route: `${l.pickup_city}, ${l.pickup_state} → ${l.delivery_city}, ${l.delivery_state}`,
        amount: parseFloat(l.driver_payout),
        status: l.payout_status || 'pending',
        deliveredAt: l.delivered_at,
      })),
    });
  } catch (error) {
    console.error('[Payments] Earnings error:', error);
    res.status(500).json({ error: 'Failed to get earnings' });
  }
});

module.exports = router;
