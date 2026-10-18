# Restaurant + Accommodation + Guest QR
- Owner picks `serviceMode`: RESTAURANT, ACCOMMODATION or BOTH (RestaurantSettings).
- Table/room QR codes: GET /api/v1/accommodation/qr (URLs; frontend renders image). Guest app opens `<GUEST_APP_URL>/q/<token>`; public API at /api/v1/public/qr/*.
- Guest modes per table/room: OFF, MENU_ONLY, ORDER_CONFIRM, ORDER_AUTO. Waiter can call-and-enter orders or claim QR orders.
- Rooms: stays RESERVED > CHECKED_IN > CHECKED_OUT; owner sets check-in/out times, early/late fee tiers, deposits, cancellation, no-show, self check-in/out.
- Room orders post to the folio; bill method ROOM charges the stay.
- Env (optional): QR_SECRET, GUEST_APP_URL. Existing restaurants: run scripts/migrate-feature-settings.js --apply.
- Not run against MongoDB; no guest frontend included.
