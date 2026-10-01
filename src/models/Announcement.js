/**
 * Announcement - PLATFORM-level (not tenant-scoped, so no businessId).
 * Created by SUPER_ADMIN, shown to tenant users by role + page.
 */
const { Schema, model } = require('mongoose');
const {
  ANNOUNCEMENT_TYPES,
  ANNOUNCEMENT_DISPLAYS,
  ANNOUNCEMENT_FREQUENCIES,
  ANNOUNCEMENT_PAGES,
  TARGETABLE_ROLES,
} = require('../constants/announcement');

const placementSchema = new Schema(
  {
    page: { type: String, enum: ANNOUNCEMENT_PAGES, required: true },
    display: { type: String, enum: ANNOUNCEMENT_DISPLAYS, required: true }, // MODAL = pop-up, TICKER = scrolling bar
  },
  { _id: false }
);

const announcementSchema = new Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 120 },
    message: { type: String, required: true, trim: true, maxlength: 1000 },
    type: { type: String, enum: ANNOUNCEMENT_TYPES, default: 'INFO' },

    // Empty array = everyone.
    roles: [{ type: String, enum: TARGETABLE_ROLES }],

    placements: {
      type: [placementSchema],
      validate: [(v) => Array.isArray(v) && v.length > 0, 'At least one page is required'],
    },

    // MODAL only: ONCE = until the user dismisses it, EVERY_VISIT = each time the page opens.
    frequency: { type: String, enum: ANNOUNCEMENT_FREQUENCIES, default: 'ONCE' },

    startsAt: { type: Date, default: Date.now },
    endsAt: { type: Date }, // missing = runs until paused/deleted
    isActive: { type: Boolean, default: true }, // manual pause switch

    // Bumped when the wording changes (or "show again" is ticked) so people who
    // already dismissed an earlier version see it again.
    version: { type: Number, default: 1 },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    createdByName: { type: String },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

announcementSchema.index({ isActive: 1, startsAt: 1, endsAt: 1 });
announcementSchema.index({ 'placements.page': 1 });
announcementSchema.index({ createdAt: -1 });

module.exports = model('Announcement', announcementSchema);