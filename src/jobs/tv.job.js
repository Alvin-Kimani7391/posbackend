const cron = require('node-cron');
function start() {
  cron.schedule('* * * * *', async () => { try { await require('../services/tv/tv.service').sweep(); } catch (e) { console.error('[tv job] sweep failed:', e.message); } });
}
module.exports = { start };
