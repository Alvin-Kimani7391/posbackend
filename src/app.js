const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const mongoSanitize = require('express-mongo-sanitize');

const { frontendUrl } = require('./config/env');
const requestContext = require('./middleware/requestContext');
const { publicApiLimiter } = require('./middleware/rateLimiters');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const healthRoutes = require('./routes/health.routes');
const v1Routes = require('./routes/v1');

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1); // needed for correct req.ip behind Render's proxy

app.use(helmet());
app.use(
  cors({
    origin: frontendUrl === '*' ? true : frontendUrl.split(','),
    credentials: true,
  })
);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cookieParser());
app.use(mongoSanitize()); // strips $ and . from req.body/query/params keys -> blocks NoSQL injection
app.use(requestContext);

if (process.env.NODE_ENV !== 'test') {
  app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
}

app.use('/health', healthRoutes);
app.use('/api/v1', publicApiLimiter, v1Routes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
