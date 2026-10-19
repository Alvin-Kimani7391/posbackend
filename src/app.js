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
    origin: frontendUrl === '*' ? true : frontendUrl.split(','),
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

app.use('/health', healthRoutes);
app.use('/api/v1', publicApiLimiter, v1Routes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;