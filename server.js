// Eventer Backend Server for Stripe Payments
// Run with: node server.js

const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Use test key for now, will switch to live key in production
const stripeSecretKey = process.env.STRIPE_SECRET_KEY || process.env.STRIPE_TEST_SECRET_KEY;
const stripe = require('stripe')(stripeSecretKey);

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Create a payment intent for subscription
app.post('/create-payment-intent', async (req, res) => {
  try {
    const { priceId, amount, currency, customerId, customerEmail } = req.body;

    // Create or retrieve customer
    let customer;
    if (customerId) {
      // Try to find existing Stripe customer by metadata
      const customers = await stripe.customers.list({
        email: customerEmail,
        limit: 1,
      });

      if (customers.data.length > 0) {
        customer = customers.data[0];
      } else {
        // Create new customer
        customer = await stripe.customers.create({
          email: customerEmail,
          metadata: {
            eventer_user_id: customerId,
          },
        });
      }
    } else {
      customer = await stripe.customers.create({
        email: customerEmail,
      });
    }

    // Create ephemeral key for the customer
    const ephemeralKey = await stripe.ephemeralKeys.create(
      { customer: customer.id },
      { apiVersion: '2023-10-16' }
    );

    // Create payment intent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount,
      currency: currency || 'usd',
      customer: customer.id,
      metadata: {
        price_id: priceId,
        eventer_user_id: customerId,
      },
      automatic_payment_methods: {
        enabled: true,
      },
    });

    res.json({
      paymentIntent: paymentIntent.client_secret,
      ephemeralKey: ephemeralKey.secret,
      customer: customer.id,
      publishableKey: process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY,
    });
  } catch (error) {
    console.error('Error creating payment intent:', error);
    res.status(500).json({ error: error.message });
  }
});

// Validate a promo code
app.post('/validate-promo', async (req, res) => {
  try {
    const { promoCode } = req.body;

    if (!promoCode) {
      return res.status(400).json({ valid: false, error: 'Promo code is required' });
    }

    // Look up the promotion code in Stripe
    const promotionCodes = await stripe.promotionCodes.list({
      code: promoCode.toUpperCase(),
      active: true,
      limit: 1,
    });

    if (promotionCodes.data.length === 0) {
      return res.json({ valid: false });
    }

    const promoCodeObj = promotionCodes.data[0];
    const coupon = promoCodeObj.coupon;

    res.json({
      valid: true,
      promoCodeId: promoCodeObj.id,
      percentOff: coupon.percent_off,
      amountOff: coupon.amount_off,
      duration: coupon.duration,
      durationInMonths: coupon.duration_in_months,
    });
  } catch (error) {
    console.error('Error validating promo code:', error);
    res.status(500).json({ valid: false, error: error.message });
  }
});

// Create a subscription (for recurring payments)
app.post('/create-subscription', async (req, res) => {
  try {
    const { priceId, customerEmail, customerId, promoCode } = req.body;

    // Create or retrieve customer
    let customer;
    const customers = await stripe.customers.list({
      email: customerEmail,
      limit: 1,
    });

    if (customers.data.length > 0) {
      customer = customers.data[0];
    } else {
      customer = await stripe.customers.create({
        email: customerEmail,
        metadata: {
          eventer_user_id: customerId,
        },
      });
    }

    // Create ephemeral key
    const ephemeralKey = await stripe.ephemeralKeys.create(
      { customer: customer.id },
      { apiVersion: '2023-10-16' }
    );

    // Build subscription options
    const subscriptionOptions = {
      customer: customer.id,
      items: [{ price: priceId }],
      payment_behavior: 'default_incomplete',
      payment_settings: { save_default_payment_method: 'on_subscription' },
      expand: ['latest_invoice.payment_intent'],
      metadata: {
        eventer_user_id: customerId,
      },
    };

    // Apply promo code if provided
    if (promoCode) {
      const promotionCodes = await stripe.promotionCodes.list({
        code: promoCode.toUpperCase(),
        active: true,
        limit: 1,
      });

      if (promotionCodes.data.length > 0) {
        subscriptionOptions.promotion_code = promotionCodes.data[0].id;
      }
    }

    // Create subscription with payment behavior
    const subscription = await stripe.subscriptions.create(subscriptionOptions);

    res.json({
      subscriptionId: subscription.id,
      paymentIntent: subscription.latest_invoice.payment_intent.client_secret,
      ephemeralKey: ephemeralKey.secret,
      customer: customer.id,
    });
  } catch (error) {
    console.error('Error creating subscription:', error);
    res.status(500).json({ error: error.message });
  }
});

// Cancel a subscription
app.post('/cancel-subscription', async (req, res) => {
  try {
    const { customerId } = req.body;

    if (!customerId) {
      return res.status(400).json({ error: 'Customer ID is required' });
    }

    // List all active subscriptions for this customer
    const subscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status: 'active',
      limit: 10,
    });

    if (subscriptions.data.length === 0) {
      return res.status(404).json({ error: 'No active subscription found' });
    }

    // Cancel all active subscriptions (usually just one)
    const canceledSubscriptions = [];
    for (const subscription of subscriptions.data) {
      const canceled = await stripe.subscriptions.cancel(subscription.id);
      canceledSubscriptions.push(canceled.id);
    }

    res.json({
      success: true,
      canceledSubscriptions,
    });
  } catch (error) {
    console.error('Error canceling subscription:', error);
    res.status(500).json({ error: error.message });
  }
});

// Webhook endpoint for Stripe events
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the event
  switch (event.type) {
    case 'payment_intent.succeeded':
      const paymentIntent = event.data.object;
      console.log('Payment succeeded:', paymentIntent.id);
      // Update user subscription in your database
      break;

    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      const subscription = event.data.object;
      console.log('Subscription updated:', subscription.id, subscription.status);
      // Update user subscription status
      break;

    case 'customer.subscription.deleted':
      const canceledSubscription = event.data.object;
      console.log('Subscription canceled:', canceledSubscription.id);
      // Downgrade user to free tier
      break;

    default:
      console.log(`Unhandled event type: ${event.type}`);
  }

  res.json({ received: true });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    service: 'Eventer Payment API',
    status: 'running',
    endpoints: ['/create-subscription', '/create-payment-intent', '/cancel-subscription', '/validate-promo', '/health']
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Eventer payment server running on port ${PORT}`);
  console.log(`Stripe key configured: ${stripeSecretKey ? 'Yes (length: ' + stripeSecretKey.length + ')' : 'No'}`);
});
