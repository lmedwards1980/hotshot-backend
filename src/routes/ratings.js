/**
 * Ratings Routes
 * Handles rating shippers after delivery and viewing ratings
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../config');
const { authenticate, requireUserType } = require('../middleware/auth');

/**
 * POST /ratings
 * Submit a rating for a shipper after delivery
 */
router.post('/',
  authenticate,
  requireUserType('driver'),
  async (req, res) => {
    try {
      const { loadId, shipperId, rating, comment, tags } = req.body;
      const driverId = req.user.id;

      // Validate rating
      if (!rating || rating < 1 || rating > 5) {
        return res.status(400).json({ error: 'Rating must be between 1 and 5' });
      }

      if (!loadId) {
        return res.status(400).json({ error: 'Load ID is required' });
      }

      // Verify the load exists and was delivered by this driver
      const loadCheck = await pool.query(
        `SELECT l.*, l.shipper_id 
         FROM loads l 
         WHERE l.id = $1 AND l.driver_id = $2 AND l.status = 'delivered'`,
        [loadId, driverId]
      );

      if (loadCheck.rows.length === 0) {
        return res.status(404).json({ error: 'Load not found or not eligible for rating' });
      }

      const load = loadCheck.rows[0];
      const actualShipperId = shipperId || load.shipper_id;

      // Check if already rated
      const existingRating = await pool.query(
        'SELECT id FROM shipper_ratings WHERE load_id = $1 AND driver_id = $2',
        [loadId, driverId]
      );

      if (existingRating.rows.length > 0) {
        return res.status(409).json({ error: 'You have already rated this shipper for this load' });
      }

      // Insert rating
      const result = await pool.query(
        `INSERT INTO shipper_ratings (
          load_id, driver_id, shipper_id, rating, comment, tags, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
        RETURNING *`,
        [loadId, driverId, actualShipperId, rating, comment || null, tags || null]
      );

      // Update shipper's average rating
      await pool.query(`
        UPDATE users 
        SET 
          shipper_rating = (
            SELECT ROUND(AVG(rating)::numeric, 2) 
            FROM shipper_ratings 
            WHERE shipper_id = $1
          ),
          shipper_rating_count = (
            SELECT COUNT(*) 
            FROM shipper_ratings 
            WHERE shipper_id = $1
          )
        WHERE id = $1
      `, [actualShipperId]);

      // Mark load as rated
      await pool.query(
        'UPDATE loads SET shipper_rated = true WHERE id = $1',
        [loadId]
      );

      res.status(201).json({
        message: 'Rating submitted successfully',
        rating: result.rows[0],
      });
    } catch (error) {
      console.error('[Ratings] Submit error:', error);
      res.status(500).json({ error: 'Failed to submit rating' });
    }
  }
);

/**
 * GET /ratings/pending
 * Get loads that haven't been rated yet
 */
router.get('/pending',
  authenticate,
  requireUserType('driver'),
  async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT 
          l.id,
          l.pickup_city,
          l.pickup_state,
          l.delivery_city,
          l.delivery_state,
          l.driver_payout,
          l.delivered_at,
          l.shipper_id,
          u.company_name as shipper_name
        FROM loads l
        LEFT JOIN users u ON l.shipper_id = u.id
        WHERE l.driver_id = $1 
          AND l.status = 'delivered'
          AND (l.shipper_rated IS NULL OR l.shipper_rated = false)
        ORDER BY l.delivered_at DESC
        LIMIT 10
      `, [req.user.id]);

      res.json({
        pendingRatings: result.rows.map(row => ({
          loadId: row.id,
          pickupCity: row.pickup_city,
          pickupState: row.pickup_state,
          deliveryCity: row.delivery_city,
          deliveryState: row.delivery_state,
          driverPayout: parseFloat(row.driver_payout) || 0,
          deliveredAt: row.delivered_at,
          shipperId: row.shipper_id,
          shipperName: row.shipper_name || 'Unknown Shipper',
        })),
      });
    } catch (error) {
      console.error('[Ratings] Pending fetch error:', error);
      res.status(500).json({ error: 'Failed to fetch pending ratings' });
    }
  }
);

/**
 * GET /ratings/shipper/:shipperId
 * Get ratings for a specific shipper (public)
 */
router.get('/shipper/:shipperId',
  authenticate,
  async (req, res) => {
    try {
      const { shipperId } = req.params;

      // Get shipper info with rating
      const shipperResult = await pool.query(`
        SELECT 
          id, 
          company_name,
          shipper_rating,
          shipper_rating_count
        FROM users 
        WHERE id = $1 AND user_type = 'shipper'
      `, [shipperId]);

      if (shipperResult.rows.length === 0) {
        return res.status(404).json({ error: 'Shipper not found' });
      }

      // Get recent ratings
      const ratingsResult = await pool.query(`
        SELECT 
          sr.rating,
          sr.comment,
          sr.tags,
          sr.created_at,
          l.pickup_city,
          l.delivery_city
        FROM shipper_ratings sr
        JOIN loads l ON sr.load_id = l.id
        WHERE sr.shipper_id = $1
        ORDER BY sr.created_at DESC
        LIMIT 20
      `, [shipperId]);

      const shipper = shipperResult.rows[0];

      res.json({
        shipper: {
          id: shipper.id,
          companyName: shipper.company_name,
          rating: parseFloat(shipper.shipper_rating) || 0,
          ratingCount: parseInt(shipper.shipper_rating_count) || 0,
        },
        ratings: ratingsResult.rows.map(r => ({
          rating: r.rating,
          comment: r.comment,
          tags: r.tags,
          createdAt: r.created_at,
          route: `${r.pickup_city} → ${r.delivery_city}`,
        })),
      });
    } catch (error) {
      console.error('[Ratings] Shipper ratings fetch error:', error);
      res.status(500).json({ error: 'Failed to fetch shipper ratings' });
    }
  }
);

/**
 * GET /ratings/my-ratings
 * Get ratings submitted by the current driver
 */
router.get('/my-ratings',
  authenticate,
  requireUserType('driver'),
  async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT 
          sr.*,
          l.pickup_city,
          l.delivery_city,
          u.company_name as shipper_name
        FROM shipper_ratings sr
        JOIN loads l ON sr.load_id = l.id
        LEFT JOIN users u ON sr.shipper_id = u.id
        WHERE sr.driver_id = $1
        ORDER BY sr.created_at DESC
        LIMIT 50
      `, [req.user.id]);

      res.json({
        ratings: result.rows.map(r => ({
          id: r.id,
          loadId: r.load_id,
          rating: r.rating,
          comment: r.comment,
          tags: r.tags,
          createdAt: r.created_at,
          route: `${r.pickup_city} → ${r.delivery_city}`,
          shipperName: r.shipper_name || 'Unknown',
        })),
      });
    } catch (error) {
      console.error('[Ratings] My ratings fetch error:', error);
      res.status(500).json({ error: 'Failed to fetch your ratings' });
    }
  }
);

module.exports = router;
