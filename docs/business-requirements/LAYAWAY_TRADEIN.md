# Layaway and trade-ins

Feature flags: `layaway` (on by default for electronics, clothing, general shop) and `tradeIn` (electronics). Permissions: `layaways.view/manage/approve`, `tradeins.view/manage/approve`.

## Layaway (`/api/v1/layaways`)
Reserve stock or specific serial numbers, lock prices, take a deposit (default minimum 20%), then instalments. Reserved units stay in the shop and in stocktake counts but cannot be sold, transferred or adjusted away. Collecting creates a normal invoice (sales reports, receipt, eTIMS where it exists); cancelling by the customer keeps a configurable fee (default 10%, as its own invoice) and refunds the rest. Batch/expiry-tracked products cannot go on layaway.
Payments: `CASH`, `MPESA` (verified, Kenya only), `MOBILE_MONEY` with `provider` + `reference` (Tanzania and anywhere without PayHero), `CARD`, `BANK`, `OTHER`.
Settings: `Business.layawaySettings` (`minDepositPercent`, `maxDays`, `cancellationFeePercent`, `graceDays`). SMS reminders (Kenya SMS only): `smsAlerts.layawayDue`.

## Trade-ins (`/api/v1/trade-ins`)
Appraise (IMEI/serial checked, ID and ownership declaration recorded), accept, then use in a sale with `tradeIns: [id]`. The device is received into used stock, its value is a `TRADE_IN` payment (no money moves), and the shop warranty starts on resale. Cancelling the sale hands the device back if it is still in stock; a sale with a trade-in cannot be refunded line by line.
Approval limit: `Business.tradeInSettings.approvalAboveCents`; unset means KES 30,000 in Kenya and TZS 600,000 in Tanzania. Also `validDays` (7) and `warrantyMonths` (3).

## Stock rule change
Selling or adjusting retail stock now only takes `quantity - reservedQuantity`, so reserved layaway units can never be sold by a till.