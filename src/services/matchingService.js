// backend_api/src/services/matchingService.js
// Driver-Load Matching Engine
// Scores drivers based on route-fit, deadhead, detour, time feasibility

const { pool } = require('../db/pool');

// ============================================
// CONSTANTS
// ============================================

const MATCH_THRESHOLDS = {
  PERFECT: 85,      // 85-100: Perfect match
  VERY_CLOSE: 70,   // 70-84: Very close
  DECENT: 50,       // 50-69: Decent match
  MINIMUM: 30,      // Below 30: Don't show
};

const SCORING_WEIGHTS = {
  DEADHEAD_PENALTY: 1.2,    // Points lost per deadhead mile
  DETOUR_PENALTY: 0.8,      // Points lost per detour mile
  TIGHT_WINDOW_PENALTY: 5,  // Penalty if pickup window is < 2 hours
  DESTINATION_BONUS: 10,    // Bonus if delivery is near driver's destination
  SAME_STATE_BONUS: 5,      // Bonus if delivery in same state as driver destination
};

const DEFAULT_FILTERS = {
  MAX_DEADHEAD_MILES: 100,  // Don't show if deadhead > 100 miles
  MAX_DETOUR_MILES: 75,     // Don't show if detour > 75 miles
  MIN_SCORE: 30,            // Don't return matches below this score
};

// Average speed for ETA calculations (mph)
const AVG_SPEED_MPH = 50;

// ============================================
// HAVERSINE DISTANCE (miles)
// ============================================

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 3959; // Earth radius in miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// ============================================
// POINT-TO-LINE DISTANCE
// Calculates how far a point is from the line between two other points
// Used to determine if pickup is "along the way"
// ============================================

function pointToLineDistance(pointLat, pointLng, lineStartLat, lineStartLng, lineEndLat, lineEndLng) {
  // Vector from start to end
  const dx = lineEndLng - lineStartLng;
  const dy = lineEndLat - lineStartLat;
  
  // If start and end are same point, return distance to that point
  if (dx === 0 && dy === 0) {
    return haversineDistance(pointLat, pointLng, lineStartLat, lineStartLng);
  }
  
  // Calculate projection of point onto line
  const t = Math.max(0, Math.min(1, 
    ((pointLng - lineStartLng) * dx + (pointLat - lineStartLat) * dy) / (dx * dx + dy * dy)
  ));
  
  // Find closest point on line segment
  const closestLng = lineStartLng + t * dx;
  const closestLat = lineStartLat + t * dy;
  
  return haversineDistance(pointLat, pointLng, closestLat, closestLng);
}

// ============================================
// DETOUR CALCULATION
// How many extra miles does taking this load add to driver's route?
// ============================================

function calculateDetour(driverStartLat, driverStartLng, driverDestLat, driverDestLng,
                         pickupLat, pickupLng, deliveryLat, deliveryLng) {
  // Original route: start → destination
  const originalRoute = haversineDistance(driverStartLat, driverStartLng, driverDestLat, driverDestLng);
  
  // New route: start → pickup → delivery → destination
  const toPickup = haversineDistance(driverStartLat, driverStartLng, pickupLat, pickupLng);
  const pickupToDelivery = haversineDistance(pickupLat, pickupLng, deliveryLat, deliveryLng);
  const deliveryToDest = haversineDistance(deliveryLat, deliveryLng, driverDestLat, driverDestLng);
  const newRoute = toPickup + pickupToDelivery + deliveryToDest;
  
  // Detour = extra miles added
  return Math.max(0, newRoute - originalRoute);
}

// ============================================
// TIME FEASIBILITY CHECK
// Can the driver reach pickup in time and deliver within window?
// ============================================

function checkTimeFeasibility(
  driverStartLat, driverStartLng,
  pickupLat, pickupLng,
  deliveryLat, deliveryLng,
  driverDepartureTime, // Date object or ISO string
  pickupWindowStart,   // Time string like "09:00" or Date
  pickupWindowEnd,
  deliveryWindowStart,
  deliveryWindowEnd,
  pickupDate,          // Date for the pickup
  deliveryDate         // Date for the delivery
) {
  const result = {
    feasible: true,
    etaToPickup: null,
    etaToDelivery: null,
    pickupArrivalTime: null,
    deliveryArrivalTime: null,
    warnings: [],
  };
  
  try {
    // Calculate distances
    const milesToPickup = haversineDistance(driverStartLat, driverStartLng, pickupLat, pickupLng);
    const milesToDelivery = haversineDistance(pickupLat, pickupLng, deliveryLat, deliveryLng);
    
    // Calculate drive times (add 20% buffer for real-world conditions)
    const driveTimeToPickupHours = (milesToPickup / AVG_SPEED_MPH) * 1.2;
    const driveTimeToDeliveryHours = (milesToDelivery / AVG_SPEED_MPH) * 1.2;
    
    result.etaToPickup = Math.round(driveTimeToPickupHours * 60); // minutes
    result.etaToDelivery = Math.round(driveTimeToDeliveryHours * 60); // minutes
    
    // Parse driver departure time
    const departureTime = new Date(driverDepartureTime);
    if (isNaN(departureTime.getTime())) {
      result.warnings.push('Invalid driver departure time');
      return result;
    }
    
    // Calculate when driver arrives at pickup
    const pickupArrival = new Date(departureTime.getTime() + driveTimeToPickupHours * 60 * 60 * 1000);
    result.pickupArrivalTime = pickupArrival.toISOString();
    
    // Parse pickup window
    const pickupDateObj = new Date(pickupDate);
    const [pickupStartHour, pickupStartMin] = (pickupWindowStart || '00:00').split(':').map(Number);
    const [pickupEndHour, pickupEndMin] = (pickupWindowEnd || '23:59').split(':').map(Number);
    
    const pickupWindowStartTime = new Date(pickupDateObj);
    pickupWindowStartTime.setHours(pickupStartHour, pickupStartMin, 0, 0);
    
    const pickupWindowEndTime = new Date(pickupDateObj);
    pickupWindowEndTime.setHours(pickupEndHour, pickupEndMin, 0, 0);
    
    // Check if driver can arrive within pickup window
    if (pickupArrival > pickupWindowEndTime) {
      result.feasible = false;
      result.warnings.push('Cannot reach pickup before window closes');
    } else if (pickupArrival < pickupWindowStartTime) {
      // Driver arrives early - that's OK, they just wait
      result.warnings.push('Driver may arrive before pickup window opens');
    }
    
    // Calculate delivery arrival (assume 30 min at pickup for loading)
    const loadingTimeMs = 30 * 60 * 1000;
    const actualPickupTime = Math.max(pickupArrival.getTime(), pickupWindowStartTime.getTime());
    const deliveryArrival = new Date(actualPickupTime + loadingTimeMs + driveTimeToDeliveryHours * 60 * 60 * 1000);
    result.deliveryArrivalTime = deliveryArrival.toISOString();
    
    // Parse delivery window
    if (deliveryWindowEnd && deliveryDate) {
      const deliveryDateObj = new Date(deliveryDate);
      const [deliveryEndHour, deliveryEndMin] = (deliveryWindowEnd || '23:59').split(':').map(Number);
      
      const deliveryWindowEndTime = new Date(deliveryDateObj);
      deliveryWindowEndTime.setHours(deliveryEndHour, deliveryEndMin, 0, 0);
      
      if (deliveryArrival > deliveryWindowEndTime) {
        result.feasible = false;
        result.warnings.push('Cannot complete delivery before window closes');
      }
    }
    
  } catch (error) {
    result.warnings.push(`Time calculation error: ${error.message}`);
  }
  
  return result;
}

// ============================================
// EQUIPMENT MATCHING
// ============================================

function checkEquipmentMatch(driverEquipment, requiredEquipment) {
  if (!requiredEquipment || requiredEquipment === 'not_sure') {
    return true; // Any equipment works
  }
  
  // Normalize for comparison
  const normalize = (eq) => eq?.toLowerCase().replace(/\s+/g, '_') || '';
  
  const driverEq = normalize(driverEquipment);
  const requiredEq = normalize(requiredEquipment);
  
  // Exact match
  if (driverEq === requiredEq) return true;
  
  // Size compatibility (larger can haul smaller)
  const sizeUpgrades = {
    'box_truck_26ft': ['box_truck_24ft', 'box_truck_16ft'],
    'box_truck_24ft': ['box_truck_16ft'],
    'dry_van_53ft': ['dry_van_48ft'],
    'reefer_53ft': ['reefer_48ft'],
    'flatbed_53ft': ['flatbed_48ft'],
  };
  
  if (sizeUpgrades[driverEq]?.includes(requiredEq)) {
    return true;
  }
  
  return false;
}

// ============================================
// CALCULATE MATCH SCORE
// ============================================

function calculateMatchScore(params) {
  const {
    deadheadMiles,
    detourMiles,
    timeFeasibility,
    equipmentMatch,
    pickupWindowHours,
    isNearDestination,
    isSameState,
    driverMinPayout,
    driverMinRpm,
    loadPayout,
    loadRpm,
  } = params;
  
  // Start with perfect score
  let score = 100;
  
  // Hard filters - if these fail, score is 0
  if (!equipmentMatch) return { score: 0, reason: 'Equipment mismatch' };
  if (!timeFeasibility.feasible) return { score: 0, reason: timeFeasibility.warnings[0] || 'Time infeasible' };
  
  // Check driver's minimum payout/RPM requirements
  if (driverMinPayout && loadPayout < driverMinPayout) {
    return { score: 0, reason: `Payout $${loadPayout} below driver minimum $${driverMinPayout}` };
  }
  if (driverMinRpm && loadRpm < driverMinRpm) {
    return { score: 0, reason: `RPM $${loadRpm.toFixed(2)} below driver minimum $${driverMinRpm.toFixed(2)}` };
  }
  
  // Apply penalties
  score -= deadheadMiles * SCORING_WEIGHTS.DEADHEAD_PENALTY;
  score -= detourMiles * SCORING_WEIGHTS.DETOUR_PENALTY;
  
  // Tight pickup window penalty
  if (pickupWindowHours && pickupWindowHours < 2) {
    score -= SCORING_WEIGHTS.TIGHT_WINDOW_PENALTY;
  }
  
  // Apply bonuses
  if (isNearDestination) {
    score += SCORING_WEIGHTS.DESTINATION_BONUS;
  }
  if (isSameState) {
    score += SCORING_WEIGHTS.SAME_STATE_BONUS;
  }
  
  // Clamp to 0-100
  score = Math.max(0, Math.min(100, score));
  
  return {
    score: Math.round(score),
    reason: null,
  };
}

// ============================================
// GET MATCH LABEL
// ============================================

function getMatchLabel(score) {
  if (score >= MATCH_THRESHOLDS.PERFECT) return 'Perfect';
  if (score >= MATCH_THRESHOLDS.VERY_CLOSE) return 'Very Close';
  if (score >= MATCH_THRESHOLDS.DECENT) return 'Decent';
  return 'Available';
}

// ============================================
// MAIN MATCHING FUNCTION
// Find and score all matching drivers for a load
// ============================================

async function findMatchesForLoad(loadId, options = {}) {
  const {
    maxResults = 20,
    includeWiderMatches = false,
    maxDeadheadMiles = DEFAULT_FILTERS.MAX_DEADHEAD_MILES,
    maxDetourMiles = DEFAULT_FILTERS.MAX_DETOUR_MILES,
    minScore = DEFAULT_FILTERS.MIN_SCORE,
  } = options;
  
  // 1. Get load details
  const loadResult = await pool.query(`
    SELECT 
      l.*,
      l.pickup_lat, l.pickup_lng, l.pickup_city, l.pickup_state,
      l.delivery_lat, l.delivery_lng, l.delivery_city, l.delivery_state,
      l.pickup_date, l.pickup_time_start, l.pickup_time_end,
      l.delivery_date, l.delivery_time_start, l.delivery_time_end,
      l.vehicle_type_required, l.load_type, l.driver_payout, l.distance_miles
    FROM loads l
    WHERE l.id = $1
  `, [loadId]);
  
  if (loadResult.rows.length === 0) {
    throw new Error('Load not found');
  }
  
  const load = loadResult.rows[0];
  
  // Validate load has required location data
  if (!load.pickup_lat || !load.pickup_lng || !load.delivery_lat || !load.delivery_lng) {
    throw new Error('Load missing location coordinates');
  }
  
  // 2. Get active driver availability posts that could match
  const availabilityResult = await pool.query(`
    SELECT 
      da.*,
      u.id as user_id, u.first_name, u.last_name, u.phone,
      u.rating, u.total_deliveries, u.profile_image_url
    FROM driver_availability da
    JOIN users u ON da.driver_id = u.id
    WHERE da.is_active = true
      AND da.available_from <= $1
      AND (da.available_until IS NULL OR da.available_until >= $1)
      AND u.is_active = true
      AND u.role = 'driver'
  `, [load.pickup_date || new Date()]);
  
  const matches = [];
  
  // 3. Score each driver
  for (const avail of availabilityResult.rows) {
    // Skip if no location data
    if (!avail.current_lat || !avail.current_lng) continue;
    
    // Calculate deadhead (driver → pickup)
    const deadheadMiles = haversineDistance(
      parseFloat(avail.current_lat),
      parseFloat(avail.current_lng),
      parseFloat(load.pickup_lat),
      parseFloat(load.pickup_lng)
    );
    
    // Skip if deadhead exceeds driver's preference or hard limit
    const driverMaxDeadhead = avail.max_detour_miles || maxDeadheadMiles;
    if (deadheadMiles > Math.min(driverMaxDeadhead, maxDeadheadMiles)) {
      if (!includeWiderMatches) continue;
    }
    
    // Calculate detour (if driver has a destination)
    let detourMiles = 0;
    let isNearDestination = false;
    let isSameState = false;
    
    if (avail.destination_lat && avail.destination_lng) {
      detourMiles = calculateDetour(
        parseFloat(avail.current_lat),
        parseFloat(avail.current_lng),
        parseFloat(avail.destination_lat),
        parseFloat(avail.destination_lng),
        parseFloat(load.pickup_lat),
        parseFloat(load.pickup_lng),
        parseFloat(load.delivery_lat),
        parseFloat(load.delivery_lng)
      );
      
      // Check if delivery is near driver's destination
      const deliveryToDestDist = haversineDistance(
        parseFloat(load.delivery_lat),
        parseFloat(load.delivery_lng),
        parseFloat(avail.destination_lat),
        parseFloat(avail.destination_lng)
      );
      isNearDestination = deliveryToDestDist < 50; // Within 50 miles
      
      // Check same state
      isSameState = avail.destination_state === load.delivery_state;
    }
    
    // Skip if detour exceeds limit
    if (detourMiles > maxDetourMiles && !includeWiderMatches) continue;
    
    // Check equipment match
    const equipmentMatch = checkEquipmentMatch(avail.equipment_type, load.vehicle_type_required);
    
    // Check service type accepted
    const serviceTypes = avail.service_types_accepted || ['standard'];
    const loadType = load.load_type || 'standard';
    if (!serviceTypes.includes(loadType) && !serviceTypes.includes('all')) {
      continue; // Driver doesn't accept this load type
    }
    
    // Check time feasibility
    const timeFeasibility = checkTimeFeasibility(
      parseFloat(avail.current_lat),
      parseFloat(avail.current_lng),
      parseFloat(load.pickup_lat),
      parseFloat(load.pickup_lng),
      parseFloat(load.delivery_lat),
      parseFloat(load.delivery_lng),
      avail.available_from,
      load.pickup_time_start,
      load.pickup_time_end,
      load.delivery_time_start,
      load.delivery_time_end,
      load.pickup_date,
      load.delivery_date
    );
    
    // Calculate pickup window hours
    let pickupWindowHours = null;
    if (load.pickup_time_start && load.pickup_time_end) {
      const [startH, startM] = load.pickup_time_start.split(':').map(Number);
      const [endH, endM] = load.pickup_time_end.split(':').map(Number);
      pickupWindowHours = (endH + endM / 60) - (startH + startM / 60);
    }
    
    // Calculate load RPM
    const loadRpm = load.distance_miles > 0 
      ? (load.driver_payout || 0) / load.distance_miles 
      : 0;
    
    // Calculate match score
    const { score, reason } = calculateMatchScore({
      deadheadMiles,
      detourMiles,
      timeFeasibility,
      equipmentMatch,
      pickupWindowHours,
      isNearDestination,
      isSameState,
      driverMinPayout: avail.min_payout ? parseFloat(avail.min_payout) : null,
      driverMinRpm: avail.min_rate_per_mile ? parseFloat(avail.min_rate_per_mile) : null,
      loadPayout: load.driver_payout ? parseFloat(load.driver_payout) : 0,
      loadRpm,
    });
    
    // Skip low scores unless including wider matches
    if (score < minScore && !includeWiderMatches) continue;
    
    matches.push({
      driverId: avail.driver_id,
      availabilityId: avail.id,
      driver: {
        id: avail.user_id,
        firstName: avail.first_name,
        lastName: avail.last_name,
        name: `${avail.first_name} ${avail.last_name}`.trim(),
        phone: avail.phone,
        rating: avail.rating ? parseFloat(avail.rating) : null,
        totalDeliveries: avail.total_deliveries || 0,
        profileImageUrl: avail.profile_image_url,
      },
      equipment: avail.equipment_type,
      score,
      matchLabel: getMatchLabel(score),
      deadheadMiles: Math.round(deadheadMiles),
      detourMiles: Math.round(detourMiles),
      etaToPickupMinutes: timeFeasibility.etaToPickup,
      pickupArrivalTime: timeFeasibility.pickupArrivalTime,
      deliveryArrivalTime: timeFeasibility.deliveryArrivalTime,
      timeFeasible: timeFeasibility.feasible,
      timeWarnings: timeFeasibility.warnings,
      skipReason: reason,
      // Driver's availability details
      availability: {
        mode: avail.mode,
        startCity: avail.start_city,
        destinationCity: avail.destination_city,
        destinationState: avail.destination_state,
        departureWindow: avail.available_from,
      },
    });
  }
  
  // 4. Sort by score (highest first)
  matches.sort((a, b) => b.score - a.score);
  
  // 5. Limit results
  const topMatches = matches.slice(0, maxResults);
  
  // 6. Group by match quality for summary
  const summary = {
    total: matches.length,
    perfect: matches.filter(m => m.score >= MATCH_THRESHOLDS.PERFECT).length,
    veryClose: matches.filter(m => m.score >= MATCH_THRESHOLDS.VERY_CLOSE && m.score < MATCH_THRESHOLDS.PERFECT).length,
    decent: matches.filter(m => m.score >= MATCH_THRESHOLDS.DECENT && m.score < MATCH_THRESHOLDS.VERY_CLOSE).length,
    available: matches.filter(m => m.score < MATCH_THRESHOLDS.DECENT).length,
  };
  
  return {
    loadId,
    matches: topMatches,
    summary,
    filters: {
      maxDeadheadMiles,
      maxDetourMiles,
      minScore,
      includeWiderMatches,
    },
  };
}

// ============================================
// QUICK MATCH CHECK
// Fast check if any good matches exist (for UI indicators)
// ============================================

async function hasGoodMatches(loadId) {
  const result = await findMatchesForLoad(loadId, { maxResults: 5, minScore: MATCH_THRESHOLDS.DECENT });
  return result.summary.perfect > 0 || result.summary.veryClose > 0;
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
  findMatchesForLoad,
  hasGoodMatches,
  calculateMatchScore,
  haversineDistance,
  calculateDetour,
  checkTimeFeasibility,
  checkEquipmentMatch,
  getMatchLabel,
  MATCH_THRESHOLDS,
  SCORING_WEIGHTS,
  DEFAULT_FILTERS,
};
