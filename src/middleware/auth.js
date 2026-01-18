// Authentication Middleware - Fixed to match schema
const jwt = require('jsonwebtoken');
const config = require('../config');
const { pool } = require('../db/pool');

// Verify JWT token
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'Authentication required',
        code: 'NO_TOKEN'
      });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, config.jwt.secret);

    // Fetch fresh user data
    const result = await pool.query(
      'SELECT id, email, phone, first_name, last_name, role, is_verified, is_active FROM users WHERE id = $1',
      [decoded.userId]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        error: 'User not found',
        code: 'USER_NOT_FOUND'
      });
    }

    const user = result.rows[0];

    if (!user.is_active) {
      return res.status(403).json({
        error: 'Account deactivated',
        code: 'ACCOUNT_DEACTIVATED'
      });
    }

    // Add computed name for convenience
    user.name = `${user.first_name} ${user.last_name}`.trim();
    user.user_type = user.role; // Alias for compatibility

    req.user = user;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        error: 'Token expired',
        code: 'TOKEN_EXPIRED'
      });
    }
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        error: 'Invalid token',
        code: 'INVALID_TOKEN'
      });
    }
    console.error('[Auth] Error:', error);
    return res.status(500).json({ error: 'Authentication failed' });
  }
};

// Require specific user type (role)
const requireUserType = (...types) => {
  return (req, res, next) => {
    if (!types.includes(req.user.role)) {
      return res.status(403).json({
        error: `Access restricted to ${types.join(' or ')}`,
        code: 'FORBIDDEN_USER_TYPE'
      });
    }
    next();
  };
};

// Require verified user (for drivers)
const requireVerified = async (req, res, next) => {
  if (req.user.role === 'driver') {
    const result = await pool.query(
      'SELECT is_available FROM driver_profiles WHERE user_id = $1',
      [req.user.id]
    );
    // For now, just check profile exists
    if (result.rows.length === 0) {
      return res.status(403).json({
        error: 'Driver profile required',
        code: 'DRIVER_PROFILE_MISSING'
      });
    }
  }
  next();
};

// Require admin role
const requireAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({
      error: 'Admin access required',
      code: 'ADMIN_REQUIRED'
    });
  }
  next();
};

// Require dispatcher role
const requireDispatcher = (req, res, next) => {
  if (req.user.role !== 'dispatcher' && req.user.role !== 'admin') {
    return res.status(403).json({
      error: 'Dispatcher access required',
      code: 'DISPATCHER_REQUIRED'
    });
  }
  next();
};

// Generate tokens
const generateToken = (userId) => {
  return jwt.sign({ userId }, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn
  });
};

module.exports = {
  authenticate,
  requireUserType,
  requireVerified,
  requireAdmin,
  requireDispatcher,
  generateToken,
};
