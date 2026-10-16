# Tanzania support (Kenya + Tanzania, English + Kiswahili)

## Onboarding
- `GET /api/v1/meta/countries` (public) -> countries (currency, default language, VAT rate, tax-id label, shift-close
  denominations, mobile-money options, which integrations exist) and the supported languages.
- `POST /api/v1/auth/register` now takes `country` (`"KE"` | `"TZ"`, default KE) and optional `language` (`"en"` | `"sw"`;
  default en for Kenya, sw for Tanzania). The phone is validated for the chosen country.
  The business gets its currency (KES / TZS), timezone, VAT default, payment methods and offline limits from the country.
- `PUT /api/v1/business/country` (owner only) fixes a wrongly chosen country, only while the business has no money data.

## Language
- Per request: header `X-Lang: sw` or `?lang=sw`. Otherwise the user's own language, then the business default, then Accept-Language.
- `PUT /api/v1/auth/language` saves the signed-in user's language. Receipts, invoices, notifications and API errors follow it.

## Money and books
- One business = one currency; every stored amount is in it (integer minor units, as before), so books always balance.
- Each shift is stamped with its currency when opened. `GET /api/v1/shifts/denominations` returns the notes/coins to count
  (KES 1000..1, TZS 10000, 5000, 2000, 1000, 500, 200, 100, 50). Closing validates against the shift's currency; expected cash,
  counted cash and over/short are computed in that currency. Reports carry `currency` and `countryCode`.
- Invoices/receipts: TZS formatting, amount in words in Swahili or English, TIN / VRN instead of KRA PIN.

## Kenya-only features
M-PESA (PayHero), KRA eTIMS and the Kenyan SMS sender routes return a clear error for Tanzanian businesses
(`requireCountry('KE')`). Tanzanian businesses use `MOBILE_MONEY` payments (M-Pesa TZ, Tigo Pesa, Airtel Money, HaloPesa) recorded with a provider and reference.

## Subscription billing in TZS
- Plans have a `currency`. `standard` stays in KES; a new `standard-tz` plan (TZS, placeholder prices - edit in the admin plan editor)
  is created automatically. A business is only ever put on a plan of its own currency (`PLAN_CURRENCY_MISMATCH` otherwise).
  Subscriptions, invoices and payments each store their `currency`; legacy documents without one are KES.
- Platform settings: `defaultPlanKeyTZ` (default `standard-tz`) and `manualTz` (the Tanzanian Lipa Namba / bank details shown to
  Tanzanian owners). **Fill `manualTz` in the admin billing settings before turning billing on for Tanzania.**
- Kenya keeps PayHero STK + pasted M-PESA message. Tanzania has no STK: `POST /billing/payments/stk` returns
  `BILLING_STK_UNAVAILABLE_COUNTRY`; the owner pays to the `manualTz` number and submits `POST /billing/payments/manual`
  with `mpesaMessage` and/or `transactionCode` (+ optional `provider`). A platform admin approves/rejects as before.
- `GET /billing/overview` and `/billing/status` return `currency`; `paymentOptions` follows the business currency.
  Billing amounts remain integer cents. Admin overview totals are per currency (`byCurrency`), never mixed.
- Invoices, reminders and emails show TZS for Tanzanian businesses.

## Existing users: choose a country + flag
- Accounts created before Tanzania support have `countryConfirmed = false`. `GET /auth/me`, login responses and
  `GET /business/profile` return `needsCountrySelection: true` for them, plus `flag` (emoji) and `flagCode` (`ke` / `tz`).
- The owner picks with `PUT /business/country { countryCode, language? }`. Choosing the current country (Kenya) just confirms it.
  Switching to Tanzania is allowed only while the business has no sales/products/shifts AND no subscription invoices or payments
  (otherwise `COUNTRY_LOCKED` / `COUNTRY_LOCKED_BILLING` - the amounts already stored are in KES and would be mislabelled).
  When it switches, the not-yet-invoiced subscription is moved to the TZS plan keeping the trial dates.
- `frontend/country-flag.js` + `country-flag.css`: drop-in module that draws the flag in the header and shows the one-time picker.

