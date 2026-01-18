/**
 * Support Routes
 * Handles support tickets and contact requests
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../db/pool');
const { authenticate } = require('../middleware/auth');

/**
 * POST /support/contact
 * Submit a support request / contact form
 */
router.post('/contact',
  authenticate,
  async (req, res) => {
    try {
      const {
        subject,
        message,
        category,     // 'general', 'billing', 'technical', 'dispute', 'feedback'
        priority,     // 'low', 'medium', 'high', 'urgent'
        loadId,       // Optional: related load
        attachments,  // Optional: array of attachment URLs
      } = req.body;

      // Validate required fields
      if (!subject || !message) {
        return res.status(400).json({ error: 'Subject and message are required' });
      }

      const userId = req.user.id;

      // Get user details for the ticket
      const userResult = await pool.query(`
        SELECT
          email, phone, first_name, last_name,
          role, company_name
        FROM users
        WHERE id = $1
      `, [userId]);

      if (userResult.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      const user = userResult.rows[0];

      // Insert support ticket
      const result = await pool.query(`
        INSERT INTO support_tickets (
          user_id,
          subject,
          message,
          category,
          priority,
          load_id,
          attachments,
          user_email,
          user_phone,
          user_name,
          user_role,
          status,
          created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'open', CURRENT_TIMESTAMP)
        RETURNING *
      `, [
        userId,
        subject,
        message,
        category || 'general',
        priority || 'medium',
        loadId || null,
        attachments ? JSON.stringify(attachments) : null,
        user.email,
        user.phone,
        `${user.first_name || ''} ${user.last_name || ''}`.trim() || 'Unknown',
        user.role,
      ]);

      const ticket = result.rows[0];

      res.status(201).json({
        message: 'Support request submitted successfully',
        ticket: {
          id: ticket.id,
          subject: ticket.subject,
          category: ticket.category,
          priority: ticket.priority,
          status: ticket.status,
          createdAt: ticket.created_at,
        },
      });
    } catch (error) {
      console.error('[Support] Contact error:', error);
      res.status(500).json({ error: 'Failed to submit support request' });
    }
  }
);

/**
 * GET /support/tickets
 * Get user's support tickets
 */
router.get('/tickets',
  authenticate,
  async (req, res) => {
    try {
      const { status, limit = 20, offset = 0 } = req.query;

      let statusFilter = '';
      const values = [req.user.id, parseInt(limit), parseInt(offset)];

      if (status) {
        statusFilter = 'AND status = $4';
        values.push(status);
      }

      const result = await pool.query(`
        SELECT
          id, subject, category, priority, status,
          created_at, updated_at, resolved_at
        FROM support_tickets
        WHERE user_id = $1
        ${statusFilter}
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3
      `, values);

      res.json({
        tickets: result.rows.map(t => ({
          id: t.id,
          subject: t.subject,
          category: t.category,
          priority: t.priority,
          status: t.status,
          createdAt: t.created_at,
          updatedAt: t.updated_at,
          resolvedAt: t.resolved_at,
        })),
      });
    } catch (error) {
      console.error('[Support] Get tickets error:', error);
      res.status(500).json({ error: 'Failed to get support tickets' });
    }
  }
);

/**
 * GET /support/tickets/:id
 * Get single support ticket details
 */
router.get('/tickets/:id',
  authenticate,
  async (req, res) => {
    try {
      const { id } = req.params;

      const result = await pool.query(`
        SELECT *
        FROM support_tickets
        WHERE id = $1 AND user_id = $2
      `, [id, req.user.id]);

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Ticket not found' });
      }

      const ticket = result.rows[0];

      res.json({
        ticket: {
          id: ticket.id,
          subject: ticket.subject,
          message: ticket.message,
          category: ticket.category,
          priority: ticket.priority,
          status: ticket.status,
          loadId: ticket.load_id,
          attachments: ticket.attachments ? JSON.parse(ticket.attachments) : [],
          adminResponse: ticket.admin_response,
          createdAt: ticket.created_at,
          updatedAt: ticket.updated_at,
          resolvedAt: ticket.resolved_at,
        },
      });
    } catch (error) {
      console.error('[Support] Get ticket error:', error);
      res.status(500).json({ error: 'Failed to get support ticket' });
    }
  }
);

module.exports = router;
