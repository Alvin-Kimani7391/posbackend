/**
 * Image uploads for menu items and room types. Streamed to Cloudinary (same pattern as ticketUpload).
 * Menu item field: "image" (1 file). Room type field: "images" (up to 8). JPG/PNG/WEBP, 5MB each.
 * Images are resized (max 1200px) and auto-optimised for fast guest-QR menus.
 */
const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('../config/cloudinary');
const ApiError = require('../utils/ApiError');

const MAX_MB = 5;
const mk = (folder) => multer({
  storage: new CloudinaryStorage({ cloudinary, params: (req) => ({
    folder: `six-star-pos/${folder}/${req.businessId}`,
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
    transformation: [{ width: 1200, height: 1200, crop: 'limit', quality: 'auto', fetch_format: 'auto' }],
  }) }),
  limits: { fileSize: MAX_MB * 1024 * 1024, files: 8 },
  fileFilter: (req, file, cb) => (/^image\/(jpe?g|png|webp)$/.test(file.mimetype) ? cb(null, true)
    : cb(ApiError.badRequest('Only JPG, PNG or WEBP images are allowed', 'INVALID_FILE_TYPE'))),
});
const wrap = (handler) => (req, res, next) => handler(req, res, (err) => {
  if (!err) return next();
  if (err instanceof multer.MulterError) return next(ApiError.badRequest(err.code === 'LIMIT_FILE_SIZE' ? `Each image must be under ${MAX_MB}MB` : err.message, 'UPLOAD_ERROR'));
  return next(err);
});

module.exports = {
  uploadMenuImage: wrap(mk('menu').single('image')),
  uploadRoomTypeImages: wrap(mk('rooms').array('images', 8)),
  uploadRoomImages: wrap(mk('rooms').array('images', 8)),     // used by the add-room / add-room-type forms: upload first, the links are saved with the room
};
