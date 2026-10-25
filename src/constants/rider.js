/** Constants for the rider delivery + live tracking module. */
const COLLECTION_STATUS = ['AWAITING_MPESA', 'HELD', 'PAID', 'HANDED_OVER', 'CANCELLED'];
// statuses that mean "the customer's money for this order is accounted for"
const COLLECTION_ACTIVE = ['HELD', 'PAID', 'HANDED_OVER'];

const DEFAULTS = Object.freeze({
  alertDistancesM: [500, 200, 100, 50],   // the customer is told when the rider gets this close (metres)
  arrivalRadiusM: 40,                     // inside this the rider's app is nudged to press "Arrived"
  staleAfterSec: 90,                      // a position older than this is shown as "last seen"
  offlineAfterSec: 180,                   // no ping for this long -> the rider counts as offline
  minAccuracyForAlertsM: 120,             // a ping less accurate than this never triggers an alert
  fallbackSpeedKmh: 20,                   // motorbike in town, used when the phone reports no speed
  trailMinMoveM: 15, trailMinSeconds: 30, // how often a point is kept for the route line
  trailKeepDays: 7,
  cashHeldWarnHours: 4,                   // remind the cashier when a rider has held cash this long
});

const RIDER_STAGES = ['ASSIGNED', 'PICKED_UP', 'ON_THE_WAY', 'ARRIVED', 'DELIVERED', 'FAILED'];
module.exports = { COLLECTION_STATUS, COLLECTION_ACTIVE, DEFAULTS, RIDER_STAGES };
