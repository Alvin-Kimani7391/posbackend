/**
 * Language resolution (English / Kiswahili) for API messages.
 *
 * Priority, highest first:
 *   1. an explicit choice from the app:  header  X-Lang: sw   or query  ?lang=sw
 *   2. the signed-in user's own language           (set by authenticate)
 *   3. the business's default language              (set by authenticate)
 *   4. the browser/device Accept-Language header
 *   5. English
 * Sets req.lang ('en' | 'sw') and req.langExplicit (true when the app asked for it).
 */
const { normalizeLanguage, LANGUAGES } = require('../constants/countries');

function firstSupported(acceptLanguage) {
  if (!acceptLanguage) return null;
  for (const part of String(acceptLanguage).split(',')) {
    const tag = part.trim().slice(0, 2).toLowerCase();
    if (LANGUAGES.includes(tag)) return tag;
  }
  return null;
}

function languageMiddleware(req, res, next) {
  const explicit = req.headers['x-lang'] || (req.query && req.query.lang);
  if (explicit && LANGUAGES.includes(String(explicit).slice(0, 2).toLowerCase())) {
    req.lang = normalizeLanguage(explicit);
    req.langExplicit = true;
  } else {
    req.lang = firstSupported(req.headers['accept-language']) || 'en';
    req.langExplicit = false;
  }
  res.setHeader('Content-Language', req.lang);
  next();
}

module.exports = languageMiddleware;
