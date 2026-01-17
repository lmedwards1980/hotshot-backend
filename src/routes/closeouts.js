// Closeout Routes - Complete Load Closeout/POD System
// Supports: Photo POD, Digital Signature, QR Code, No-Documentation, Issue Reporting
const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db/pool');
const { authenticate } = require('../middleware/auth');
let notificationService;
try {
  notificationService = require('../services/notifications');
} catch (e) {
  console.warn('[Closeouts] Notification service not available');
  notificationService = { sendPushNotification: async () => {} };
}

const router = express.Router();

// Try to import S3 service (may not exist yet)
let s3Service;
try {
  s3Service = require('../services/s3Service');
} catch (e) {
  console.warn('[Closeouts] S3 service not available - file uploads will be limited');
  s3Service = null;
}

/**
 * Helper: Get user's primary org and role
 */
const getUserPrimaryOrg = async (userId) => {
  const result = await pool.query(`
    SELECT 
      o.id as org_id,
      o.org_type,
      o.name as org_name,
      m.role,
      m.permissions
    FROM memberships m
    JOIN orgs o ON m.org_id = o.id
    WHERE m.user_id = $1 AND m.is_active = true AND o.is_active = true
    ORDER BY m.is_primary DESC, m.joined_at ASC
    LIMIT 1
  `, [userId]);
  
  return result.rows[0] || null;
};

/**
 * Helper: Generate unique QR token
 */
const generateQRToken = () => {
  return crypto.randomBytes(24).toString('hex');
};

/**
 * Helper: Calculate distance between two GPS points (in meters)
 */
const calculateDistance = (lat1, lng1, lat2, lng2) => {
  const R = 6371e3; // Earth's radius in meters
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lng2 - lng1) * Math.PI / 180;

  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c; // in meters
};

/**
 * Helper: Check if closeout requires review
 */
const checkRequiresReview = (closeout, load) => {
  const reasons = [];
  
  // No documentation always requires review
  if (closeout.closeout_method === 'no_documentation') {
    reasons.push('no_documentation');
  }
  
  // Critical issues require review
  if (closeout.issue_severity === 'critical') {
    reasons.push('critical_issue');
  }
  
  // GPS more than 500m from delivery location
  if (closeout.gps_lat && closeout.gps_lng && load.delivery_lat && load.delivery_lng) {
    const distance = calculateDistance(
      parseFloat(closeout.gps_lat),
      parseFloat(closeout.gps_lng),
      parseFloat(load.delivery_lat),
      parseFloat(load.delivery_lng)
    );
    if (distance > 500) {
      reasons.push('gps_mismatch');
    }
  }
  
  // High-value loads (over $5000)
  if (parseFloat(load.price) > 5000) {
    reasons.push('high_value');
  }
  
  // After-hours (before 6am or after 10pm)
  const hour = new Date().getHours();
  if (hour < 6 || hour >= 22) {
    reasons.push('after_hours');
  }
  
  return {
    requiresReview: reasons.length > 0,
    reasons
  };
};

/**
 * Helper: Format closeout response
 */
const formatCloseoutResponse = (closeout, detailed = false) => {
  const response = {
    id: closeout.id,
    loadId: closeout.load_id,
    assignmentId: closeout.assignment_id,
    status: closeout.status,
    closeoutMethod: closeout.closeout_method,
    confirmationNumber: closeout.confirmation_number,
    
    // Recipient info
    recipientName: closeout.recipient_name,
    recipientTitle: closeout.recipient_title,
    
    // Issue info (if any)
    hasExceptions: closeout.has_exceptions,
    issueType: closeout.issue_type,
    issueSeverity: closeout.issue_severity,
    
    // Review status
    requiresReview: closeout.requires_review,
    reviewStatus: closeout.review_status,
    
    // Timestamps
    deliveredAt: closeout.delivered_at,
    podReceivedAt: closeout.pod_received_at,
    createdAt: closeout.created_at,
  };
  
  if (detailed) {
    Object.assign(response, {
      recipientPhone: closeout.recipient_phone,
      recipientEmail: closeout.recipient_email,
      recipientNotes: closeout.recipient_notes,
      
      // Documentation
      photoUrls: closeout.photo_urls,
      signatureUrl: closeout.signature_url,
      locationPhotos: closeout.location_photos,
      damagePhotoUrls: closeout.damage_photo_urls,
      
      // No-doc details
      noDocReason: closeout.no_doc_reason,
      noDocExplanation: closeout.no_doc_explanation,
      
      // Issue details
      issueDescription: closeout.issue_description,
      damageAcknowledgedByRecipient: closeout.damage_acknowledged_by_recipient,
      
      // GPS/Location
      gpsLat: closeout.gps_lat ? parseFloat(closeout.gps_lat) : null,
      gpsLng: closeout.gps_lng ? parseFloat(closeout.gps_lng) : null,
      gpsAccuracy: closeout.gps_accuracy ? parseFloat(closeout.gps_accuracy) : null,
      
      // QR code info
      qrToken: closeout.qr_token,
      qrExpiresAt: closeout.qr_expires_at,
      qrCompletedAt: closeout.qr_completed_at,
      
      // Payment
      finalCarrierPay: closeout.final_carrier_pay ? parseFloat(closeout.final_carrier_pay) : null,
      adjustments: closeout.adjustments,
      
      // Review
      reviewedBy: closeout.reviewed_by,
      reviewedAt: closeout.reviewed_at,
      reviewNotes: closeout.review_notes,
      
      // Notifications
      shipperNotifiedAt: closeout.shipper_notified_at,
      paidAt: closeout.paid_at,
    });
  }
  
  return response;
};

// ============================================
// ROUTES
// ============================================

/**
 * POST /closeouts
 * Create a new closeout (driver initiates closeout process)
 */
router.post('/', authenticate, async (req, res) => {
  try {
    const {
      loadId,
      assignmentId,
      closeoutMethod, // 'photo', 'signature', 'qr_code', 'no_documentation', 'with_issues'
      gps, // { lat, lng, accuracy }
      deviceTimestamp,
    } = req.body;
    
    if (!loadId) {
      return res.status(400).json({ error: 'Load ID is required' });
    }
    
    if (!closeoutMethod) {
      return res.status(400).json({ error: 'Closeout method is required' });
    }
    
    const validMethods = ['photo', 'signature', 'qr_code', 'no_documentation', 'with_issues'];
    if (!validMethods.includes(closeoutMethod)) {
      return res.status(400).json({ error: 'Invalid closeout method' });
    }
    
    // Verify load exists and is in a valid state for closeout
    const loadResult = await pool.query(`
      SELECT l.*, 
        a.id as assignment_id,
        a.driver_user_id,
        a.carrier_org_id,
        a.carrier_pay
      FROM loads l
      LEFT JOIN assignments a ON l.id = a.load_id AND a.status IN ('confirmed', 'in_progress')
      WHERE l.id = $1
    `, [loadId]);
    
    if (loadResult.rows.length === 0) {
      return res.status(404).json({ error: 'Load not found' });
    }
    
    const load = loadResult.rows[0];
    
    // Check driver has access (either direct driver_id or via assignment)
    const userOrg = await getUserPrimaryOrg(req.user.id);
    const isDriver = load.driver_id === req.user.id || load.driver_user_id === req.user.id;
    const isCarrierMember = userOrg?.org_type === 'carrier' && 
                           (load.carrier_org_id === userOrg.org_id || load.assigned_carrier_org_id === userOrg.org_id);
    
    if (!isDriver && !isCarrierMember) {
      return res.status(403).json({ error: 'Not authorized to close out this load' });
    }
    
    // Check load is in valid status for closeout
    const validStatuses = ['en_route_delivery', 'at_delivery', 'delivered', 'in_transit', 'picked_up'];
    if (!validStatuses.includes(load.status)) {
      return res.status(400).json({ 
        error: 'Load is not in a valid status for closeout',
        currentStatus: load.status,
        validStatuses 
      });
    }
    
    // Check if closeout already exists for this load
    const existingCloseout = await pool.query(
      'SELECT * FROM closeouts WHERE load_id = $1 AND status NOT IN ($2, $3)',
      [loadId, 'rejected', 'cancelled']
    );
    
    if (existingCloseout.rows.length > 0) {
      const existing = existingCloseout.rows[0];
      // Return existing closeout if not completed
      if (existing.status !== 'completed' && existing.status !== 'paid') {
        return res.json({
          message: 'Closeout already in progress',
          closeout: formatCloseoutResponse(existing, true),
        });
      }
      return res.status(409).json({ 
        error: 'Load already closed out',
        confirmationNumber: existing.confirmation_number
      });
    }
    
    // Determine initial status based on method
    let initialStatus = 'pending';
    if (closeoutMethod === 'photo') initialStatus = 'pending_photo';
    else if (closeoutMethod === 'signature') initialStatus = 'pending_signature';
    else if (closeoutMethod === 'qr_code') initialStatus = 'pending_qr';
    
    // Create closeout record
    const result = await pool.query(`
      INSERT INTO closeouts (
        load_id, assignment_id, closeout_method, status,
        gps_lat, gps_lng, gps_accuracy,
        device_timestamp, server_timestamp,
        delivered_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      RETURNING *
    `, [
      loadId,
      assignmentId || load.assignment_id || null,
      closeoutMethod,
      initialStatus,
      gps?.lat || null,
      gps?.lng || null,
      gps?.accuracy || null,
      deviceTimestamp || null,
    ]);
    
    const closeout = result.rows[0];
    
    // Generate pre-signed upload URL if photo method
    let uploadUrl = null;
    if (closeoutMethod === 'photo' && s3Service) {
      try {
        uploadUrl = await s3Service.getPresignedUploadUrl(
          `closeouts/${closeout.id}/pod-${Date.now()}.jpg`,
          'image/jpeg'
        );
      } catch (e) {
        console.error('[Closeouts] Failed to generate upload URL:', e);
      }
    }
    
    res.status(201).json({
      message: 'Closeout initiated',
      closeout: formatCloseoutResponse(closeout, true),
      uploadUrl,
      nextStep: getNextStepMessage(closeoutMethod),
    });
  } catch (error) {
    console.error('[Closeouts] Create error:', error);
    res.status(500).json({ error: 'Failed to create closeout', details: error.message });
  }
});

/**
 * Helper: Get next step message based on method
 */
function getNextStepMessage(method) {
  const messages = {
    photo: 'Upload photo(s) of signed POD using POST /closeouts/:id/photo',
    signature: 'Capture signature using POST /closeouts/:id/signature',
    qr_code: 'Generate QR code using POST /closeouts/:id/generate-qr',
    no_documentation: 'Submit no-doc details using POST /closeouts/:id/no-doc',
    with_issues: 'Report issue using POST /closeouts/:id/issue',
  };
  return messages[method] || 'Complete closeout process';
}

/**
 * GET /closeouts/:id
 * Get closeout details
 */
router.get('/:id', authenticate, async (req, res) => {
  try {
    const closeoutId = req.params.id;
    
    const result = await pool.query(`
      SELECT c.*, 
        l.pickup_city, l.pickup_state, l.delivery_city, l.delivery_state,
        l.price, l.carrier_pay, l.driver_payout,
        l.shipper_id, l.posted_by_org_id,
        CONCAT(driver.first_name, ' ', driver.last_name) as driver_name
      FROM closeouts c
      JOIN loads l ON c.load_id = l.id
      LEFT JOIN users driver ON l.driver_id = driver.id
      WHERE c.id = $1
    `, [closeoutId]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Closeout not found' });
    }
    
    const closeout = result.rows[0];
    
    // Check access (driver, shipper, or admin)
    const userOrg = await getUserPrimaryOrg(req.user.id);
    const isShipper = closeout.shipper_id === req.user.id || closeout.posted_by_org_id === userOrg?.org_id;
    const isDriver = closeout.driver_user_id === req.user.id;
    const isAdmin = req.user.role === 'admin';
    
    // For now, allow access (in production, add proper access checks)
    
    // Get attachments
    const attachments = await pool.query(
      'SELECT * FROM closeout_attachments WHERE closeout_id = $1 ORDER BY created_at',
      [closeoutId]
    );
    
    res.json({
      closeout: formatCloseoutResponse(closeout, true),
      attachments: attachments.rows.map(a => ({
        id: a.id,
        type: a.attachment_type,
        url: a.file_url,
        fileName: a.file_name,
        capturedAt: a.captured_at,
      })),
      load: {
        pickupCity: closeout.pickup_city,
        pickupState: closeout.pickup_state,
        deliveryCity: closeout.delivery_city,
        deliveryState: closeout.delivery_state,
        price: parseFloat(closeout.price),
        driverPayout: parseFloat(closeout.driver_payout),
      },
    });
  } catch (error) {
    console.error('[Closeouts] Get error:', error);
    res.status(500).json({ error: 'Failed to get closeout' });
  }
});

/**
 * GET /closeouts/load/:loadId
 * Get closeout by load ID
 */
router.get('/load/:loadId', authenticate, async (req, res) => {
  try {
    const loadId = req.params.loadId;
    
    const result = await pool.query(`
      SELECT c.*, 
        l.pickup_city, l.pickup_state, l.delivery_city, l.delivery_state,
        l.price, l.driver_payout
      FROM closeouts c
      JOIN loads l ON c.load_id = l.id
      WHERE c.load_id = $1
      ORDER BY c.created_at DESC
      LIMIT 1
    `, [loadId]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No closeout found for this load' });
    }
    
    res.json({
      closeout: formatCloseoutResponse(result.rows[0], true),
    });
  } catch (error) {
    console.error('[Closeouts] Get by load error:', error);
    res.status(500).json({ error: 'Failed to get closeout' });
  }
});

/**
 * POST /closeouts/:id/photo
 * Upload POD photo(s)
 */
router.post('/:id/photo', authenticate, async (req, res) => {
  try {
    const closeoutId = req.params.id;
    const {
      photoUrl,  // URL of uploaded photo (from pre-signed upload)
      photoUrls, // Array of URLs (for multiple photos)
      recipientName,
      recipientTitle,
      recipientPhone,
      recipientEmail,
      notes,
      gps,
    } = req.body;
    
    // Get closeout
    const closeoutResult = await pool.query(
      'SELECT * FROM closeouts WHERE id = $1',
      [closeoutId]
    );
    
    if (closeoutResult.rows.length === 0) {
      return res.status(404).json({ error: 'Closeout not found' });
    }
    
    const closeout = closeoutResult.rows[0];
    
    if (closeout.status === 'completed' || closeout.status === 'paid') {
      return res.status(400).json({ error: 'Closeout already completed' });
    }
    
    // Validate at least one photo
    const allPhotos = photoUrls || (photoUrl ? [photoUrl] : []);
    if (allPhotos.length === 0) {
      return res.status(400).json({ error: 'At least one photo is required' });
    }
    
    // Validate recipient name
    if (!recipientName || recipientName.length < 2) {
      return res.status(400).json({ error: 'Recipient name is required' });
    }
    
    // Get load for review check
    const loadResult = await pool.query('SELECT * FROM loads WHERE id = $1', [closeout.load_id]);
    const load = loadResult.rows[0];
    
    // Check if review is required
    const reviewCheck = checkRequiresReview({
      ...closeout,
      gps_lat: gps?.lat,
      gps_lng: gps?.lng,
    }, load);
    
    // Update closeout
    const updateResult = await pool.query(`
      UPDATE closeouts SET
        photo_urls = $1,
        recipient_name = $2,
        recipient_title = $3,
        recipient_phone = $4,
        recipient_email = $5,
        recipient_notes = $6,
        gps_lat = COALESCE($7, gps_lat),
        gps_lng = COALESCE($8, gps_lng),
        gps_accuracy = COALESCE($9, gps_accuracy),
        status = $10,
        requires_review = $11,
        pod_received_at = CURRENT_TIMESTAMP,
        signed_by = $2
      WHERE id = $12
      RETURNING *
    `, [
      allPhotos,
      recipientName,
      recipientTitle || null,
      recipientPhone || null,
      recipientEmail || null,
      notes || null,
      gps?.lat || null,
      gps?.lng || null,
      gps?.accuracy || null,
      reviewCheck.requiresReview ? 'under_review' : 'completed',
      reviewCheck.requiresReview,
      closeoutId,
    ]);
    
    const updatedCloseout = updateResult.rows[0];
    
    // Insert attachments
    for (const url of allPhotos) {
      await pool.query(`
        INSERT INTO closeout_attachments (
          closeout_id, attachment_type, file_url, 
          captured_lat, captured_lng, captured_at, created_by
        ) VALUES ($1, 'pod_photo', $2, $3, $4, CURRENT_TIMESTAMP, $5)
      `, [closeoutId, url, gps?.lat, gps?.lng, req.user.id]);
    }
    
    // Complete the load if closeout is complete
    if (!reviewCheck.requiresReview) {
      await completeLoad(closeout.load_id, updatedCloseout);
    }
    
    // Notify shipper
    notifyShipper(closeout.load_id, updatedCloseout).catch(err => 
      console.error('[Closeouts] Shipper notification error:', err)
    );
    
    res.json({
      message: reviewCheck.requiresReview ? 'POD submitted - pending review' : 'Closeout completed',
      closeout: formatCloseoutResponse(updatedCloseout, true),
      requiresReview: reviewCheck.requiresReview,
      reviewReasons: reviewCheck.reasons,
    });
  } catch (error) {
    console.error('[Closeouts] Photo upload error:', error);
    res.status(500).json({ error: 'Failed to upload photo' });
  }
});

/**
 * POST /closeouts/:id/signature
 * Submit digital signature
 */
router.post('/:id/signature', authenticate, async (req, res) => {
  try {
    const closeoutId = req.params.id;
    const {
      signatureData, // Base64 encoded signature image
      recipientName,
      recipientTitle,
      recipientPhone,
      recipientEmail,
      notes,
      gps,
    } = req.body;
    
    // Get closeout
    const closeoutResult = await pool.query(
      'SELECT * FROM closeouts WHERE id = $1',
      [closeoutId]
    );
    
    if (closeoutResult.rows.length === 0) {
      return res.status(404).json({ error: 'Closeout not found' });
    }
    
    const closeout = closeoutResult.rows[0];
    
    if (closeout.status === 'completed' || closeout.status === 'paid') {
      return res.status(400).json({ error: 'Closeout already completed' });
    }
    
    // Validate signature
    if (!signatureData || !signatureData.startsWith('data:image')) {
      return res.status(400).json({ error: 'Valid signature data is required' });
    }
    
    // Validate recipient name
    if (!recipientName || recipientName.length < 2) {
      return res.status(400).json({ error: 'Recipient name is required' });
    }
    
    // Upload signature to S3 (or store base64)
    let signatureUrl = null;
    if (s3Service) {
      try {
        // Convert base64 to buffer
        const base64Data = signatureData.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');
        
        // Upload to S3
        signatureUrl = await s3Service.uploadBuffer(
          buffer,
          `closeouts/${closeoutId}/signature-${Date.now()}.png`,
          'image/png'
        );
      } catch (e) {
        console.error('[Closeouts] Signature upload error:', e);
        // Fall back to storing base64
      }
    }
    
    // Get load for review check
    const loadResult = await pool.query('SELECT * FROM loads WHERE id = $1', [closeout.load_id]);
    const load = loadResult.rows[0];
    
    // Check if review is required
    const reviewCheck = checkRequiresReview({
      ...closeout,
      gps_lat: gps?.lat,
      gps_lng: gps?.lng,
    }, load);
    
    // Update closeout
    const updateResult = await pool.query(`
      UPDATE closeouts SET
        signature_url = $1,
        signature_data = $2,
        recipient_name = $3,
        recipient_title = $4,
        recipient_phone = $5,
        recipient_email = $6,
        recipient_notes = $7,
        gps_lat = COALESCE($8, gps_lat),
        gps_lng = COALESCE($9, gps_lng),
        gps_accuracy = COALESCE($10, gps_accuracy),
        status = $11,
        requires_review = $12,
        pod_received_at = CURRENT_TIMESTAMP,
        signed_by = $3
      WHERE id = $13
      RETURNING *
    `, [
      signatureUrl,
      signatureUrl ? null : signatureData, // Only store base64 if no S3 URL
      recipientName,
      recipientTitle || null,
      recipientPhone || null,
      recipientEmail || null,
      notes || null,
      gps?.lat || null,
      gps?.lng || null,
      gps?.accuracy || null,
      reviewCheck.requiresReview ? 'under_review' : 'completed',
      reviewCheck.requiresReview,
      closeoutId,
    ]);
    
    const updatedCloseout = updateResult.rows[0];
    
    // Insert attachment record
    await pool.query(`
      INSERT INTO closeout_attachments (
        closeout_id, attachment_type, file_url, 
        captured_lat, captured_lng, captured_at, created_by
      ) VALUES ($1, 'signature', $2, $3, $4, CURRENT_TIMESTAMP, $5)
    `, [closeoutId, signatureUrl || 'base64_stored', gps?.lat, gps?.lng, req.user.id]);
    
    // Complete the load if closeout is complete
    if (!reviewCheck.requiresReview) {
      await completeLoad(closeout.load_id, updatedCloseout);
    }
    
    // Notify shipper
    notifyShipper(closeout.load_id, updatedCloseout).catch(err => 
      console.error('[Closeouts] Shipper notification error:', err)
    );
    
    res.json({
      message: reviewCheck.requiresReview ? 'Signature submitted - pending review' : 'Closeout completed',
      closeout: formatCloseoutResponse(updatedCloseout, true),
      signatureUrl,
      requiresReview: reviewCheck.requiresReview,
    });
  } catch (error) {
    console.error('[Closeouts] Signature error:', error);
    res.status(500).json({ error: 'Failed to submit signature' });
  }
});

/**
 * POST /closeouts/:id/generate-qr
 * Generate QR code for recipient to scan
 */
router.post('/:id/generate-qr', authenticate, async (req, res) => {
  try {
    const closeoutId = req.params.id;
    
    // Get closeout
    const closeoutResult = await pool.query(
      'SELECT * FROM closeouts WHERE id = $1',
      [closeoutId]
    );
    
    if (closeoutResult.rows.length === 0) {
      return res.status(404).json({ error: 'Closeout not found' });
    }
    
    const closeout = closeoutResult.rows[0];
    
    if (closeout.status === 'completed' || closeout.status === 'paid') {
      return res.status(400).json({ error: 'Closeout already completed' });
    }
    
    // Check if QR already exists and is valid
    if (closeout.qr_token && closeout.qr_expires_at && new Date(closeout.qr_expires_at) > new Date()) {
      // Return existing QR
      const qrUrl = `${process.env.APP_URL || 'https://hotshot.app'}/pod/${closeout.qr_token}`;
      return res.json({
        message: 'Existing QR code returned',
        qrCode: {
          token: closeout.qr_token,
          url: qrUrl,
          qrImageUrl: `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qrUrl)}`,
          expiresAt: closeout.qr_expires_at,
        },
      });
    }
    
    // Generate new QR token
    const qrToken = generateQRToken();
    const expiresAt = new Date(Date.now() + 4 * 60 * 60 * 1000); // 4 hours from now
    
    // Update closeout with QR token
    const updateResult = await pool.query(`
      UPDATE closeouts SET
        qr_token = $1,
        qr_generated_at = CURRENT_TIMESTAMP,
        qr_expires_at = $2,
        status = 'pending_qr'
      WHERE id = $3
      RETURNING *
    `, [qrToken, expiresAt, closeoutId]);
    
    const qrUrl = `${process.env.APP_URL || 'https://hotshot.app'}/pod/${qrToken}`;
    
    res.json({
      message: 'QR code generated',
      qrCode: {
        token: qrToken,
        url: qrUrl,
        qrImageUrl: `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qrUrl)}`,
        expiresAt: expiresAt.toISOString(),
      },
      closeout: formatCloseoutResponse(updateResult.rows[0]),
    });
  } catch (error) {
    console.error('[Closeouts] Generate QR error:', error);
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
});

/**
 * GET /closeouts/qr/:token
 * PUBLIC: Get delivery info for QR code scan (no auth required)
 */
router.get('/qr/:token', async (req, res) => {
  try {
    const token = req.params.token;
    
    // Find closeout by token
    const result = await pool.query(`
      SELECT c.*, 
        l.pickup_city, l.pickup_state,
        l.delivery_address, l.delivery_city, l.delivery_state,
        l.description, l.weight_lbs, l.pieces,
        CONCAT(driver.first_name, ' ', LEFT(driver.last_name, 1), '.') as driver_name,
        driver.phone as driver_phone,
        COALESCE(shipper_org.name, CONCAT(shipper.first_name, ' ', shipper.last_name)) as shipper_name
      FROM closeouts c
      JOIN loads l ON c.load_id = l.id
      LEFT JOIN users driver ON l.driver_id = driver.id
      LEFT JOIN users shipper ON l.shipper_id = shipper.id
      LEFT JOIN orgs shipper_org ON l.posted_by_org_id = shipper_org.id
      WHERE c.qr_token = $1
    `, [token]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Invalid or expired QR code' });
    }
    
    const closeout = result.rows[0];
    
    // Check if expired
    if (closeout.qr_expires_at && new Date(closeout.qr_expires_at) < new Date()) {
      return res.status(410).json({ error: 'QR code has expired' });
    }
    
    // Check if already completed
    if (closeout.qr_completed_at) {
      return res.status(410).json({ 
        error: 'Delivery already confirmed',
        confirmationNumber: closeout.confirmation_number
      });
    }
    
    res.json({
      success: true,
      delivery: {
        loadId: closeout.load_id,
        shipperName: closeout.shipper_name,
        pickupCity: closeout.pickup_city,
        pickupState: closeout.pickup_state,
        deliveryAddress: closeout.delivery_address,
        deliveryCity: closeout.delivery_city,
        deliveryState: closeout.delivery_state,
        driverName: closeout.driver_name,
        driverPhone: closeout.driver_phone,
        itemsDelivered: closeout.description,
        weightLbs: closeout.weight_lbs,
        pieces: closeout.pieces,
        requiresSignature: true,
      },
    });
  } catch (error) {
    console.error('[Closeouts] QR lookup error:', error);
    res.status(500).json({ error: 'Failed to look up delivery' });
  }
});

/**
 * POST /closeouts/qr/:token
 * PUBLIC: Complete closeout via QR code (no auth required)
 */
router.post('/qr/:token', async (req, res) => {
  try {
    const token = req.params.token;
    const {
      recipientName,
      recipientTitle,
      recipientEmail,
      signatureData,
      notes,
      conditionConfirmed, // boolean - all items received in good condition
      deviceInfo,
    } = req.body;
    
    // Find closeout
    const closeoutResult = await pool.query(`
      SELECT c.*, l.id as load_id, l.price, l.delivery_lat, l.delivery_lng
      FROM closeouts c
      JOIN loads l ON c.load_id = l.id
      WHERE c.qr_token = $1
    `, [token]);
    
    if (closeoutResult.rows.length === 0) {
      return res.status(404).json({ error: 'Invalid or expired QR code' });
    }
    
    const closeout = closeoutResult.rows[0];
    
    // Check if expired
    if (closeout.qr_expires_at && new Date(closeout.qr_expires_at) < new Date()) {
      return res.status(410).json({ error: 'QR code has expired' });
    }
    
    // Check if already completed
    if (closeout.qr_completed_at) {
      return res.status(410).json({ 
        error: 'Delivery already confirmed',
        confirmationNumber: closeout.confirmation_number
      });
    }
    
    // Validate required fields
    if (!recipientName || recipientName.length < 2) {
      return res.status(400).json({ error: 'Recipient name is required' });
    }
    
    if (!signatureData || !signatureData.startsWith('data:image')) {
      return res.status(400).json({ error: 'Signature is required' });
    }
    
    // Upload signature to S3 (or store base64)
    let signatureUrl = null;
    if (s3Service) {
      try {
        const base64Data = signatureData.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');
        signatureUrl = await s3Service.uploadBuffer(
          buffer,
          `closeouts/${closeout.id}/qr-signature-${Date.now()}.png`,
          'image/png'
        );
      } catch (e) {
        console.error('[Closeouts] QR signature upload error:', e);
      }
    }
    
    // Get client IP
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    
    // Update closeout
    const updateResult = await pool.query(`
      UPDATE closeouts SET
        signature_url = $1,
        signature_data = $2,
        recipient_name = $3,
        recipient_title = $4,
        recipient_email = $5,
        recipient_notes = $6,
        qr_completed_at = CURRENT_TIMESTAMP,
        qr_completed_by_ip = $7,
        qr_device_info = $8,
        status = 'completed',
        pod_received_at = CURRENT_TIMESTAMP,
        signed_by = $3
      WHERE id = $9
      RETURNING *
    `, [
      signatureUrl,
      signatureUrl ? null : signatureData,
      recipientName,
      recipientTitle || null,
      recipientEmail || null,
      notes || null,
      clientIp,
      deviceInfo || null,
      closeout.id,
    ]);
    
    const updatedCloseout = updateResult.rows[0];
    
    // Complete the load
    await completeLoad(closeout.load_id, updatedCloseout);
    
    // Notify driver that QR was completed
    notifyDriverQRComplete(closeout.load_id, updatedCloseout).catch(err =>
      console.error('[Closeouts] Driver notification error:', err)
    );
    
    // Notify shipper
    notifyShipper(closeout.load_id, updatedCloseout).catch(err =>
      console.error('[Closeouts] Shipper notification error:', err)
    );
    
    // Send confirmation email if provided
    if (recipientEmail) {
      sendConfirmationEmail(recipientEmail, updatedCloseout).catch(err =>
        console.error('[Closeouts] Email error:', err)
      );
    }
    
    res.json({
      success: true,
      message: 'Delivery confirmed. Thank you!',
      confirmationNumber: updatedCloseout.confirmation_number,
    });
  } catch (error) {
    console.error('[Closeouts] QR complete error:', error);
    res.status(500).json({ error: 'Failed to confirm delivery' });
  }
});

/**
 * POST /closeouts/:id/no-doc
 * Close without documentation
 */
router.post('/:id/no-doc', authenticate, async (req, res) => {
  try {
    const closeoutId = req.params.id;
    const {
      reason, // 'unattended', 'refused_signature', 'after_hours', etc.
      explanation,
      locationPhotos, // Array of photo URLs
      gps,
    } = req.body;
    
    // Get closeout
    const closeoutResult = await pool.query(
      'SELECT * FROM closeouts WHERE id = $1',
      [closeoutId]
    );
    
    if (closeoutResult.rows.length === 0) {
      return res.status(404).json({ error: 'Closeout not found' });
    }
    
    const closeout = closeoutResult.rows[0];
    
    if (closeout.status === 'completed' || closeout.status === 'paid') {
      return res.status(400).json({ error: 'Closeout already completed' });
    }
    
    // Validate reason
    const validReasons = ['unattended', 'refused_signature', 'after_hours', 'no_office_staff', 'construction_site', 'emergency', 'other'];
    if (!reason || !validReasons.includes(reason)) {
      return res.status(400).json({ error: 'Valid reason is required', validReasons });
    }
    
    // Validate explanation
    if (!explanation || explanation.length < 20) {
      return res.status(400).json({ error: 'Explanation must be at least 20 characters' });
    }
    
    // Validate location photos (minimum 2)
    if (!locationPhotos || locationPhotos.length < 2) {
      return res.status(400).json({ error: 'At least 2 location photos are required' });
    }
    
    // Get load info
    const loadResult = await pool.query('SELECT * FROM loads WHERE id = $1', [closeout.load_id]);
    const load = loadResult.rows[0];
    
    // Update closeout - always requires review for no-doc
    const updateResult = await pool.query(`
      UPDATE closeouts SET
        closeout_method = 'no_documentation',
        no_doc_reason = $1,
        no_doc_explanation = $2,
        location_photos = $3,
        gps_lat = COALESCE($4, gps_lat),
        gps_lng = COALESCE($5, gps_lng),
        gps_accuracy = COALESCE($6, gps_accuracy),
        status = 'under_review',
        requires_review = true,
        pod_received_at = CURRENT_TIMESTAMP
      WHERE id = $7
      RETURNING *
    `, [
      reason,
      explanation,
      locationPhotos,
      gps?.lat || null,
      gps?.lng || null,
      gps?.accuracy || null,
      closeoutId,
    ]);
    
    const updatedCloseout = updateResult.rows[0];
    
    // Insert location photo attachments
    for (const url of locationPhotos) {
      await pool.query(`
        INSERT INTO closeout_attachments (
          closeout_id, attachment_type, file_url,
          captured_lat, captured_lng, captured_at, created_by
        ) VALUES ($1, 'location_photo', $2, $3, $4, CURRENT_TIMESTAMP, $5)
      `, [closeoutId, url, gps?.lat, gps?.lng, req.user.id]);
    }
    
    // Immediately notify shipper about no-doc closeout
    await notifyShipperNoDocs(closeout.load_id, updatedCloseout, load);
    
    res.json({
      message: 'No-documentation closeout submitted for review',
      closeout: formatCloseoutResponse(updatedCloseout, true),
      requiresReview: true,
      shipperNotified: true,
    });
  } catch (error) {
    console.error('[Closeouts] No-doc error:', error);
    res.status(500).json({ error: 'Failed to submit no-doc closeout' });
  }
});

/**
 * POST /closeouts/:id/issue
 * Report issue/damage
 */
router.post('/:id/issue', authenticate, async (req, res) => {
  try {
    const closeoutId = req.params.id;
    const {
      issueType, // 'damage', 'shortage', 'refused', 'wrong_items', 'late_delivery', 'access_issues', 'other'
      issueSeverity, // 'minor', 'major', 'critical'
      description,
      damagePhotos, // Array of photo URLs
      acknowledgedByRecipient,
    } = req.body;
    
    // Get closeout
    const closeoutResult = await pool.query(
      'SELECT * FROM closeouts WHERE id = $1',
      [closeoutId]
    );
    
    if (closeoutResult.rows.length === 0) {
      return res.status(404).json({ error: 'Closeout not found' });
    }
    
    const closeout = closeoutResult.rows[0];
    
    // Validate issue type
    const validTypes = ['damage', 'shortage', 'refused', 'wrong_items', 'late_delivery', 'access_issues', 'other'];
    if (!issueType || !validTypes.includes(issueType)) {
      return res.status(400).json({ error: 'Valid issue type is required', validTypes });
    }
    
    // Validate severity
    const validSeverities = ['minor', 'major', 'critical'];
    if (!issueSeverity || !validSeverities.includes(issueSeverity)) {
      return res.status(400).json({ error: 'Valid severity is required', validSeverities });
    }
    
    // Validate description
    if (!description || description.length < 20) {
      return res.status(400).json({ error: 'Description must be at least 20 characters' });
    }
    
    // Validate damage photos for damage claims (minimum 3)
    if (issueType === 'damage' && (!damagePhotos || damagePhotos.length < 3)) {
      return res.status(400).json({ error: 'At least 3 damage photos are required for damage claims' });
    }
    
    // Determine if review is required
    const requiresReview = issueSeverity === 'critical' || issueType === 'refused';
    
    // Update closeout
    const updateResult = await pool.query(`
      UPDATE closeouts SET
        has_exceptions = true,
        issue_type = $1,
        issue_severity = $2,
        issue_description = $3,
        damage_photo_urls = $4,
        damage_acknowledged_by_recipient = $5,
        requires_review = requires_review OR $6
      WHERE id = $7
      RETURNING *
    `, [
      issueType,
      issueSeverity,
      description,
      damagePhotos || null,
      acknowledgedByRecipient || false,
      requiresReview,
      closeoutId,
    ]);
    
    const updatedCloseout = updateResult.rows[0];
    
    // Insert damage photo attachments
    if (damagePhotos) {
      for (const url of damagePhotos) {
        await pool.query(`
          INSERT INTO closeout_attachments (
            closeout_id, attachment_type, file_url, created_by
          ) VALUES ($1, 'damage_photo', $2, $3)
        `, [closeoutId, url, req.user.id]);
      }
    }
    
    // Notify shipper about issue
    notifyShipperIssue(closeout.load_id, updatedCloseout).catch(err =>
      console.error('[Closeouts] Issue notification error:', err)
    );
    
    res.json({
      message: 'Issue documented',
      closeout: formatCloseoutResponse(updatedCloseout, true),
      nextStep: 'Continue with normal closeout process to complete delivery',
      requiresReview,
    });
  } catch (error) {
    console.error('[Closeouts] Issue error:', error);
    res.status(500).json({ error: 'Failed to report issue' });
  }
});

/**
 * POST /closeouts/:id/complete
 * Complete closeout (with or without issues)
 */
router.post('/:id/complete', authenticate, async (req, res) => {
  try {
    const closeoutId = req.params.id;
    const {
      recipientName,
      recipientTitle,
      recipientPhone,
      recipientEmail,
      notes,
      gps,
    } = req.body;
    
    // Get closeout
    const closeoutResult = await pool.query(
      'SELECT * FROM closeouts WHERE id = $1',
      [closeoutId]
    );
    
    if (closeoutResult.rows.length === 0) {
      return res.status(404).json({ error: 'Closeout not found' });
    }
    
    const closeout = closeoutResult.rows[0];
    
    if (closeout.status === 'completed' || closeout.status === 'paid') {
      return res.status(400).json({ 
        error: 'Closeout already completed',
        confirmationNumber: closeout.confirmation_number
      });
    }
    
    // Validate that POD has been provided (photo or signature or QR)
    if (!closeout.photo_urls && !closeout.signature_url && !closeout.qr_completed_at) {
      // Allow completion for no-doc and issues
      if (closeout.closeout_method !== 'no_documentation' && !closeout.has_exceptions) {
        return res.status(400).json({ error: 'POD documentation required before completing' });
      }
    }
    
    // Get load for review check
    const loadResult = await pool.query('SELECT * FROM loads WHERE id = $1', [closeout.load_id]);
    const load = loadResult.rows[0];
    
    // Determine final status
    let finalStatus = 'completed';
    if (closeout.requires_review) {
      finalStatus = 'under_review';
    } else if (closeout.has_exceptions) {
      finalStatus = 'completed_issues';
    } else if (closeout.closeout_method === 'no_documentation') {
      finalStatus = 'completed_no_doc';
    }
    
    // Update closeout
    const updateResult = await pool.query(`
      UPDATE closeouts SET
        recipient_name = COALESCE($1, recipient_name),
        recipient_title = COALESCE($2, recipient_title),
        recipient_phone = COALESCE($3, recipient_phone),
        recipient_email = COALESCE($4, recipient_email),
        recipient_notes = COALESCE($5, recipient_notes),
        gps_lat = COALESCE($6, gps_lat),
        gps_lng = COALESCE($7, gps_lng),
        gps_accuracy = COALESCE($8, gps_accuracy),
        status = $9,
        pod_received_at = COALESCE(pod_received_at, CURRENT_TIMESTAMP),
        final_carrier_pay = $10
      WHERE id = $11
      RETURNING *
    `, [
      recipientName || null,
      recipientTitle || null,
      recipientPhone || null,
      recipientEmail || null,
      notes || null,
      gps?.lat || null,
      gps?.lng || null,
      gps?.accuracy || null,
      finalStatus,
      load.carrier_pay || load.driver_payout,
      closeoutId,
    ]);
    
    const updatedCloseout = updateResult.rows[0];
    
    // Complete load if not requiring review
    if (!closeout.requires_review) {
      await completeLoad(closeout.load_id, updatedCloseout);
    }
    
    // Notify shipper
    notifyShipper(closeout.load_id, updatedCloseout).catch(err =>
      console.error('[Closeouts] Shipper notification error:', err)
    );
    
    res.json({
      message: closeout.requires_review ? 'Closeout submitted for review' : 'Closeout completed',
      closeout: formatCloseoutResponse(updatedCloseout, true),
      requiresReview: closeout.requires_review,
    });
  } catch (error) {
    console.error('[Closeouts] Complete error:', error);
    res.status(500).json({ error: 'Failed to complete closeout' });
  }
});

/**
 * PUT /closeouts/:id/review
 * Admin review closeout (approve/reject)
 */
router.put('/:id/review', authenticate, async (req, res) => {
  try {
    const closeoutId = req.params.id;
    const {
      decision, // 'approved', 'rejected', 'needs_info'
      notes,
      adjustments, // { reason, amount } for payment adjustments
    } = req.body;
    
    // Check admin permission
    const userOrg = await getUserPrimaryOrg(req.user.id);
    const isAdmin = req.user.role === 'admin' || 
                   userOrg?.role === 'shipper_admin' || 
                   userOrg?.role === 'broker_admin';
    
    if (!isAdmin) {
      return res.status(403).json({ error: 'Admin permission required' });
    }
    
    // Get closeout
    const closeoutResult = await pool.query(`
      SELECT c.*, l.shipper_id, l.posted_by_org_id
      FROM closeouts c
      JOIN loads l ON c.load_id = l.id
      WHERE c.id = $1
    `, [closeoutId]);
    
    if (closeoutResult.rows.length === 0) {
      return res.status(404).json({ error: 'Closeout not found' });
    }
    
    const closeout = closeoutResult.rows[0];
    
    // Verify user has access to this closeout's org
    if (closeout.posted_by_org_id !== userOrg?.org_id && closeout.shipper_id !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized to review this closeout' });
    }
    
    // Validate decision
    const validDecisions = ['approved', 'rejected', 'needs_info'];
    if (!decision || !validDecisions.includes(decision)) {
      return res.status(400).json({ error: 'Valid decision is required', validDecisions });
    }
    
    // Determine final status
    let finalStatus = closeout.status;
    if (decision === 'approved') {
      finalStatus = closeout.has_exceptions ? 'completed_issues' : 
                    closeout.closeout_method === 'no_documentation' ? 'completed_no_doc' : 'completed';
    } else if (decision === 'rejected') {
      finalStatus = 'rejected';
    }
    
    // Update closeout
    const updateResult = await pool.query(`
      UPDATE closeouts SET
        review_status = $1,
        status = $2,
        reviewed_by = $3,
        reviewed_at = CURRENT_TIMESTAMP,
        review_notes = $4,
        adjustments = COALESCE($5, adjustments),
        final_carrier_pay = CASE 
          WHEN $5 IS NOT NULL THEN final_carrier_pay + COALESCE(($5->>'amount')::numeric, 0)
          ELSE final_carrier_pay
        END
      WHERE id = $6
      RETURNING *
    `, [
      decision,
      finalStatus,
      req.user.id,
      notes || null,
      adjustments ? JSON.stringify(adjustments) : null,
      closeoutId,
    ]);
    
    const updatedCloseout = updateResult.rows[0];
    
    // If approved, complete the load
    if (decision === 'approved') {
      await completeLoad(closeout.load_id, updatedCloseout);
    }
    
    res.json({
      message: `Closeout ${decision}`,
      closeout: formatCloseoutResponse(updatedCloseout, true),
    });
  } catch (error) {
    console.error('[Closeouts] Review error:', error);
    res.status(500).json({ error: 'Failed to review closeout' });
  }
});

/**
 * GET /closeouts/pending-review
 * Get closeouts requiring review (for admins)
 */
router.get('/pending-review', authenticate, async (req, res) => {
  try {
    const { limit = 20, offset = 0 } = req.query;
    
    // Get user's org
    const userOrg = await getUserPrimaryOrg(req.user.id);
    
    if (!userOrg) {
      return res.status(403).json({ error: 'Org membership required' });
    }
    
    // Get closeouts for user's org that need review
    const result = await pool.query(`
      SELECT c.*, 
        l.pickup_city, l.pickup_state, l.delivery_city, l.delivery_state,
        l.price, l.carrier_pay,
        CONCAT(driver.first_name, ' ', driver.last_name) as driver_name
      FROM closeouts c
      JOIN loads l ON c.load_id = l.id
      LEFT JOIN users driver ON l.driver_id = driver.id
      WHERE l.posted_by_org_id = $1
        AND c.requires_review = true
        AND c.status = 'under_review'
      ORDER BY c.created_at ASC
      LIMIT $2 OFFSET $3
    `, [userOrg.org_id, limit, offset]);
    
    const countResult = await pool.query(`
      SELECT COUNT(*) FROM closeouts c
      JOIN loads l ON c.load_id = l.id
      WHERE l.posted_by_org_id = $1
        AND c.requires_review = true
        AND c.status = 'under_review'
    `, [userOrg.org_id]);
    
    res.json({
      closeouts: result.rows.map(c => ({
        ...formatCloseoutResponse(c),
        driverName: c.driver_name,
        route: `${c.pickup_city}, ${c.pickup_state} → ${c.delivery_city}, ${c.delivery_state}`,
        price: parseFloat(c.price),
      })),
      count: result.rows.length,
      total: parseInt(countResult.rows[0].count),
    });
  } catch (error) {
    console.error('[Closeouts] Pending review error:', error);
    res.status(500).json({ error: 'Failed to get pending reviews' });
  }
});

/**
 * POST /closeouts/:id/upload-url
 * Get pre-signed URL for file upload
 */
router.post('/:id/upload-url', authenticate, async (req, res) => {
  try {
    const closeoutId = req.params.id;
    const { fileType, attachmentType } = req.body; // 'image/jpeg', 'pod_photo' | 'damage_photo' | etc.
    
    if (!s3Service) {
      return res.status(501).json({ error: 'File upload not configured' });
    }
    
    // Verify closeout exists
    const closeoutResult = await pool.query(
      'SELECT * FROM closeouts WHERE id = $1',
      [closeoutId]
    );
    
    if (closeoutResult.rows.length === 0) {
      return res.status(404).json({ error: 'Closeout not found' });
    }
    
    const extension = fileType === 'image/png' ? 'png' : 'jpg';
    const folder = attachmentType || 'pod';
    const key = `closeouts/${closeoutId}/${folder}-${Date.now()}.${extension}`;
    
    const uploadUrl = await s3Service.getPresignedUploadUrl(key, fileType);
    const fileUrl = `https://${process.env.S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
    
    res.json({
      uploadUrl,
      fileUrl,
      key,
      expiresIn: 300, // 5 minutes
    });
  } catch (error) {
    console.error('[Closeouts] Upload URL error:', error);
    res.status(500).json({ error: 'Failed to generate upload URL' });
  }
});

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Complete the load after successful closeout
 */
async function completeLoad(loadId, closeout) {
  try {
    await pool.query(`
      UPDATE loads SET
        status = 'delivered',
        delivered_at = COALESCE(delivered_at, CURRENT_TIMESTAMP),
        completed_at = CURRENT_TIMESTAMP,
        payout_status = 'pending'
      WHERE id = $1
    `, [loadId]);
    
    // Update assignment if exists
    if (closeout.assignment_id) {
      await pool.query(`
        UPDATE assignments SET
          status = 'completed',
          completed_at = CURRENT_TIMESTAMP
        WHERE id = $1
      `, [closeout.assignment_id]);
    }
    
    console.log(`[Closeouts] Load ${loadId} marked as delivered`);
  } catch (error) {
    console.error('[Closeouts] Complete load error:', error);
  }
}

/**
 * Notify shipper about successful closeout
 */
async function notifyShipper(loadId, closeout) {
  try {
    // Get load and shipper info
    const loadResult = await pool.query(`
      SELECT l.*, u.id as shipper_user_id, u.first_name, u.email
      FROM loads l
      JOIN users u ON l.shipper_id = u.id
      WHERE l.id = $1
    `, [loadId]);
    
    if (loadResult.rows.length === 0) return;
    
    const load = loadResult.rows[0];
    
    // Update closeout with notification timestamp
    await pool.query(
      'UPDATE closeouts SET shipper_notified_at = CURRENT_TIMESTAMP WHERE id = $1',
      [closeout.id]
    );
    
    // Send push notification
    await notificationService.sendPushNotification(
      load.shipper_user_id,
      'Delivery Completed',
      `Your shipment to ${load.delivery_city}, ${load.delivery_state} has been delivered. Confirmation: ${closeout.confirmation_number}`,
      { loadId, closeoutId: closeout.id, type: 'delivery_complete' }
    ).catch(err => console.error('[Notify] Push failed:', err));
    
    console.log(`[Closeouts] Shipper ${load.shipper_user_id} notified`);
  } catch (error) {
    console.error('[Closeouts] Notify shipper error:', error);
  }
}

/**
 * Notify shipper about no-documentation closeout (more urgent)
 */
async function notifyShipperNoDocs(loadId, closeout, load) {
  try {
    const shipperResult = await pool.query(
      'SELECT id, first_name, email, phone FROM users WHERE id = $1',
      [load.shipper_id]
    );
    
    if (shipperResult.rows.length === 0) return;
    
    const shipper = shipperResult.rows[0];
    
    // Send urgent push notification
    await notificationService.sendPushNotification(
      shipper.id,
      '⚠️ Delivery Completed Without Signature',
      `Your shipment to ${load.delivery_city} was delivered without normal documentation. Reason: ${closeout.no_doc_reason}. Review required.`,
      { loadId, closeoutId: closeout.id, type: 'no_doc_closeout', urgent: true }
    ).catch(err => console.error('[Notify] Push failed:', err));
    
    // TODO: Send SMS via Twilio for urgent no-doc notifications
    
    console.log(`[Closeouts] Shipper ${shipper.id} notified of no-doc closeout`);
  } catch (error) {
    console.error('[Closeouts] Notify shipper no-doc error:', error);
  }
}

/**
 * Notify shipper about issue reported
 */
async function notifyShipperIssue(loadId, closeout) {
  try {
    const loadResult = await pool.query(`
      SELECT l.*, u.id as shipper_user_id
      FROM loads l
      JOIN users u ON l.shipper_id = u.id
      WHERE l.id = $1
    `, [loadId]);
    
    if (loadResult.rows.length === 0) return;
    
    const load = loadResult.rows[0];
    
    const severityEmoji = {
      minor: 'ℹ️',
      major: '⚠️',
      critical: '🚨'
    };
    
    await notificationService.sendPushNotification(
      load.shipper_user_id,
      `${severityEmoji[closeout.issue_severity] || '⚠️'} Issue Reported - ${closeout.issue_type}`,
      `An issue was reported for your shipment to ${load.delivery_city}. Severity: ${closeout.issue_severity}`,
      { loadId, closeoutId: closeout.id, type: 'issue_reported' }
    ).catch(err => console.error('[Notify] Push failed:', err));
    
    console.log(`[Closeouts] Shipper notified of issue`);
  } catch (error) {
    console.error('[Closeouts] Notify shipper issue error:', error);
  }
}

/**
 * Notify driver that QR closeout was completed
 */
async function notifyDriverQRComplete(loadId, closeout) {
  try {
    const loadResult = await pool.query(
      'SELECT driver_id FROM loads WHERE id = $1',
      [loadId]
    );
    
    if (loadResult.rows.length === 0 || !loadResult.rows[0].driver_id) return;
    
    const driverId = loadResult.rows[0].driver_id;
    
    await notificationService.sendPushNotification(
      driverId,
      '✓ Delivery Confirmed',
      `${closeout.recipient_name} has confirmed receipt of the delivery. Confirmation: ${closeout.confirmation_number}`,
      { loadId, closeoutId: closeout.id, type: 'qr_complete' }
    ).catch(err => console.error('[Notify] Push failed:', err));
    
    console.log(`[Closeouts] Driver ${driverId} notified of QR completion`);
  } catch (error) {
    console.error('[Closeouts] Notify driver QR error:', error);
  }
}

/**
 * Send confirmation email to recipient
 */
async function sendConfirmationEmail(email, closeout) {
  try {
    // TODO: Implement via SendGrid
    console.log(`[Closeouts] Would send confirmation email to ${email} for ${closeout.confirmation_number}`);
  } catch (error) {
    console.error('[Closeouts] Send email error:', error);
  }
}

module.exports = router;
