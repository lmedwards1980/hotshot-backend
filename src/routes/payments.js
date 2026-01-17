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

// ============================================
// PAYOUT SETTINGS (Driver)
// ============================================

/**
 * GET /payments/payout-settings
 * Get driver's payout settings
 */
router.get('/payout-settings', authenticate, async (req, res) => {
  try {
    const userResult = await pool.query(`
      SELECT
        stripe_account_id,
        payout_schedule,
        instant_payout_enabled,
        default_payout_method
      FROM users
      WHERE id = $1
    `, [req.user.id]);

    if (!userResult.rows[0]?.stripe_account_id) {
      return res.json({
        connected: false,
        payoutSchedule: 'manual',
        instantPayoutEnabled: false,
        defaultPayoutMethod: null,
        bankAccounts: [],
        cards: [],
      });
    }

    const user = userResult.rows[0];

    // Get external accounts from Stripe
    let bankAccounts = [];
    let cards = [];

    try {
      const account = await stripeService.stripe.accounts.retrieve(user.stripe_account_id, {
        expand: ['external_accounts']
      });

      if (account.external_accounts?.data) {
        bankAccounts = account.external_accounts.data
          .filter(a => a.object === 'bank_account')
          .map(a => ({
            id: a.id,
            bankName: a.bank_name,
            last4: a.last4,
            routingNumber: a.routing_number,
            isDefault: a.default_for_currency,
            status: a.status,
          }));

        cards = account.external_accounts.data
          .filter(a => a.object === 'card')
          .map(a => ({
            id: a.id,
            brand: a.brand,
            last4: a.last4,
            expMonth: a.exp_month,
            expYear: a.exp_year,
            isDefault: a.default_for_currency,
          }));
      }
    } catch (stripeError) {
      console.error('[Payments] Failed to get external accounts:', stripeError.message);
    }

    res.json({
      connected: true,
      payoutSchedule: user.payout_schedule || 'daily',
      instantPayoutEnabled: user.instant_payout_enabled || false,
      defaultPayoutMethod: user.default_payout_method,
      bankAccounts,
      cards,
    });
  } catch (error) {
    console.error('[Payments] Get payout settings error:', error);
    res.status(500).json({ error: 'Failed to get payout settings' });
  }
});

/**
 * PUT /payments/payout-settings
 * Update driver's payout settings
 */
router.put('/payout-settings', authenticate, async (req, res) => {
  try {
    const { payoutSchedule, instantPayoutEnabled, defaultPayoutMethod } = req.body;

    const userResult = await pool.query(
      'SELECT stripe_account_id FROM users WHERE id = $1',
      [req.user.id]
    );

    if (!userResult.rows[0]?.stripe_account_id) {
      return res.status(400).json({ error: 'Stripe account not set up' });
    }

    const accountId = userResult.rows[0].stripe_account_id;

    // Update Stripe payout schedule if changed
    if (payoutSchedule) {
      const validSchedules = ['manual', 'daily', 'weekly', 'monthly'];
      if (!validSchedules.includes(payoutSchedule)) {
        return res.status(400).json({ error: 'Invalid payout schedule' });
      }

      try {
        let stripeSchedule = {};
        if (payoutSchedule === 'manual') {
          stripeSchedule = { interval: 'manual' };
        } else if (payoutSchedule === 'daily') {
          stripeSchedule = { interval: 'daily' };
        } else if (payoutSchedule === 'weekly') {
          stripeSchedule = { interval: 'weekly', weekly_anchor: 'friday' };
        } else if (payoutSchedule === 'monthly') {
          stripeSchedule = { interval: 'monthly', monthly_anchor: 1 };
        }

        await stripeService.stripe.accounts.update(accountId, {
          settings: {
            payouts: {
              schedule: stripeSchedule
            }
          }
        });
      } catch (stripeError) {
        console.error('[Payments] Failed to update Stripe schedule:', stripeError.message);
        // Continue with local update even if Stripe fails
      }
    }

    // Update default payout method in Stripe if changed
    if (defaultPayoutMethod) {
      try {
        await stripeService.stripe.accounts.update(accountId, {
          default_currency: 'usd',
        });
        // Set the default external account
        await stripeService.stripe.accounts.updateExternalAccount(
          accountId,
          defaultPayoutMethod,
          { default_for_currency: true }
        );
      } catch (stripeError) {
        console.error('[Payments] Failed to update default method:', stripeError.message);
      }
    }

    // Update local database
    const updates = [];
    const values = [];
    let paramCount = 0;

    if (payoutSchedule !== undefined) {
      paramCount++;
      updates.push(`payout_schedule = $${paramCount}`);
      values.push(payoutSchedule);
    }

    if (instantPayoutEnabled !== undefined) {
      paramCount++;
      updates.push(`instant_payout_enabled = $${paramCount}`);
      values.push(instantPayoutEnabled);
    }

    if (defaultPayoutMethod !== undefined) {
      paramCount++;
      updates.push(`default_payout_method = $${paramCount}`);
      values.push(defaultPayoutMethod);
    }

    if (updates.length > 0) {
      paramCount++;
      values.push(req.user.id);
      await pool.query(
        `UPDATE users SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${paramCount}`,
        values
      );
    }

    res.json({
      message: 'Payout settings updated',
      payoutSchedule,
      instantPayoutEnabled,
      defaultPayoutMethod,
    });
  } catch (error) {
    console.error('[Payments] Update payout settings error:', error);
    res.status(500).json({ error: 'Failed to update payout settings' });
  }
});

/**
 * POST /payments/instant-payout
 * Request instant payout (simplified endpoint for driver app)
 */
router.post('/instant-payout', authenticate, async (req, res) => {
  try {
    const { amount } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Valid amount is required' });
    }

    const userResult = await pool.query(
      'SELECT stripe_account_id, instant_payout_enabled FROM users WHERE id = $1',
      [req.user.id]
    );

    if (!userResult.rows[0]?.stripe_account_id) {
      return res.status(400).json({ error: 'Stripe account not set up' });
    }

    const user = userResult.rows[0];

    // Check balance
    const balance = await stripeService.getDriverBalance(user.stripe_account_id);

    if (balance.available < amount) {
      return res.status(400).json({
        error: 'Insufficient balance',
        available: balance.available,
        requested: amount,
      });
    }

    // Create instant payout
    const payout = await stripeService.createInstantPayout(
      user.stripe_account_id,
      amount
    );

    // Record payout in database
    await pool.query(`
      INSERT INTO payout_history (user_id, amount, type, status, stripe_payout_id)
      VALUES ($1, $2, 'instant', $3, $4)
    `, [req.user.id, amount, payout.status, payout.id]);

    res.json({
      success: true,
      payoutId: payout.id,
      amount: payout.amount / 100,
      status: payout.status,
      arrivalDate: payout.arrival_date,
      fee: payout.fee ? payout.fee / 100 : 0,
    });
  } catch (error) {
    console.error('[Payments] Instant payout error:', error);
    res.status(500).json({ error: error.message || 'Failed to create instant payout' });
  }
});

// ============================================
// BANK ACCOUNTS & CARDS (Driver Payout Methods)
// ============================================

/**
 * POST /payments/bank-accounts
 * Add bank account for driver payouts
 */
router.post('/bank-accounts', authenticate, async (req, res) => {
  try {
    const {
      accountHolderName,
      routingNumber,
      accountNumber,
      accountHolderType = 'individual', // 'individual' or 'company'
    } = req.body;

    // Validate required fields
    if (!accountHolderName || !routingNumber || !accountNumber) {
      return res.status(400).json({
        error: 'Account holder name, routing number, and account number are required'
      });
    }

    // Validate routing number format (9 digits)
    if (!/^\d{9}$/.test(routingNumber)) {
      return res.status(400).json({ error: 'Invalid routing number format' });
    }

    // Get user's Stripe account
    const userResult = await pool.query(
      'SELECT stripe_account_id FROM users WHERE id = $1',
      [req.user.id]
    );

    if (!userResult.rows[0]?.stripe_account_id) {
      return res.status(400).json({ error: 'Stripe account not set up. Please complete onboarding first.' });
    }

    const accountId = userResult.rows[0].stripe_account_id;

    // Create bank account token
    const token = await stripeService.stripe.tokens.create({
      bank_account: {
        country: 'US',
        currency: 'usd',
        account_holder_name: accountHolderName,
        account_holder_type: accountHolderType,
        routing_number: routingNumber,
        account_number: accountNumber,
      },
    });

    // Add bank account to Connect account
    const bankAccount = await stripeService.stripe.accounts.createExternalAccount(
      accountId,
      { external_account: token.id }
    );

    res.status(201).json({
      message: 'Bank account added successfully',
      bankAccount: {
        id: bankAccount.id,
        bankName: bankAccount.bank_name,
        last4: bankAccount.last4,
        routingNumber: bankAccount.routing_number,
        isDefault: bankAccount.default_for_currency,
        status: bankAccount.status,
      },
    });
  } catch (error) {
    console.error('[Payments] Add bank account error:', error);

    // Handle specific Stripe errors
    if (error.type === 'StripeInvalidRequestError') {
      return res.status(400).json({ error: error.message });
    }

    res.status(500).json({ error: 'Failed to add bank account' });
  }
});

/**
 * POST /payments/cards
 * Add debit card for driver instant payouts
 */
router.post('/cards', authenticate, async (req, res) => {
  try {
    const {
      cardNumber,
      expMonth,
      expYear,
      cvc,
      cardholderName,
    } = req.body;

    // Validate required fields
    if (!cardNumber || !expMonth || !expYear || !cvc) {
      return res.status(400).json({
        error: 'Card number, expiration date, and CVC are required'
      });
    }

    // Get user's Stripe account
    const userResult = await pool.query(
      'SELECT stripe_account_id FROM users WHERE id = $1',
      [req.user.id]
    );

    if (!userResult.rows[0]?.stripe_account_id) {
      return res.status(400).json({ error: 'Stripe account not set up. Please complete onboarding first.' });
    }

    const accountId = userResult.rows[0].stripe_account_id;

    // Create card token
    // Note: In production, card details should be tokenized client-side using Stripe.js
    const token = await stripeService.stripe.tokens.create({
      card: {
        number: cardNumber.replace(/\s/g, ''),
        exp_month: parseInt(expMonth),
        exp_year: parseInt(expYear),
        cvc: cvc,
        name: cardholderName,
        currency: 'usd',
      },
    });

    // Add card to Connect account as external account (for payouts)
    const card = await stripeService.stripe.accounts.createExternalAccount(
      accountId,
      { external_account: token.id }
    );

    // Enable instant payouts for this user
    await pool.query(
      'UPDATE users SET instant_payout_enabled = true WHERE id = $1',
      [req.user.id]
    );

    res.status(201).json({
      message: 'Debit card added successfully',
      card: {
        id: card.id,
        brand: card.brand,
        last4: card.last4,
        expMonth: card.exp_month,
        expYear: card.exp_year,
        isDefault: card.default_for_currency,
      },
      instantPayoutEnabled: true,
    });
  } catch (error) {
    console.error('[Payments] Add card error:', error);

    // Handle specific Stripe errors
    if (error.type === 'StripeCardError') {
      return res.status(400).json({ error: error.message });
    }
    if (error.type === 'StripeInvalidRequestError') {
      return res.status(400).json({ error: error.message });
    }

    res.status(500).json({ error: 'Failed to add debit card' });
  }
});

/**
 * DELETE /payments/bank-accounts/:id
 * Remove a bank account
 */
router.delete('/bank-accounts/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const userResult = await pool.query(
      'SELECT stripe_account_id FROM users WHERE id = $1',
      [req.user.id]
    );

    if (!userResult.rows[0]?.stripe_account_id) {
      return res.status(400).json({ error: 'Stripe account not set up' });
    }

    await stripeService.stripe.accounts.deleteExternalAccount(
      userResult.rows[0].stripe_account_id,
      id
    );

    res.json({ message: 'Bank account removed successfully' });
  } catch (error) {
    console.error('[Payments] Delete bank account error:', error);
    res.status(500).json({ error: 'Failed to remove bank account' });
  }
});

/**
 * DELETE /payments/cards/:id
 * Remove a debit card
 */
router.delete('/cards/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const userResult = await pool.query(
      'SELECT stripe_account_id FROM users WHERE id = $1',
      [req.user.id]
    );

    if (!userResult.rows[0]?.stripe_account_id) {
      return res.status(400).json({ error: 'Stripe account not set up' });
    }

    await stripeService.stripe.accounts.deleteExternalAccount(
      userResult.rows[0].stripe_account_id,
      id
    );

    // Check if any debit cards remain for instant payouts
    const account = await stripeService.stripe.accounts.retrieve(
      userResult.rows[0].stripe_account_id,
      { expand: ['external_accounts'] }
    );

    const hasDebitCard = account.external_accounts?.data?.some(
      a => a.object === 'card'
    );

    if (!hasDebitCard) {
      await pool.query(
        'UPDATE users SET instant_payout_enabled = false WHERE id = $1',
        [req.user.id]
      );
    }

    res.json({
      message: 'Card removed successfully',
      instantPayoutEnabled: hasDebitCard,
    });
  } catch (error) {
    console.error('[Payments] Delete card error:', error);
    res.status(500).json({ error: 'Failed to remove card' });
  }
});

module.exports = router;
