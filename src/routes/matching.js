// backend_api/src/routes/matching.js
// Driver-Load Matching API Endpoints

const express = require('express');
const router = express.Router();
const { pool } = require('../db/pool');
const { authenticate, requireUserType } = require('../middleware/auth');
const matchingService = require('../services/matchingService');

// ============================================
// GET /api/matching/loads/:loadId/matches
// Get ranked driver matches for a load (shipper only)
// ============================================

router.get('/loads/:loadId/matches', authenticate, async (req, res) => {
  try {
    const { loadId } = req.params;
    const {
      maxResults = 20,
      includeWider = false,
      maxDeadhead,
      maxDetour,
    } = req.query;
    
    // Verify user owns this load (shipper check)
    const loadCheck = await pool.query(
      'SELECT shipper_id FROM loads WHERE id = $1',
      [loadId]
    );
    
    if (loadCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Load not found' });
    }
    
    if (loadCheck.rows[0].shipper_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized to view matches for this load' });
    }
    
    const options = {
      maxResults: Math.min(parseInt(maxResults) || 20, 50),
      includeWiderMatches: includeWider === 'true',
    };
    
    if (maxDeadhead) options.maxDeadheadMiles = parseInt(maxDeadhead);
    if (maxDetour) options.maxDetourMiles = parseInt(maxDetour);
    
    const result = await matchingService.findMatchesForLoad(loadId, options);
    
    res.json(result);
    
  } catch (error) {
    console.error('[Matching] Error finding matches:', error);
    res.status(500).json({ error: error.message || 'Failed to find matches' });
  }
});

// ============================================
// POST /api/matching/loads/:loadId/offers
// Send offers to selected drivers ("Shoot Your Shot")
// ============================================

router.post('/loads/:loadId/offers', authenticate, async (req, res) => {
  try {
    const { loadId } = req.params;
    const { driverIds, expiresInMinutes = 10 } = req.body;
    
    if (!driverIds || !Array.isArray(driverIds) || driverIds.length === 0) {
      return res.status(400).json({ error: 'driverIds array required' });
    }
    
    if (driverIds.length > 10) {
      return res.status(400).json({ error: 'Maximum 10 drivers per offer batch' });
    }
    
    // Verify user owns this load
    const loadResult = await pool.query(
      'SELECT * FROM loads WHERE id = $1',
      [loadId]
    );
    
    if (loadResult.rows.length === 0) {
      return res.status(404).json({ error: 'Load not found' });
    }
    
    const load = loadResult.rows[0];
    
    if (load.shipper_id !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    if (load.status !== 'posted') {
      return res.status(400).json({ error: `Load status is '${load.status}', offers can only be sent for 'posted' loads` });
    }
    
    // Calculate expiry time
    const expiresAt = new Date(Date.now() + expiresInMinutes * 60 * 1000);
    
    // Create offers for each driver
    const offers = [];
    const errors = [];
    
    for (const driverId of driverIds) {
      try {
        // Check if offer already exists
        const existingOffer = await pool.query(
          'SELECT id FROM load_offers WHERE load_id = $1 AND driver_id = $2',
          [loadId, driverId]
        );
        
        if (existingOffer.rows.length > 0) {
          errors.push({ driverId, error: 'Offer already sent to this driver' });
          continue;
        }
        
        // Get match details for this driver
        const matchResult = await matchingService.findMatchesForLoad(loadId, {
          maxResults: 50,
          includeWiderMatches: true,
          minScore: 0,
        });
        
        const match = matchResult.matches.find(m => m.driverId === driverId);
        
        const offerResult = await pool.query(`
          INSERT INTO load_offers (
            load_id, driver_id, offer_amount, driver_payout,
            deadhead_miles, route_fit_score, status, expires_at
          ) VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)
          RETURNING *
        `, [
          loadId,
          driverId,
          load.price,
          load.driver_payout,
          match?.deadheadMiles || null,
          match?.score || null,
          expiresAt,
        ]);
        
        offers.push({
          offerId: offerResult.rows[0].id,
          driverId,
          score: match?.score,
          matchLabel: match?.matchLabel,
          expiresAt,
        });
        
        // TODO: Send push notification to driver
        // await notificationService.sendOfferNotification(driverId, loadId, offerResult.rows[0].id);
        
      } catch (err) {
        errors.push({ driverId, error: err.message });
      }
    }
    
    res.json({
      message: `Sent ${offers.length} offers`,
      offers,
      errors: errors.length > 0 ? errors : undefined,
      expiresAt,
    });
    
  } catch (error) {
    console.error('[Matching] Error sending offers:', error);
    res.status(500).json({ error: 'Failed to send offers' });
  }
});

// ============================================
// GET /api/matching/offers
// Get offers for current user (driver: received, shipper: sent)
// ============================================

router.get('/offers', authenticate, async (req, res) => {
  try {
    const { status = 'pending' } = req.query;
    
    let query;
    let params;
    
    if (req.user.role === 'driver') {
      // Driver sees offers sent to them
      query = `
        SELECT 
          o.*,
          l.pickup_city, l.pickup_state, l.delivery_city, l.delivery_state,
          l.pickup_date, l.pickup_time_start, l.pickup_time_end,
          l.distance_miles, l.load_type, l.vehicle_type_required,
          l.description,
          s.first_name as shipper_first_name, s.last_name as shipper_last_name,
          s.company_name as shipper_company
        FROM load_offers o
        JOIN loads l ON o.load_id = l.id
        JOIN users s ON l.shipper_id = s.id
        WHERE o.driver_id = $1
          AND ($2 = 'all' OR o.status = $2)
          AND (o.expires_at > NOW() OR o.status != 'pending')
        ORDER BY o.created_at DESC
      `;
      params = [req.user.id, status];
    } else {
      // Shipper sees offers they've sent
      query = `
        SELECT 
          o.*,
          l.pickup_city, l.pickup_state, l.delivery_city, l.delivery_state,
          d.first_name as driver_first_name, d.last_name as driver_last_name,
          d.rating as driver_rating, d.total_deliveries
        FROM load_offers o
        JOIN loads l ON o.load_id = l.id
        JOIN users d ON o.driver_id = d.id
        WHERE l.shipper_id = $1
          AND ($2 = 'all' OR o.status = $2)
        ORDER BY o.created_at DESC
      `;
      params = [req.user.id, status];
    }
    
    const result = await pool.query(query, params);
    
    res.json({ offers: result.rows });
    
  } catch (error) {
    console.error('[Matching] Error fetching offers:', error);
    res.status(500).json({ error: 'Failed to fetch offers' });
  }
});

// ============================================
// POST /api/matching/offers/:offerId/respond
// Driver responds to an offer (accept/decline/counter)
// ============================================

router.post('/offers/:offerId/respond', authenticate, async (req, res) => {
  try {
    const { offerId } = req.params;
    const { action, counterAmount } = req.body; // action: 'accept', 'decline', 'counter'
    
    if (!['accept', 'decline', 'counter'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action. Must be accept, decline, or counter' });
    }
    
    // Get offer and verify ownership
    const offerResult = await pool.query(`
      SELECT o.*, l.status as load_status, l.shipper_id
      FROM load_offers o
      JOIN loads l ON o.load_id = l.id
      WHERE o.id = $1
    `, [offerId]);
    
    if (offerResult.rows.length === 0) {
      return res.status(404).json({ error: 'Offer not found' });
    }
    
    const offer = offerResult.rows[0];
    
    if (offer.driver_id !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    if (offer.status !== 'pending') {
      return res.status(400).json({ error: `Offer already ${offer.status}` });
    }
    
    if (new Date(offer.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Offer has expired' });
    }
    
    if (offer.load_status !== 'posted') {
      return res.status(400).json({ error: 'Load is no longer available' });
    }
    
    // Handle the response
    if (action === 'accept') {
      // Start transaction
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        
        // Update offer status
        await client.query(
          'UPDATE load_offers SET status = $1, responded_at = NOW() WHERE id = $2',
          ['accepted', offerId]
        );
        
        // Assign load to driver
        await client.query(`
          UPDATE loads 
          SET driver_id = $1, status = 'assigned', assigned_at = NOW()
          WHERE id = $2
        `, [req.user.id, offer.load_id]);
        
        // Expire all other pending offers for this load
        await client.query(`
          UPDATE load_offers 
          SET status = 'expired', responded_at = NOW()
          WHERE load_id = $1 AND id != $2 AND status = 'pending'
        `, [offer.load_id, offerId]);
        
        await client.query('COMMIT');
        
        // TODO: Notify shipper that driver accepted
        // TODO: Notify other drivers that load was taken
        
        res.json({
          message: 'Offer accepted! Load assigned to you.',
          loadId: offer.load_id,
          status: 'assigned',
        });
        
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
      
    } else if (action === 'decline') {
      await pool.query(
        'UPDATE load_offers SET status = $1, responded_at = NOW() WHERE id = $2',
        ['declined', offerId]
      );
      
      res.json({ message: 'Offer declined' });
      
    } else if (action === 'counter') {
      if (!counterAmount || counterAmount <= 0) {
        return res.status(400).json({ error: 'counterAmount required for counter offer' });
      }
      
      await pool.query(
        'UPDATE load_offers SET status = $1, counter_amount = $2, responded_at = NOW() WHERE id = $3',
        ['countered', counterAmount, offerId]
      );
      
      // TODO: Notify shipper of counter offer
      
      res.json({
        message: 'Counter offer sent',
        counterAmount,
      });
    }
    
  } catch (error) {
    console.error('[Matching] Error responding to offer:', error);
    res.status(500).json({ error: 'Failed to respond to offer' });
  }
});

// ============================================
// GET /api/matching/stats
// Get matching stats (admin/debug)
// ============================================

router.get('/stats', authenticate, async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT 
        (SELECT COUNT(*) FROM driver_availability WHERE is_active = true) as active_availability,
        (SELECT COUNT(*) FROM loads WHERE status = 'posted') as posted_loads,
        (SELECT COUNT(*) FROM load_offers WHERE status = 'pending' AND expires_at > NOW()) as pending_offers,
        (SELECT COUNT(*) FROM load_offers WHERE status = 'accepted') as accepted_offers,
        (SELECT AVG(route_fit_score) FROM load_offers WHERE status = 'accepted') as avg_accepted_score
    `);
    
    res.json(stats.rows[0]);
    
  } catch (error) {
    console.error('[Matching] Error fetching stats:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

module.exports = router;
