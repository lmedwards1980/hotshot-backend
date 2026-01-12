// backend_api/src/services/stripeService.js
// Stripe payment processing service

const Stripe = require('stripe');

// Initialize Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2023-10-16',
});

// ============================================
// CUSTOMER MANAGEMENT
// ============================================

/**
 * Create or get Stripe customer for a user
 */
const getOrCreateCustomer = async (userId, email, name) => {
  const { pool } = require('../db/pool');
  
  // Check if user already has a Stripe customer ID
  const result = await pool.query(
    'SELECT stripe_customer_id FROM users WHERE id = $1',
    [userId]
  );
  
  if (result.rows[0]?.stripe_customer_id) {
    return result.rows[0].stripe_customer_id;
  }
  
  // Create new Stripe customer
  const customer = await stripe.customers.create({
    email,
    name,
    metadata: { userId },
  });
  
  // Save customer ID to database
  await pool.query(
    'UPDATE users SET stripe_customer_id = $1 WHERE id = $2',
    [customer.id, userId]
  );
  
  return customer.id;
};

// ============================================
// PAYMENT METHODS (for Shippers)
// ============================================

/**
 * Create SetupIntent for adding a payment method
 */
const createSetupIntent = async (customerId) => {
  const setupIntent = await stripe.setupIntents.create({
    customer: customerId,
    payment_method_types: ['card'],
  });
  
  return {
    clientSecret: setupIntent.client_secret,
    setupIntentId: setupIntent.id,
  };
};

/**
 * Get customer's saved payment methods
 */
const getPaymentMethods = async (customerId) => {
  const paymentMethods = await stripe.paymentMethods.list({
    customer: customerId,
    type: 'card',
  });
  
  return paymentMethods.data.map(pm => ({
    id: pm.id,
    brand: pm.card.brand,
    last4: pm.card.last4,
    expMonth: pm.card.exp_month,
    expYear: pm.card.exp_year,
  }));
};

/**
 * Delete a payment method
 */
const deletePaymentMethod = async (paymentMethodId) => {
  await stripe.paymentMethods.detach(paymentMethodId);
};

/**
 * Set default payment method
 */
const setDefaultPaymentMethod = async (customerId, paymentMethodId) => {
  await stripe.customers.update(customerId, {
    invoice_settings: { default_payment_method: paymentMethodId },
  });
};

// ============================================
// PAYMENT INTENTS (Charging for Loads)
// ============================================

/**
 * Create payment intent for a load
 * This authorizes the payment (hold) until delivery
 */
const createPaymentIntent = async (loadId, amount, customerId, paymentMethodId = null) => {
  const amountInCents = Math.round(amount * 100);
  
  const paymentIntentData = {
    amount: amountInCents,
    currency: 'usd',
    customer: customerId,
    capture_method: 'manual', // Authorize now, capture later
    metadata: { loadId },
    description: `Hotshot Load #${loadId.slice(-8)}`,
  };
  
  // If specific payment method provided, use it
  if (paymentMethodId) {
    paymentIntentData.payment_method = paymentMethodId;
    paymentIntentData.confirm = true;
    paymentIntentData.off_session = true;
  }
  
  const paymentIntent = await stripe.paymentIntents.create(paymentIntentData);
  
  return {
    paymentIntentId: paymentIntent.id,
    clientSecret: paymentIntent.client_secret,
    status: paymentIntent.status,
  };
};

/**
 * Capture a payment (after delivery confirmed)
 */
const capturePayment = async (paymentIntentId, amountToCapture = null) => {
  const captureData = {};
  if (amountToCapture) {
    captureData.amount_to_capture = Math.round(amountToCapture * 100);
  }
  
  const paymentIntent = await stripe.paymentIntents.capture(
    paymentIntentId,
    captureData
  );
  
  return {
    status: paymentIntent.status,
    amountCaptured: paymentIntent.amount_received / 100,
  };
};

/**
 * Cancel/refund a payment intent
 */
const cancelPayment = async (paymentIntentId) => {
  const paymentIntent = await stripe.paymentIntents.cancel(paymentIntentId);
  return { status: paymentIntent.status };
};

/**
 * Refund a captured payment
 */
const refundPayment = async (paymentIntentId, amount = null) => {
  const refundData = { payment_intent: paymentIntentId };
  if (amount) {
    refundData.amount = Math.round(amount * 100);
  }
  
  const refund = await stripe.refunds.create(refundData);
  return {
    refundId: refund.id,
    status: refund.status,
    amount: refund.amount / 100,
  };
};

// ============================================
// STRIPE CONNECT (for Driver Payouts)
// ============================================

/**
 * Create Stripe Connect account for driver
 */
const createConnectAccount = async (userId, email) => {
  const account = await stripe.accounts.create({
    type: 'express',
    country: 'US',
    email,
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
    business_type: 'individual',
    metadata: { userId },
  });
  
  // Save account ID to database
  const { pool } = require('../db/pool');
  await pool.query(
    'UPDATE users SET stripe_account_id = $1 WHERE id = $2',
    [account.id, userId]
  );
  
  return account.id;
};

/**
 * Get or create Connect account for driver
 */
const getOrCreateConnectAccount = async (userId, email) => {
  const { pool } = require('../db/pool');
  
  const result = await pool.query(
    'SELECT stripe_account_id FROM users WHERE id = $1',
    [userId]
  );
  
  if (result.rows[0]?.stripe_account_id) {
    return result.rows[0].stripe_account_id;
  }
  
  return await createConnectAccount(userId, email);
};

/**
 * Create onboarding link for driver
 */
const createOnboardingLink = async (accountId, returnUrl, refreshUrl) => {
  const accountLink = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: refreshUrl,
    return_url: returnUrl,
    type: 'account_onboarding',
  });
  
  return accountLink.url;
};

/**
 * Create login link for driver to access Stripe dashboard
 */
const createDashboardLink = async (accountId) => {
  const loginLink = await stripe.accounts.createLoginLink(accountId);
  return loginLink.url;
};

/**
 * Get Connect account status
 */
const getConnectAccountStatus = async (accountId) => {
  const account = await stripe.accounts.retrieve(accountId);
  
  return {
    chargesEnabled: account.charges_enabled,
    payoutsEnabled: account.payouts_enabled,
    detailsSubmitted: account.details_submitted,
    requirements: account.requirements,
  };
};

// ============================================
// TRANSFERS & PAYOUTS (Paying Drivers)
// ============================================

/**
 * Transfer funds to driver's Connect account
 * Called after load is delivered and payment captured
 */
const transferToDriver = async (driverAccountId, amount, loadId) => {
  const amountInCents = Math.round(amount * 100);
  
  const transfer = await stripe.transfers.create({
    amount: amountInCents,
    currency: 'usd',
    destination: driverAccountId,
    metadata: { loadId },
    description: `Payout for Load #${loadId.slice(-8)}`,
  });
  
  return {
    transferId: transfer.id,
    amount: transfer.amount / 100,
    status: 'pending', // Funds in transit to driver's account
  };
};

/**
 * Get driver's balance in their Connect account
 */
const getDriverBalance = async (accountId) => {
  const balance = await stripe.balance.retrieve({
    stripeAccount: accountId,
  });
  
  return {
    available: balance.available.reduce((sum, b) => sum + b.amount, 0) / 100,
    pending: balance.pending.reduce((sum, b) => sum + b.amount, 0) / 100,
  };
};

/**
 * Create instant payout for driver (if they have debit card)
 */
const createInstantPayout = async (accountId, amount) => {
  const amountInCents = Math.round(amount * 100);
  
  const payout = await stripe.payouts.create(
    {
      amount: amountInCents,
      currency: 'usd',
      method: 'instant',
    },
    { stripeAccount: accountId }
  );
  
  return {
    payoutId: payout.id,
    amount: payout.amount / 100,
    status: payout.status,
    arrivalDate: payout.arrival_date,
  };
};

// ============================================
// WEBHOOKS
// ============================================

/**
 * Construct and verify webhook event
 */
const constructWebhookEvent = (payload, signature) => {
  return stripe.webhooks.constructEvent(
    payload,
    signature,
    process.env.STRIPE_WEBHOOK_SECRET
  );
};

// ============================================
// EPHEMERAL KEY (for mobile SDK)
// ============================================

/**
 * Create ephemeral key for mobile Stripe SDK
 */
const createEphemeralKey = async (customerId, stripeVersion) => {
  const ephemeralKey = await stripe.ephemeralKeys.create(
    { customer: customerId },
    { apiVersion: stripeVersion }
  );
  
  return ephemeralKey;
};

// ============================================
// EXPORTS
// ============================================

module.exports = {
  stripe,
  // Customer
  getOrCreateCustomer,
  // Payment Methods
  createSetupIntent,
  getPaymentMethods,
  deletePaymentMethod,
  setDefaultPaymentMethod,
  // Payment Intents
  createPaymentIntent,
  capturePayment,
  cancelPayment,
  refundPayment,
  // Connect (Drivers)
  createConnectAccount,
  getOrCreateConnectAccount,
  createOnboardingLink,
  createDashboardLink,
  getConnectAccountStatus,
  // Transfers
  transferToDriver,
  getDriverBalance,
  createInstantPayout,
  // Webhooks
  constructWebhookEvent,
  // Mobile SDK
  createEphemeralKey,
};
