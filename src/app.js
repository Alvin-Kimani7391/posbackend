const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const mongoSanitize = require('express-mongo-sanitize');

const { frontendUrl } = require('./config/env');
const requestContext = require('./middleware/requestContext');
const languageMiddleware = require('./middleware/language');
const { publicApiLimiter } = require('./middleware/rateLimiters');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const healthRoutes = require('./routes/health.routes');
const v1Routes = require('./routes/v1');

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1); // needed for correct req.ip behind Render's proxy

app.use(helmet());
try { app.use(require('compression')()); } catch (e) { console.warn('compression not installed - run npm install'); } // gzip: the menu / floor JSON shrinks ~5-10x
app.use(
  cors({
    // trim spaces and trailing "/" so "https://a.com, https://b.com/" still matches the browser's Origin header
    origin: frontendUrl === '*' ? true : frontendUrl.split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean),
    credentials: true,
  })
);

app.use('/api/v1/sync', express.json({ limit: '4mb' })); // a later global parser skips bodies already parsed


app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cookieParser());
app.use(mongoSanitize()); // strips $ and . from req.body/query/params keys -> blocks NoSQL injection
app.use(requestContext);
app.use(languageMiddleware);

if (process.env.NODE_ENV !== 'test') {
  app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
}

// /health is public and holds no secrets: let ANY site (www, vercel preview, new domain) read it, so the app's
// "am I online?" check can never be blocked by a CORS / helmet setting and wrongly show "You are offline".
app.use('/health', (req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  res.set('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use('/health', healthRoutes);
app.use(require('./middleware/maintenance'));
app.use('/api/v1', publicApiLimiter, v1Routes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;