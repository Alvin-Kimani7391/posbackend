/** In-memory upload of one spreadsheet export (.csv / .txt, up to 3MB). Field name: "file". Excel files: save as CSV first, or let the app send the rows. */
const multer = require('multer');
const ApiError = require('../utils/ApiError');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 3 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => (/\.(csv|txt)$/i.test(file.originalname) || /csv|text\/plain|excel/.test(file.mimetype) ? cb(null, true) : cb(ApiError.badRequest('Upload a .csv file (in Excel: Save As > CSV)', 'INVALID_FILE_TYPE'))) });
const handler = upload.single('file');
module.exports = (req, res, next) => handler(req, res, (err) => {
  if (!err) return next();
  if (err instanceof multer.MulterError) return next(ApiError.badRequest(err.code === 'LIMIT_FILE_SIZE' ? 'File is too big (3MB max). Split it.' : err.message, 'UPLOAD_ERROR'));
  return next(err);
});
