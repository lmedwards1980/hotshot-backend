// backend_api/src/routes/drivers.js
// Driver routes including availability management

const express = require('express');
const router = express.Router();
const { pool } = require('../db/pool');
const { authenticate } = require('../middleware/auth');

// ============================================
// GET /api/drivers/profile
// Get driver's profile
// ============================================

router.get('/profile', authenticate, async (req, res) => {
  try {
    // Query only absolute minimum columns first
    const userResult = await pool.query(`
      SELECT *
      FROM users
      WHERE id = $1
    `, [req.user.id]);

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Driver not found' });
    }

    const user = userResult.rows[0];

    // Calculate total deliveries from loads table
    let totalDeliveries = 0;
    try {
      const statsResult = await pool.query(`
        SELECT COUNT(*) as total_deliveries
        FROM loads
        WHERE driver_id = $1 AND status = 'delivered'
      `, [req.user.id]);
      totalDeliveries = parseInt(statsResult.rows[0].total_deliveries) || 0;
    } catch (e) {
      console.log('[Drivers] Could not get delivery stats:', e.message);
    }

    // Build driver response with safe defaults
    const driver = {
      id: user.id,
      email: user.email,
      first_name: user.first_name,
      last_name: user.last_name,
      phone: user.phone,
      role: user.role,
      vehicle_type: user.vehicle_type || null,
      license_plate: user.license_plate || null,
      driver_lat: user.driver_lat || null,
      driver_lng: user.driver_lng || null,
      location_updated_at: user.location_updated_at || null,
      is_available: user.is_available || false,
      company_name: user.company_name || null,
      total_deliveries: totalDeliveries,
      rating: user.rating || 5.0,
      rating_count: user.rating_count || 0,
      is_verified: user.is_verified || false,
      profile_image_url: user.profile_image_url || null,
      created_at: user.created_at,
    };

    res.json({ driver });
  } catch (error) {
    console.error('[Drivers] Profile error:', error);
    res.status(500).json({ error: 'Failed to get profile', details: error.message });
  }
});

// ============================================
// PUT /api/drivers/profile
// Update driver's profile
// ============================================

router.put('/profile', authenticate, async (req, res) => {
  try {
    const {
      firstName,
      lastName,
      phone,
      vehicleType,
      licensePlate,
      companyName,
      hasCdl,
      cdlNumber,
      cdlState,
      cdlExpiration,
      insuranceProvider,
      insurancePolicyNumber,
      insuranceExpiration,
      bio,
    } = req.body;

    // Build dynamic update query
    const updates = [];
    const values = [];
    let paramIndex = 1;

    const addUpdate = (field, value) => {
      if (value !== undefined) {
        updates.push(`${field} = $${paramIndex}`);
        values.push(value);
        paramIndex++;
      }
    };

    addUpdate('first_name', firstName);
    addUpdate('last_name', lastName);
    addUpdate('phone', phone);
    addUpdate('vehicle_type', vehicleType);
    addUpdate('license_plate', licensePlate);
    addUpdate('company_name', companyName);
    addUpdate('has_cdl', hasCdl);
    addUpdate('cdl_number', cdlNumber);
    addUpdate('cdl_state', cdlState);
    addUpdate('cdl_expiration', cdlExpiration);
    addUpdate('insurance_provider', insuranceProvider);
    addUpdate('insurance_policy_number', insurancePolicyNumber);
    addUpdate('insurance_expiration', insuranceExpiration);
    addUpdate('bio', bio);

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    updates.push('updated_at = NOW()');
    values.push(req.user.id);

    const result = await pool.query(`
      UPDATE users
      SET ${updates.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING
        id, email, phone, first_name, last_name,
        vehicle_type, license_plate, company_name,
        has_cdl, cdl_number, cdl_state, cdl_expiration,
        insurance_provider, insurance_policy_number, insurance_expiration,
        bio, profile_picture_url, rating, rating_count
    `, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Driver not found' });
    }

    const user = result.rows[0];

    res.json({
      message: 'Profile updated successfully',
      driver: {
        id: user.id,
        email: user.email,
        phone: user.phone,
        firstName: user.first_name,
        lastName: user.last_name,
        vehicleType: user.vehicle_type,
        licensePlate: user.license_plate,
        companyName: user.company_name,
        hasCdl: user.has_cdl,
        cdlNumber: user.cdl_number,
        cdlState: user.cdl_state,
        cdlExpiration: user.cdl_expiration,
        insuranceProvider: user.insurance_provider,
        insurancePolicyNumber: user.insurance_policy_number,
        insuranceExpiration: user.insurance_expiration,
        bio: user.bio,
        profilePictureUrl: user.profile_picture_url,
        rating: user.rating,
        ratingCount: user.rating_count,
      },
    });
  } catch (error) {
    console.error('[Drivers] Update profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// ============================================
// POST /api/drivers/profile/photo
// Upload driver's profile photo
// ============================================

router.post('/profile/photo', authenticate, async (req, res) => {
  try {
    const { url, base64 } = req.body;

    let photoUrl = url;

    // If base64 image provided, we would upload to S3 here
    // For now, we accept either a direct URL or note that S3 upload would happen
    if (base64 && !url) {
      // TODO: Upload base64 to S3 and get URL
      // const s3Service = require('../services/s3Service');
      // photoUrl = await s3Service.uploadBase64Image(base64, `drivers/${req.user.id}/profile`);
      return res.status(400).json({
        error: 'Base64 upload not yet implemented. Please provide a URL.',
        hint: 'Use presigned URL upload via /documents/upload-url endpoint'
      });
    }

    if (!photoUrl) {
      return res.status(400).json({ error: 'Photo URL is required' });
    }

    // Update the profile picture URL
    const result = await pool.query(`
      UPDATE users
      SET profile_picture_url = $1, updated_at = NOW()
      WHERE id = $2
      RETURNING id, profile_picture_url
    `, [photoUrl, req.user.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Driver not found' });
    }

    res.json({
      message: 'Profile photo updated successfully',
      url: result.rows[0].profile_picture_url,
    });
  } catch (error) {
    console.error('[Drivers] Upload photo error:', error);
    res.status(500).json({ error: 'Failed to upload profile photo' });
  }
});

// ============================================
// DRIVER DOCUMENTS
// These endpoints match what the driver app expects
// ============================================

/**
 * GET /api/drivers/documents
 * Get list of driver's uploaded documents
 */
router.get('/documents', authenticate, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id,
        document_type as type,
        file_url as url,
        file_name as fileName,
        status,
        expires_at as expiresAt,
        uploaded_at as uploadedAt,
        reviewed_at as reviewedAt,
        rejection_reason as rejectionReason
      FROM driver_documents
      WHERE user_id = $1
      ORDER BY uploaded_at DESC
    `, [req.user.id]);

    // Define required document types
    const requiredTypes = [
      'drivers_license',
      'vehicle_registration',
      'insurance_certificate',
      'profile_photo'
    ];

    // Map documents by type
    const documentsByType = {};
    result.rows.forEach(doc => {
      documentsByType[doc.type] = {
        id: doc.id,
        type: doc.type,
        url: doc.url,
        fileName: doc.filename,
        status: doc.status,
        expiresAt: doc.expiresat,
        uploadedAt: doc.uploadedat,
        reviewedAt: doc.reviewedat,
        rejectionReason: doc.rejectionreason,
      };
    });

    // Build response with all required types
    const documents = requiredTypes.map(type => ({
      type,
      required: true,
      ...(documentsByType[type] || { status: 'missing' }),
    }));

    // Calculate completion status
    const uploadedCount = result.rows.length;
    const approvedCount = result.rows.filter(d => d.status === 'approved').length;
    const pendingCount = result.rows.filter(d => d.status === 'pending').length;
    const rejectedCount = result.rows.filter(d => d.status === 'rejected').length;

    res.json({
      documents,
      summary: {
        required: requiredTypes.length,
        uploaded: uploadedCount,
        approved: approvedCount,
        pending: pendingCount,
        rejected: rejectedCount,
        complete: approvedCount === requiredTypes.length,
      },
    });
  } catch (error) {
    console.error('[Drivers] Get documents error:', error);
    res.status(500).json({ error: 'Failed to get documents' });
  }
});

/**
 * POST /api/drivers/documents
 * Upload a new document (accepts URL or triggers presigned URL flow)
 */
router.post('/documents', authenticate, async (req, res) => {
  try {
    const {
      documentType,
      type, // Alias for documentType
      url,
      fileUrl,
      fileName,
      expiresAt,
    } = req.body;

    const docType = documentType || type;
    const docUrl = url || fileUrl;

    if (!docType) {
      return res.status(400).json({ error: 'Document type is required' });
    }

    if (!docUrl) {
      return res.status(400).json({
        error: 'Document URL is required',
        hint: 'Upload the file first using /documents/upload-url endpoint, then provide the URL here'
      });
    }

    // Upsert document record
    const result = await pool.query(`
      INSERT INTO driver_documents (user_id, document_type, file_url, file_name, status, expires_at, uploaded_at)
      VALUES ($1, $2, $3, $4, 'pending', $5, NOW())
      ON CONFLICT (user_id, document_type)
      DO UPDATE SET
        file_url = EXCLUDED.file_url,
        file_name = EXCLUDED.file_name,
        status = 'pending',
        expires_at = EXCLUDED.expires_at,
        uploaded_at = NOW(),
        reviewed_at = NULL,
        rejection_reason = NULL
      RETURNING *
    `, [req.user.id, docType, docUrl, fileName || null, expiresAt || null]);

    const doc = result.rows[0];

    // Update user's updated_at timestamp
    // Note: approval_status is managed separately by the verification flow
    await pool.query(`
      UPDATE users SET updated_at = NOW() WHERE id = $1
    `, [req.user.id]);

    res.status(201).json({
      message: 'Document uploaded successfully',
      document: {
        id: doc.id,
        type: doc.document_type,
        url: doc.file_url,
        fileName: doc.file_name,
        status: doc.status,
        uploadedAt: doc.uploaded_at,
      },
    });
  } catch (error) {
    console.error('[Drivers] Upload document error:', error);
    res.status(500).json({ error: 'Failed to upload document' });
  }
});

/**
 * DELETE /api/drivers/documents/:type
 * Delete a document by type
 */
router.delete('/documents/:type', authenticate, async (req, res) => {
  try {
    const { type } = req.params;

    const result = await pool.query(`
      DELETE FROM driver_documents
      WHERE user_id = $1 AND document_type = $2
      RETURNING id, document_type
    `, [req.user.id, type]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }

    // Update user's updated_at timestamp
    await pool.query(`
      UPDATE users SET updated_at = NOW() WHERE id = $1
    `, [req.user.id]);

    res.json({
      message: 'Document deleted successfully',
      deletedType: type,
    });
  } catch (error) {
    console.error('[Drivers] Delete document error:', error);
    res.status(500).json({ error: 'Failed to delete document' });
  }
});

// ============================================
// GET /api/drivers/earnings
// Get driver's earnings summary
// ============================================

router.get('/earnings', authenticate, async (req, res) => {
  try {
    const { period = 'today' } = req.query;
    
    let dateFilter = '';
    
    switch (period) {
      case 'today':
        dateFilter = `AND DATE(delivered_at) = CURRENT_DATE`;
        break;
      case 'week':
        dateFilter = `AND delivered_at >= NOW() - INTERVAL '7 days'`;
        break;
      case 'month':
        dateFilter = `AND delivered_at >= NOW() - INTERVAL '30 days'`;
        break;
      case 'all':
      default:
        dateFilter = '';
    }

    const result = await pool.query(`
      SELECT 
        COALESCE(SUM(driver_payout), 0) as total_earnings,
        COUNT(*) as completed_loads,
        COALESCE(SUM(distance_miles), 0) as total_miles
      FROM loads
      WHERE driver_id = $1 
        AND status = 'delivered'
        ${dateFilter}
    `, [req.user.id]);

    const stats = result.rows[0];

    res.json({
      period,
      totalEarnings: parseFloat(stats.total_earnings) || 0,
      completedLoads: parseInt(stats.completed_loads) || 0,
      totalMiles: parseFloat(stats.total_miles) || 0,
    });
  } catch (error) {
    console.error('[Drivers] Earnings error:', error);
    // Return empty stats instead of error
    res.json({
      period: req.query.period || 'today',
      totalEarnings: 0,
      completedLoads: 0,
      totalMiles: 0,
    });
  }
});

// ============================================
// GET /api/drivers/active-job
// Get driver's currently active load
// ============================================

router.get('/active-job', authenticate, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        l.*,
        s.first_name as shipper_first_name,
        s.last_name as shipper_last_name,
        s.phone as shipper_phone,
        s.company_name as shipper_company
      FROM loads l
      JOIN users s ON l.shipper_id = s.id
      WHERE l.driver_id = $1 
        AND l.status IN ('assigned', 'en_route_pickup', 'at_pickup', 'picked_up', 'en_route_delivery', 'at_delivery')
      ORDER BY 
        CASE l.status
          WHEN 'en_route_delivery' THEN 1
          WHEN 'at_delivery' THEN 2
          WHEN 'picked_up' THEN 3
          WHEN 'at_pickup' THEN 4
          WHEN 'en_route_pickup' THEN 5
          WHEN 'assigned' THEN 6
        END
      LIMIT 1
    `, [req.user.id]);

    if (result.rows.length === 0) {
      return res.json({ activeJob: null });
    }

    const load = result.rows[0];
    
    res.json({
      activeJob: {
        id: load.id,
        status: load.status,
        loadType: load.load_type,
        description: load.description,
        pickupAddress: load.pickup_address,
        pickupCity: load.pickup_city,
        pickupState: load.pickup_state,
        pickupLat: load.pickup_lat,
        pickupLng: load.pickup_lng,
        pickupDate: load.pickup_date,
        pickupTimeStart: load.pickup_time_start,
        pickupTimeEnd: load.pickup_time_end,
        deliveryAddress: load.delivery_address,
        deliveryCity: load.delivery_city,
        deliveryState: load.delivery_state,
        deliveryLat: load.delivery_lat,
        deliveryLng: load.delivery_lng,
        deliveryDate: load.delivery_date,
        deliveryTimeStart: load.delivery_time_start,
        deliveryTimeEnd: load.delivery_time_end,
        distanceMiles: load.distance_miles,
        price: load.price,
        driverPayout: load.driver_payout,
        shipper: {
          firstName: load.shipper_first_name,
          lastName: load.shipper_last_name,
          phone: load.shipper_phone,
          company: load.shipper_company,
        },
      },
    });
  } catch (error) {
    console.error('[Drivers] Active job error:', error);
    res.json({ activeJob: null });
  }
});

// ============================================
// POST /api/drivers/location
// Update driver's current GPS coordinates
// ============================================

router.post('/location', authenticate, async (req, res) => {
  try {
    const { lat, lng } = req.body;

    if (!lat || !lng) {
      return res.status(400).json({ error: 'lat and lng required' });
    }

    await pool.query(`
      UPDATE users 
      SET driver_lat = $1, driver_lng = $2, location_updated_at = NOW()
      WHERE id = $3
    `, [lat, lng, req.user.id]);

    // Also update any active availability posts
    try {
      await pool.query(`
        UPDATE driver_availability
        SET current_lat = $1, current_lng = $2, updated_at = NOW()
        WHERE driver_id = $3 AND is_active = true
      `, [lat, lng, req.user.id]);
    } catch (e) {
      // Table might not exist yet, ignore
    }

    res.json({ message: 'Location updated' });
  } catch (error) {
    console.error('[Drivers] Location update error:', error);
    res.status(500).json({ error: 'Failed to update location' });
  }
});

// ============================================
// PUT /api/drivers/availability-status
// Toggle driver online/offline status
// ============================================

router.put('/availability-status', authenticate, async (req, res) => {
  try {
    const { isAvailable } = req.body;

    await pool.query(
      'UPDATE users SET is_available = $1 WHERE id = $2',
      [isAvailable, req.user.id]
    );

    res.json({ message: 'Availability updated', isAvailable });
  } catch (error) {
    console.error('[Drivers] Availability status error:', error);
    res.status(500).json({ error: 'Failed to update availability' });
  }
});

// ============================================
// AVAILABILITY POSTS (Route Intent)
// ============================================

// GET /api/drivers/availability - Get driver's availability posts
router.get('/availability', authenticate, async (req, res) => {
  try {
    const { active } = req.query;
    
    // Check if table exists first
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'driver_availability'
      )
    `);
    
    if (!tableCheck.rows[0].exists) {
      return res.json({ availability: [] });
    }
    
    let query = `
      SELECT * FROM driver_availability
      WHERE driver_id = $1
    `;
    const params = [req.user.id];
    
    if (active === 'true') {
      query += ' AND is_active = true';
    }
    
    query += ' ORDER BY created_at DESC';
    
    const result = await pool.query(query, params);
    
    res.json({ availability: result.rows });
  } catch (error) {
    console.error('[Drivers] Get availability error:', error);
    res.json({ availability: [] });
  }
});

// POST /api/drivers/availability - Create new availability post
router.post('/availability', authenticate, async (req, res) => {
  try {
    const {
      mode = 'backhaul_now',
      currentLat,
      currentLng,
      startCity,
      startState,
      destinationLat,
      destinationLng,
      destinationCity,
      destinationState,
      availableFrom,
      availableUntil,
      departureWindowStart,
      departureWindowEnd,
      equipmentType,
      maxWeightLbs,
      palletCapacity,
      maxDeadheadMiles = 100,
      maxDetourMiles = 50,
      serviceTypesAccepted = ['standard'],
      minPayout,
      minRatePerMile,
      isRecurring = false,
      recurrenceDays,
    } = req.body;

    // Validate required fields
    if (!destinationLat || !destinationLng || !equipmentType) {
      return res.status(400).json({ 
        error: 'destinationLat, destinationLng, and equipmentType are required' 
      });
    }

    // Get current location from user if not provided
    let lat = currentLat;
    let lng = currentLng;
    
    if (!lat || !lng) {
      const userResult = await pool.query(
        'SELECT driver_lat, driver_lng FROM users WHERE id = $1',
        [req.user.id]
      );
      if (userResult.rows[0]) {
        lat = userResult.rows[0].driver_lat;
        lng = userResult.rows[0].driver_lng;
      }
    }

    if (!lat || !lng) {
      return res.status(400).json({ 
        error: 'Current location required. Please update your location.' 
      });
    }

    // Check if table exists
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'driver_availability'
      )
    `);
    
    if (!tableCheck.rows[0].exists) {
      return res.status(400).json({ 
        error: 'Availability feature not yet enabled. Please run database migrations.' 
      });
    }

    const result = await pool.query(`
      INSERT INTO driver_availability (
        driver_id, mode,
        current_lat, current_lng, start_city, start_state,
        destination_lat, destination_lng, destination_city, destination_state,
        available_from, available_until,
        departure_window_start, departure_window_end,
        equipment_type, max_weight_lbs, pallet_capacity,
        max_deadhead_miles, max_detour_miles,
        service_types_accepted, min_payout, min_rate_per_mile,
        is_recurring, recurrence_days,
        is_active
      ) VALUES (
        $1, $2,
        $3, $4, $5, $6,
        $7, $8, $9, $10,
        $11, $12,
        $13, $14,
        $15, $16, $17,
        $18, $19,
        $20, $21, $22,
        $23, $24,
        true
      ) RETURNING *
    `, [
      req.user.id, mode,
      lat, lng, startCity, startState,
      destinationLat, destinationLng, destinationCity, destinationState,
      availableFrom || new Date(), availableUntil,
      departureWindowStart, departureWindowEnd,
      equipmentType, maxWeightLbs, palletCapacity,
      maxDeadheadMiles, maxDetourMiles,
      serviceTypesAccepted, minPayout, minRatePerMile,
      isRecurring, recurrenceDays,
    ]);

    res.status(201).json({
      message: 'Availability posted',
      availability: result.rows[0],
    });
  } catch (error) {
    console.error('[Drivers] Post availability error:', error);
    res.status(500).json({ error: 'Failed to post availability' });
  }
});

// PUT /api/drivers/availability/:id - Update availability post
router.put('/availability/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    // Verify ownership
    const check = await pool.query(
      'SELECT driver_id FROM driver_availability WHERE id = $1',
      [id]
    );

    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Availability not found' });
    }

    if (check.rows[0].driver_id !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    // Build dynamic update query
    const allowedFields = [
      'current_lat', 'current_lng', 'start_city', 'start_state',
      'destination_lat', 'destination_lng', 'destination_city', 'destination_state',
      'available_from', 'available_until',
      'departure_window_start', 'departure_window_end',
      'equipment_type', 'max_weight_lbs', 'pallet_capacity',
      'max_deadhead_miles', 'max_detour_miles',
      'service_types_accepted', 'min_payout', 'min_rate_per_mile',
      'is_active',
    ];

    const setClauses = [];
    const values = [];
    let paramIndex = 1;

    // Convert camelCase to snake_case and build query
    Object.entries(updates).forEach(([key, value]) => {
      const snakeKey = key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
      if (allowedFields.includes(snakeKey)) {
        setClauses.push(`${snakeKey} = $${paramIndex}`);
        values.push(value);
        paramIndex++;
      }
    });

    if (setClauses.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    setClauses.push('updated_at = NOW()');
    values.push(id);

    const result = await pool.query(`
      UPDATE driver_availability
      SET ${setClauses.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING *
    `, values);

    res.json({
      message: 'Availability updated',
      availability: result.rows[0],
    });
  } catch (error) {
    console.error('[Drivers] Update availability error:', error);
    res.status(500).json({ error: 'Failed to update availability' });
  }
});

// DELETE /api/drivers/availability/:id - Delete availability post
router.delete('/availability/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    // Verify ownership
    const check = await pool.query(
      'SELECT driver_id FROM driver_availability WHERE id = $1',
      [id]
    );

    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Availability not found' });
    }

    if (check.rows[0].driver_id !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    await pool.query('DELETE FROM driver_availability WHERE id = $1', [id]);

    res.json({ message: 'Availability deleted' });
  } catch (error) {
    console.error('[Drivers] Delete availability error:', error);
    res.status(500).json({ error: 'Failed to delete availability' });
  }
});

// ============================================
// GET /api/drivers/offers
// Get offers sent to this driver
// ============================================

router.get('/offers', authenticate, async (req, res) => {
  try {
    const { status = 'pending' } = req.query;

    // Check if table exists
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'load_offers'
      )
    `);
    
    if (!tableCheck.rows[0].exists) {
      return res.json({ offers: [] });
    }

    const result = await pool.query(`
      SELECT 
        o.*,
        l.pickup_city, l.pickup_state, l.delivery_city, l.delivery_state,
        l.pickup_date, l.pickup_time_start, l.pickup_time_end,
        l.delivery_date, l.delivery_time_start, l.delivery_time_end,
        l.distance_miles, l.load_type, l.vehicle_type_required,
        l.description, l.weight_lbs,
        s.first_name as shipper_first_name, s.last_name as shipper_last_name,
        s.company_name as shipper_company, s.phone as shipper_phone
      FROM load_offers o
      JOIN loads l ON o.load_id = l.id
      JOIN users s ON l.shipper_id = s.id
      WHERE o.driver_id = $1
        AND ($2 = 'all' OR o.status = $2)
        AND (o.expires_at > NOW() OR o.status != 'pending')
      ORDER BY 
        CASE WHEN o.status = 'pending' THEN 0 ELSE 1 END,
        o.created_at DESC
    `, [req.user.id, status]);

    res.json({ offers: result.rows });
  } catch (error) {
    console.error('[Drivers] Get offers error:', error);
    res.json({ offers: [] });
  }
});

// ============================================
// GET /api/drivers/stats
// Get driver stats summary
// ============================================

router.get('/stats', authenticate, async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT 
        (SELECT COUNT(*) FROM loads WHERE driver_id = $1 AND status = 'delivered') as completed_loads,
        (SELECT COUNT(*) FROM loads WHERE driver_id = $1 AND status IN ('assigned', 'en_route_pickup', 'picked_up', 'en_route_delivery')) as active_loads,
        (SELECT COALESCE(SUM(driver_payout), 0) FROM loads WHERE driver_id = $1 AND status = 'delivered') as total_earnings
    `, [req.user.id]);

    // Check availability table
    let activeAvailability = 0;
    let pendingOffers = 0;
    
    try {
      const availResult = await pool.query(
        'SELECT COUNT(*) FROM driver_availability WHERE driver_id = $1 AND is_active = true',
        [req.user.id]
      );
      activeAvailability = parseInt(availResult.rows[0].count) || 0;
    } catch (e) {}
    
    try {
      const offerResult = await pool.query(
        "SELECT COUNT(*) FROM load_offers WHERE driver_id = $1 AND status = 'pending' AND expires_at > NOW()",
        [req.user.id]
      );
      pendingOffers = parseInt(offerResult.rows[0].count) || 0;
    } catch (e) {}

    res.json({
      ...stats.rows[0],
      active_availability: activeAvailability,
      pending_offers: pendingOffers,
    });
  } catch (error) {
    console.error('[Drivers] Stats error:', error);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

// ============================================
// GET /api/drivers/:driverId/ratings
// Get ratings received by a driver
// ============================================

router.get('/:driverId/ratings', authenticate, async (req, res) => {
  try {
    const { driverId } = req.params;
    const { limit = 20, offset = 0 } = req.query;

    // Get driver info with rating
    const driverResult = await pool.query(`
      SELECT
        id,
        first_name,
        last_name,
        profile_picture_url,
        rating,
        rating_count,
        vehicle_type
      FROM users
      WHERE id = $1 AND role = 'driver'
    `, [driverId]);

    if (driverResult.rows.length === 0) {
      return res.status(404).json({ error: 'Driver not found' });
    }

    const driver = driverResult.rows[0];

    // Get ratings received by this driver
    const ratingsResult = await pool.query(`
      SELECT
        dr.id,
        dr.rating,
        dr.comment,
        dr.tags,
        dr.created_at,
        l.id as load_id,
        l.pickup_city,
        l.pickup_state,
        l.delivery_city,
        l.delivery_state,
        l.delivered_at,
        u.company_name as shipper_name,
        u.first_name as shipper_first_name
      FROM driver_ratings dr
      JOIN loads l ON dr.load_id = l.id
      LEFT JOIN users u ON dr.shipper_id = u.id
      WHERE dr.driver_id = $1
      ORDER BY dr.created_at DESC
      LIMIT $2 OFFSET $3
    `, [driverId, parseInt(limit), parseInt(offset)]);

    // Get rating distribution
    const distributionResult = await pool.query(`
      SELECT
        rating,
        COUNT(*) as count
      FROM driver_ratings
      WHERE driver_id = $1
      GROUP BY rating
      ORDER BY rating DESC
    `, [driverId]);

    // Build distribution object (5, 4, 3, 2, 1 stars)
    const distribution = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
    distributionResult.rows.forEach(row => {
      distribution[row.rating] = parseInt(row.count);
    });

    // Get total count for pagination
    const countResult = await pool.query(
      'SELECT COUNT(*) as total FROM driver_ratings WHERE driver_id = $1',
      [driverId]
    );

    res.json({
      driver: {
        id: driver.id,
        name: `${driver.first_name} ${driver.last_name || ''}`.trim(),
        profilePictureUrl: driver.profile_picture_url,
        rating: parseFloat(driver.rating) || 0,
        ratingCount: parseInt(driver.rating_count) || 0,
        vehicleType: driver.vehicle_type,
      },
      ratings: ratingsResult.rows.map(r => ({
        id: r.id,
        rating: r.rating,
        comment: r.comment,
        tags: r.tags,
        createdAt: r.created_at,
        loadId: r.load_id,
        route: `${r.pickup_city}, ${r.pickup_state} → ${r.delivery_city}, ${r.delivery_state}`,
        deliveredAt: r.delivered_at,
        shipperName: r.shipper_name || r.shipper_first_name || 'Anonymous',
      })),
      distribution,
      pagination: {
        total: parseInt(countResult.rows[0].total),
        limit: parseInt(limit),
        offset: parseInt(offset),
      },
    });
  } catch (error) {
    console.error('[Drivers] Get ratings error:', error);
    res.status(500).json({ error: 'Failed to fetch driver ratings' });
  }
});

module.exports = router;
