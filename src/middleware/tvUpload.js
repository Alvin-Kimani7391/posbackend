/** Image uploads for TV slides (field "image", 1 file, JPG/PNG/WEBP, 8MB). Resized to max 1920px for 1080p/4K screens. */
const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('../config/cloudinary');
const ApiError = require('../utils/ApiError');
const up = multer({
  storage: new CloudinaryStorage({ cloudinary, params: (req) => ({ folder: `six-star-pos/tv/${req.businessId}`, allowed_formats: ['jpg', 'jpeg', 'png', 'webp'], transformation: [{ width: 1920, height: 1920, crop: 'limit', quality: 'auto', fetch_format: 'auto' }] }) }),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => (/^image\/(jpe?g|png|webp)$/.test(file.mimetype) ? cb(null, true) : cb(ApiError.badRequest('Only JPG, PNG or WEBP images are allowed', 'INVALID_FILE_TYPE'))),
}).single('image');
module.exports = { uploadTvImage: (req, res, next) => up(req, res, (err) => {
  if (!err) return next();
  if (err instanceof multer.MulterError) return next(ApiError.badRequest(err.code === 'LIMIT_FILE_SIZE' ? 'Image must be under 8MB' : err.message, 'UPLOAD_ERROR'));
  return next(err);
}) };
