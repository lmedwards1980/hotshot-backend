// S3 Upload Service
const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const BUCKET_NAME = process.env.S3_BUCKET_NAME || 'hotshot-files-uploads';

/**
 * Upload a file to S3
 * @param {Buffer} fileBuffer - The file buffer
 * @param {string} originalName - Original filename
 * @param {string} folder - Folder path in S3 (e.g., 'documents', 'profiles')
 * @param {string} contentType - MIME type
 * @returns {Promise<{url: string, key: string}>}
 */
async function uploadToS3(fileBuffer, originalName, folder = 'uploads', contentType = 'application/octet-stream') {
  const ext = path.extname(originalName) || '.jpg';
  const key = `${folder}/${uuidv4()}${ext}`;

  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    Body: fileBuffer,
    ContentType: contentType,
  });

  await s3Client.send(command);

  // Generate a long-lived signed URL (7 days)
  const url = await getSignedUrl(s3Client, new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
  }), { expiresIn: 604800 }); // 7 days
  
  console.log('[S3] Uploaded key:', key);
  console.log('[S3] Signed URL:', url.substring(0, 100) + '...');

  // Return both the key (for storage) and the signed URL
  return { url, key };
}

/**
 * Get a fresh signed URL for an S3 key
 * @param {string} key - The S3 object key
 * @param {number} expiresIn - URL expiration in seconds (default 7 days)
 * @returns {Promise<string>}
 */
async function getSignedS3Url(key, expiresIn = 604800) {
  if (!key) return null;
  
  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
  });
  
  return await getSignedUrl(s3Client, command, { expiresIn });
}

/**
 * Convert a stored URL/key to a fresh signed URL
 * @param {string} urlOrKey - Either a full S3 URL or just the key
 * @returns {Promise<string|null>}
 */
async function refreshSignedUrl(urlOrKey) {
  if (!urlOrKey) return null;
  
  let key = urlOrKey;
  
  // If it's a full URL, extract the key
  if (urlOrKey.includes('amazonaws.com')) {
    try {
      const urlObj = new URL(urlOrKey);
      key = urlObj.pathname.slice(1); // Remove leading slash
    } catch (e) {
      // If URL parsing fails, try using it as a key
    }
  }
  
  // If it starts with http but isn't S3, return as-is
  if (urlOrKey.startsWith('http') && !urlOrKey.includes('amazonaws.com') && !urlOrKey.includes('X-Amz')) {
    return urlOrKey;
  }
  
  return await getSignedS3Url(key);
}

/**
 * Delete a file from S3
 * @param {string} key - The S3 object key
 */
async function deleteFromS3(key) {
  const command = new DeleteObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
  });

  await s3Client.send(command);
}

/**
 * Extract S3 key from full URL
 * @param {string} url - Full S3 URL
 * @returns {string} - S3 key
 */
function getKeyFromUrl(url) {
  const urlObj = new URL(url);
  return urlObj.pathname.slice(1); // Remove leading slash
}

module.exports = {
  uploadToS3,
  deleteFromS3,
  getKeyFromUrl,
  getSignedS3Url,
  refreshSignedUrl,
  s3Client,
  BUCKET_NAME,
};
