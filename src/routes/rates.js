// backend_api/src/routes/rates.js
// Market benchmark rates and pricing endpoints

const express = require('express');
const router = express.Router();
const { pool } = require('../db/pool');
const { authenticate } = require('../middleware/auth');

// ============================================
// EQUIPMENT GROUP MAPPING
// Maps display names to database keys
// ============================================
const EQUIPMENT_TO_GROUP = {
  'Cargo Van': 'cargo_van',
  'Sprinter Van': 'sprinter_van',
  'Box Truck 16ft': 'box_truck_16',
  'Box Truck 24ft': 'box_truck_24',
  'Box Truck 26ft': 'box_truck_26',
  'Dry Van 48ft': 'dry_van_48',
  'Dry Van 53ft': 'dry_van_53',
  'Reefer 48ft': 'reefer_48',
  'Reefer 53ft': 'reefer_53',
  'Flatbed 48ft': 'flatbed_48',
  'Flatbed 53ft': 'flatbed_53',
  'Step Deck': 'step_deck',
  'Conestoga': 'conestoga',
  'Hotshot Trailer': 'hotshot_trailer',
  'Pickup w/ Trailer': 'pickup_trailer',
  'Power Only': 'power_only',
  'Double Drop': 'double_drop',
  'Lowboy': 'lowboy',
  'RGN': 'rgn',
  'Tanker': 'tanker',
  'Car Hauler': 'car_hauler',
};

// Default benchmarks (fallback if DB empty)
const DEFAULT_BENCHMARKS = {
  cargo_van: 1.25,
  sprinter_van: 1.40,
  box_truck_16: 1.65,
  box_truck_24: 1.80,
  box_truck_26: 1.90,
  dry_van_48: 2.10,
  dry_van_53: 2.25,
  reefer_48: 2.50,
  reefer_53: 2.65,
  flatbed_48: 2.40,
  flatbed_53: 2.55,
  step_deck: 2.70,
  conestoga: 2.85,
  hotshot_trailer: 1.75,
  pickup_trailer: 1.50,
  power_only: 1.60,
  double_drop: 3.00,
  lowboy: 3.25,
  rgn: 3.40,
  tanker: 2.60,
  car_hauler: 2.30,
};

// ============================================
// GET /api/rates/benchmark/:equipment
// Get current benchmark RPM for equipment type
// ============================================
router.get('/benchmark/:equipment', authenticate, async (req, res) => {
  try {
    const { equipment } = req.params;
    
    // Convert display name to group key
    const equipmentGroup = EQUIPMENT_TO_GROUP[equipment] || equipment.toLowerCase().replace(/\s+/g, '_');
    
    // Get latest benchmark from DB
    const result = await pool.query(`
      SELECT benchmark_rpm, date, source, confidence
      FROM market_benchmarks
      WHERE equipment_group = $1 AND date <= CURRENT_DATE
      ORDER BY date DESC
      LIMIT 1
    `, [equipmentGroup]);
    
    if (result.rows.length > 0) {
      const row = result.rows[0];
      return res.json({
        equipment: equipment,
        equipmentGroup: equipmentGroup,
        benchmarkRpm: parseFloat(row.benchmark_rpm),
        date: row.date,
        source: row.source,
        confidence: parseFloat(row.confidence || 1),
      });
    }
    
    // Fallback to default
    const defaultRpm = DEFAULT_BENCHMARKS[equipmentGroup] || 2.00;
    res.json({
      equipment: equipment,
      equipmentGroup: equipmentGroup,
      benchmarkRpm: defaultRpm,
      date: new Date().toISOString().split('T')[0],
      source: 'default',
      confidence: 0.5,
    });
    
  } catch (error) {
    console.error('Get benchmark error:', error);
    res.status(500).json({ error: 'Failed to get benchmark rate' });
  }
});

// ============================================
// GET /api/rates/benchmarks
// Get all current benchmarks (for admin or display)
// ============================================
router.get('/benchmarks', authenticate, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT ON (equipment_group)
        equipment_group, benchmark_rpm, date, source, confidence, notes
      FROM market_benchmarks
      WHERE date <= CURRENT_DATE
      ORDER BY equipment_group, date DESC
    `);
    
    // Merge with defaults for any missing
    const benchmarks = {};
    
    // Start with defaults
    Object.entries(DEFAULT_BENCHMARKS).forEach(([group, rpm]) => {
      benchmarks[group] = {
        equipmentGroup: group,
        benchmarkRpm: rpm,
        date: new Date().toISOString().split('T')[0],
        source: 'default',
      };
    });
    
    // Override with DB values
    result.rows.forEach(row => {
      benchmarks[row.equipment_group] = {
        equipmentGroup: row.equipment_group,
        benchmarkRpm: parseFloat(row.benchmark_rpm),
        date: row.date,
        source: row.source,
        confidence: parseFloat(row.confidence || 1),
        notes: row.notes,
      };
    });
    
    res.json({ benchmarks: Object.values(benchmarks) });
    
  } catch (error) {
    console.error('Get benchmarks error:', error);
    res.status(500).json({ error: 'Failed to get benchmarks' });
  }
});

// ============================================
// POST /api/rates/benchmark
// Admin: Set benchmark for equipment type
// ============================================
router.post('/benchmark', authenticate, async (req, res) => {
  try {
    const { equipmentGroup, benchmarkRpm, date, notes } = req.body;
    
    if (!equipmentGroup || !benchmarkRpm) {
      return res.status(400).json({ error: 'equipmentGroup and benchmarkRpm required' });
    }
    
    const targetDate = date || new Date().toISOString().split('T')[0];
    
    const result = await pool.query(`
      INSERT INTO market_benchmarks (date, equipment_group, benchmark_rpm, source, notes, created_by)
      VALUES ($1, $2, $3, 'manual', $4, $5)
      ON CONFLICT (date, equipment_group) 
      DO UPDATE SET 
        benchmark_rpm = EXCLUDED.benchmark_rpm,
        notes = EXCLUDED.notes,
        updated_at = CURRENT_TIMESTAMP
      RETURNING *
    `, [targetDate, equipmentGroup, benchmarkRpm, notes, req.user.id]);
    
    res.json({
      message: 'Benchmark updated',
      benchmark: {
        equipmentGroup: result.rows[0].equipment_group,
        benchmarkRpm: parseFloat(result.rows[0].benchmark_rpm),
        date: result.rows[0].date,
        source: result.rows[0].source,
      }
    });
    
  } catch (error) {
    console.error('Set benchmark error:', error);
    res.status(500).json({ error: 'Failed to set benchmark' });
  }
});

// ============================================
// POST /api/rates/benchmarks/bulk
// Admin: Set multiple benchmarks at once
// ============================================
router.post('/benchmarks/bulk', authenticate, async (req, res) => {
  try {
    const { benchmarks, date } = req.body;
    
    if (!benchmarks || !Array.isArray(benchmarks)) {
      return res.status(400).json({ error: 'benchmarks array required' });
    }
    
    const targetDate = date || new Date().toISOString().split('T')[0];
    const results = [];
    
    for (const b of benchmarks) {
      if (b.equipmentGroup && b.benchmarkRpm) {
        const result = await pool.query(`
          INSERT INTO market_benchmarks (date, equipment_group, benchmark_rpm, source, created_by)
          VALUES ($1, $2, $3, 'manual', $4)
          ON CONFLICT (date, equipment_group) 
          DO UPDATE SET benchmark_rpm = EXCLUDED.benchmark_rpm, updated_at = CURRENT_TIMESTAMP
          RETURNING equipment_group, benchmark_rpm
        `, [targetDate, b.equipmentGroup, b.benchmarkRpm, req.user.id]);
        
        results.push(result.rows[0]);
      }
    }
    
    res.json({ message: `Updated ${results.length} benchmarks`, results });
    
  } catch (error) {
    console.error('Bulk benchmark error:', error);
    res.status(500).json({ error: 'Failed to update benchmarks' });
  }
});

// ============================================
// GET /api/rates/quote
// Calculate quote for a shipment (used by mobile app)
// ============================================
router.get('/quote', authenticate, async (req, res) => {
  try {
    const {
      equipment,
      distanceMiles,
      loadType = 'standard',
      isBackhaulSaver = false,
    } = req.query;
    
    const miles = parseFloat(distanceMiles);
    if (!miles || miles <= 0) {
      return res.status(400).json({ error: 'Valid distanceMiles required' });
    }
    
    // Get benchmark for equipment
    const equipmentGroup = EQUIPMENT_TO_GROUP[equipment] || equipment?.toLowerCase().replace(/\s+/g, '_') || 'dry_van_53';
    
    const benchResult = await pool.query(`
      SELECT benchmark_rpm FROM market_benchmarks
      WHERE equipment_group = $1 AND date <= CURRENT_DATE
      ORDER BY date DESC LIMIT 1
    `, [equipmentGroup]);
    
    const benchmarkRpm = benchResult.rows[0]?.benchmark_rpm 
      ? parseFloat(benchResult.rows[0].benchmark_rpm) 
      : (DEFAULT_BENCHMARKS[equipmentGroup] || 2.00);
    
    // Calculate quote using the pricing logic
    const quote = calculateQuote({
      distanceMiles: miles,
      loadType,
      isBackhaulSaver: isBackhaulSaver === 'true',
      benchmarkRpm,
      equipment,
    });
    
    res.json(quote);
    
  } catch (error) {
    console.error('Quote calculation error:', error);
    res.status(500).json({ error: 'Failed to calculate quote' });
  }
});

// ============================================
// PRICING CALCULATION LOGIC
// (Also exported for use in other routes)
// ============================================
function calculateQuote({
  distanceMiles,
  loadType = 'standard',
  isBackhaulSaver = false,
  benchmarkRpm = 2.00,
  equipment = null,
}) {
  // Load type config
  const LOAD_TYPES = {
    standard: { baseFee: 150, urgencyMult: 1.0 },
    hotshot: { baseFee: 200, urgencyMult: 1.25 },
    emergency: { baseFee: 250, urgencyMult: 1.50 },
  };
  
  // Platform fee tiers
  const PLATFORM_FEE_TIERS = [
    { upTo: 500, pct: 0.15 },
    { upTo: 1500, pct: 0.12 },
    { upTo: Infinity, pct: 0.10 },
  ];
  const PLATFORM_FEE_MIN = 25;
  const PLATFORM_FEE_MAX = 250;
  
  // Backhaul discount
  const BACKHAUL_DISCOUNT = 0.80; // 20% off
  
  // Distance premium (short hauls cost more per mile)
  const getDistancePremium = (miles) => {
    if (miles <= 50) return 1.35;
    if (miles <= 100) return 1.20;
    if (miles <= 200) return 1.10;
    return 1.0;
  };
  
  // Minimum charges
  const getMinCharge = (miles) => {
    if (miles <= 25) return 200;
    if (miles <= 50) return 275;
    if (miles <= 100) return 350;
    return 0;
  };
  
  const loadConfig = LOAD_TYPES[loadType] || LOAD_TYPES.standard;
  const distancePremium = getDistancePremium(distanceMiles);
  
  // Calculate rate per mile
  // Standard targets ~0-5% below benchmark
  // Backhaul targets ~10-25% below benchmark
  let marketAdjustment = 0.97; // 3% below benchmark for standard
  if (isBackhaulSaver && loadType === 'standard') {
    marketAdjustment = 0.82; // 18% below benchmark for backhaul
  } else if (loadType === 'hotshot') {
    marketAdjustment = 1.15; // 15% above benchmark
  } else if (loadType === 'emergency') {
    marketAdjustment = 1.35; // 35% above benchmark
  }
  
  const ratePerMile = benchmarkRpm * marketAdjustment * distancePremium * loadConfig.urgencyMult;
  
  // Calculate totals
  const baseFee = loadConfig.baseFee;
  const mileageCharge = ratePerMile * distanceMiles;
  let subtotal = baseFee + mileageCharge;
  
  // Apply minimum charge
  const minCharge = getMinCharge(distanceMiles);
  const minChargeApplied = Math.max(0, minCharge - subtotal);
  let totalBeforeDiscount = Math.max(subtotal, minCharge);
  
  // Apply backhaul discount
  let total = totalBeforeDiscount;
  let backhaulDiscountAmount = 0;
  if (isBackhaulSaver && loadType === 'standard') {
    backhaulDiscountAmount = totalBeforeDiscount * (1 - BACKHAUL_DISCOUNT);
    total = totalBeforeDiscount * BACKHAUL_DISCOUNT;
  }
  
  // Calculate platform fee
  const feeTier = PLATFORM_FEE_TIERS.find(t => total <= t.upTo) || PLATFORM_FEE_TIERS[2];
  let platformFee = total * feeTier.pct;
  platformFee = Math.min(PLATFORM_FEE_MAX, Math.max(PLATFORM_FEE_MIN, platformFee));
  
  const driverPayout = total - platformFee;
  
  // Round all money values
  const round = (n) => Math.round(n * 100) / 100;
  
  return {
    // Input echo
    distanceMiles,
    loadType,
    equipment,
    isBackhaulSaver: isBackhaulSaver && loadType === 'standard',
    
    // Breakdown
    baseFee: round(baseFee),
    benchmarkRpmUsed: round(benchmarkRpm),
    ratePerMile: round(ratePerMile),
    mileageCharge: round(mileageCharge),
    distancePremium: round(distancePremium),
    urgencyMultiplier: round(loadConfig.urgencyMult),
    minChargeApplied: round(minChargeApplied),
    subtotal: round(subtotal),
    totalBeforeDiscount: round(totalBeforeDiscount),
    backhaulDiscountAmount: round(backhaulDiscountAmount),
    
    // Final numbers
    total: round(total),
    platformFee: round(platformFee),
    platformFeePct: Math.round(feeTier.pct * 100),
    driverPayout: round(driverPayout),
  };
}

// Export for use in loads.js
module.exports = router;
module.exports.calculateQuote = calculateQuote;
module.exports.EQUIPMENT_TO_GROUP = EQUIPMENT_TO_GROUP;
module.exports.DEFAULT_BENCHMARKS = DEFAULT_BENCHMARKS;

// ============================================
// FUTURE: AI/Scrape Integration Point
// ============================================
// To add automated benchmark updates:
// 1. Create a scheduled job (cron) that runs daily
// 2. Job calls: POST /api/rates/benchmarks/update-from-source
// 3. That endpoint would:
//    - Fetch data from DAT/Truckstop API (or scrape public pages)
//    - Parse the response into equipment_group -> rpm mapping
//    - Call the bulk update endpoint
//    - Log success/failure
//
// Example future endpoint stub:
// router.post('/benchmarks/update-from-source', authenticate, requireAdmin, async (req, res) => {
//   const { source } = req.body; // 'dat_api' | 'truckstop_api' | 'scrape'
//   
//   // TODO: Implement based on source
//   // const data = await MarketDataProvider.fetch(source);
//   // await updateBenchmarksFromData(data);
//   
//   res.json({ message: 'Not implemented yet' });
// });
