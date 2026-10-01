/**
 * Screenshot uploads for support tickets. Same pattern as your other
 * Cloudinary uploads: streamed straight to Cloudinary, nothing touches disk.
 * Field name: "screenshots" (up to 5 images, 5MB each).
 * Wrapped so multer errors become clean API errors instead of 500s.
 */
const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('../config/cloudinary');
const ApiError = require('../utils/ApiError');

const MAX_FILES = 5;
const MAX_MB = 5;

const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'six-star-pos/tickets',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
    transformation: [{ width: 1600, height: 1600, crop: 'limit' }],
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_MB * 1024 * 1024, files: MAX_FILES },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpe?g|png|webp)$/.test(file.mimetype)) return cb(null, true);
    return cb(ApiError.badRequest('Only JPG, PNG or WEBP screenshots are allowed', 'INVALID_FILE_TYPE'));
  },
});

const handler = upload.array('screenshots', MAX_FILES);

function uploadTicketImages(req, res, next) {
  handler(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `Each screenshot must be under ${MAX_MB}MB`
        : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE' ? `You can attach up to ${MAX_FILES} screenshots`
        : err.message;
      return next(ApiError.badRequest(msg, 'UPLOAD_ERROR'));
    }
    return next(err);
  });
}

module.exports = { uploadTicketImages };
