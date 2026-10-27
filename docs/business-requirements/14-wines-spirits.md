# Wines & Spirits (`wines_spirits`)

Liquor stores, bottle shops, wine shops and bar-restaurants that sell by the bottle and by the tot. **Every legal limit here is an owner setting. The defaults are starting points, not legal advice: confirm hours, minimum age, licence terms and dry days with your county / regulator (Kenya: county liquor board; Tanzania: TRA / local authority).**

## What the module does
| Need | How |
|---|---|
| Licence on file and valid | Number, issuer, expiry. Expired licence blocks alcohol sales (owner can turn the block off). Warning N days before expiry. |
| Trading hours + dry days | Per weekday window (can run past midnight), closed weekdays, list of closed dates (elections, notices). Enforced by the server inside `POST /sales`. Manager can override with a reason; every override is logged. |
| Age check | Every alcohol sale needs an age check (`ageCheck`). Modes: cashier confirms, or ID required (type + last 4, or date of birth). Under-age refusals are logged too. No full ID number and no date of birth is stored. |
| Per-sale limit | Optional cap on bottles per sale (manager override with reason). |
| Product facts | Category, ABV, volume, vintage, country, producer, excise per unit (optional), container. Non-alcohol items (mixers, snacks) skip the alcohol rules. |
| Cases / crates / bottles | Normal unit conversions on the product (1 case = 12 bottles). |
| Returnable bottles and crates | Container types with deposit. Selling sends containers out; empties come back with a sale or through a walk-in refund. Modes: OFF / TRACK / ENFORCE (deposit lines must equal sold minus returned). Balances: with customers, in shop, owed to suppliers. |
| Tots | A tot product draws millilitres from an open bottle; opening a bottle takes 1 from stock in the same transaction as the sale. Cancel puts the tots back. Dip counts, waste and comps log variance. Tot cost and suggested price come from the bottle. |
| Reports | Litres and pure alcohol by category/product, excise included (estimate), age-check log, override log, tot variance, compliance overview. |

## Rules enforced on the server
1. Hours, dry day, licence and limit checks run in `createSale` before anything is saved.
2. Age check is mandatory when the cart has alcohol and `ageVerification` is on. A refused check is saved even though the sale fails.
3. Offline sales cannot be refused after the fact: they are flagged for review (outside hours, no age check, tots sold).
4. Tot lines never have their own stock; they only move the open-bottle pool.
5. Deposits are ordinary receipt lines of a "deposit product" (tax exempt), so cash, M-PESA and receipts need no special case.

## Not included
- Excise duty returns / stamps, and county licence renewals are not filed by the system.
- No delivery age-verification flow (the delivery feature exists separately).
- Refunds do not return tots to the pool (a poured drink cannot be put back); cancel the sale instead.
- Not run against MongoDB.
