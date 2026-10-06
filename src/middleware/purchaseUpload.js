const path = require('path');
const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('../config/cloudinary');
const ApiError = require('../utils/ApiError');

const MAX_FILES = 5;
const MAX_MB = 10;
const FOLDER = 'six-star-pos/purchase-invoices';

const ALLOWED = new Set([
  'application/pdf',
  'image/jpeg', 'image/png', 'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv', 'text/plain',
]);

const storage = new CloudinaryStorage({
  cloudinary,
  params: (req, file) => {
    const { name, ext } = path.parse(file.originalname);
    const safe = name.replace(/[^\w-]+/g, '_').slice(0, 60) || 'invoice';
    const id = `${Date.now()}-${safe}`;
    if (file.mimetype.startsWith('image/')) {
      return { folder: FOLDER, resource_type: 'image', public_id: id, transformation: [{ width: 2000, height: 2000, crop: 'limit' }] };
    }
    return { folder: FOLDER, resource_type: 'raw', public_id: `${id}${ext.toLowerCase()}` };
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_MB * 1024 * 1024, files: MAX_FILES },
  fileFilter: (req, file, cb) =>
    ALLOWED.has(file.mimetype)
      ? cb(null, true)
      : cb(ApiError.badRequest('Allowed: PDF, images, Word, Excel, CSV or TXT', 'INVALID_FILE_TYPE')),
});

const handler = upload.array('invoices', MAX_FILES);

function uploadPurchaseInvoices(req, res, next) {
  handler(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `Each file must be under ${MAX_MB}MB`
        : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE' ? `You can attach up to ${MAX_FILES} files`
        : err.message;
      return next(ApiError.badRequest(msg, 'UPLOAD_ERROR'));
    }
    return next(err);
  });
}

module.exports = { uploadPurchaseInvoices };