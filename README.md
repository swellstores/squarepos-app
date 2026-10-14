# Square POS for Swell

Connects a shop that sells with [Square Point of Sale](https://squareup.com/point-of-sale) to its Swell store. It does two things:

- **One stock.** The shop and the online store sell from the same stock. A sale, a delivery or a recount on either side reaches the other, usually within a minute.
- **One order history.** Each sale completed in Square becomes a paid order in Swell, on the customer's account when Swell knows the customer.

The app works with the merchant's own Square access token. Swell runs it: there is no other service between the store and Square. It never changes Square's catalog, orders or customers; in Square it writes stock adjustments only. In Swell it writes stock entries, the orders it imports with their payments and refunds, one account for walk-in customers, and one payment method, "Square POS", which is switched off for shoppers.

## Setup

1. Install the app from Apps in the Swell dashboard.
2. In the [Square Developer Console](https://developer.squareup.com/apps), create an application (any name), open its **Credentials** page, switch to **Production** and copy the **access token**. The token gives access to your whole Square account: treat it like a password.
3. In Swell, open Apps → Square POS → Settings, paste the token under **Square access token**, save, and press **Test connection**. It names the connected account and its locations, registers the notices Square sends to this store when stock or payments change, and adds the payment method "Square POS" that imported sales are recorded with (a manual method, switched off: shoppers never see it).
4. **Inventory.** If your Square account has several locations, enter the name of the one that shares its stock with the store, turn on **Keep the stock of linked items in sync**, and save. Choose **Match products** in the Actions menu, then open Products → Square stock: each Square item whose SKU a Swell product or variant has is listed as **Ready to start**, with the quantity on both sides. Select the items, choose **Start syncing**, and say which side has the right quantities. Nothing moves before an item is started. See "Stock".
5. **Sales.** Turn on **Import completed Square sales as orders**. Sales are imported from that moment on. For earlier sales choose **Import past sales** in the Actions menu. See "Sales".

Settings are separate for the store's test and live environments, and both start empty. To try the app without touching your shop, use the **Sandbox** access token of your Square application in the test environment and set **Square environment** to Sandbox. Do not connect the test environment to your production Square account: stock changes of test orders would reach your shop.

## Stock

### Which items share their stock

An item is linked when exactly one Square variation and exactly one Swell product or variant have the same SKU. Nothing is guessed: everything else is listed under **Not linked** with the reason.

| Not linked because | What to do |
| --- | --- |
| No Swell product or variant has the SKU | Give the Swell product the SKU of the Square item, then match again |
| More than one Square variation, or more than one Swell product or variant, has the SKU | Give each its own SKU |
| The Swell product or variant is linked to another Square item already (its SKU changed in Square after it was started, for example) | Stop the other item first |
| The Swell product has variants and the SKU is on the product | Stock is kept on the variants: give each variant its SKU |
| Square does not track stock for the item at the location | Turn on stock tracking in Square |
| The Swell product does not track stock | Turn on stock tracking for the product |
| Square sells the item by weight or measure | Only whole quantities can be shared |

Square variations without a SKU are not listed. Matching changes nothing in Square and moves no stock; run it again whenever you add products or SKUs. Items that are in sync are not touched by it.

### Starting an item

Starting is the one time a side wins. You say whether Square or Swell has the right quantity, and the other side receives the difference as a single stock adjustment ("Square POS: starting stock taken from Square" in Swell's stock history, received or removed stock in Square's). An item that Square has never counted can be started from Swell's quantity.

### What happens afterwards

Only changes travel, never totals. The app remembers the quantity both sides held after the last sync. What Swell has gained or lost since then is added to Square, and what Square has gained or lost is added to Swell. A sale at the till and an online order at the same moment therefore both count.

| Happens | Arrives as |
| --- | --- |
| In Square: a sale, a delivery, a recount, a loss, a restocked return | An entry in the product's stock history in Swell, marked "Square POS", with what happened when Square's history says so ("Square POS: 2 sold") |
| In Swell: an online order | An adjustment in Square: stock sold |
| In Swell: a canceled order, a restocked return, received stock | An adjustment in Square: stock received |
| In Swell: stock marked damaged or missing | An adjustment in Square: stock lost |

- **How fast.** Square announces a change within seconds, and Swell records its own at once; the sync that follows takes a few seconds more. Every five minutes the app also compares all linked items, whether or not a change was announced, so a lost notice costs minutes and not stock.
- **Selling the last unit on both sides at once** cannot be prevented by any sync. Both sides then show −1 and the item is listed under **Needs attention** as oversold until its stock is positive again.
- **A stopped item.** When an item can no longer be synced (its product was deleted, Square has no count for it any more, Square refuses the change) it stops, is listed under **Needs attention** with the reason, and the store's administrators get one e-mail. All other items go on. After correcting the cause, start the item again.
- **Stop syncing** ends the sharing for the selected items. Nothing changes on either side.

### Stock locations

One Square location shares its stock with the store. In a Swell store that keeps stock by location, enter the name of the Swell location under **Swell stock location**: the Square location is then paired with that one. Left empty, it is paired with the store's stock as a whole. After changing either location, items stop and have to be started again, since another location holds other quantities.

## Sales

Each completed Square order at the chosen locations becomes one Swell order.

- **The receipt, to the cent.** Lines with name, variation, quantity and price; the discounts and taxes Square charged; tips, service charges and cash rounding as lines of their own. The order's total is what the customer paid. A sale whose lines do not add up to Square's total is not imported and is listed with the reason.
- **Paid, and silent.** Each Square payment of the sale is recorded on the order as a payment with the method "Square POS" (Square has the money; nothing is charged in Swell), so the order shows as paid, and it needs no fulfillment. No e-mail goes to the customer or to the staff. Other apps and webhooks are not told about it unless you turn on **Let other apps and webhooks react to imported orders**.
- **No stock is taken.** The lines carry names and amounts, not products, so the order cannot change stock: the stock sync passes on what Square counted. One side effect: Swell's sales reports by product do not include till sales.
- **Order numbers** start with `SQ-` followed by Square's receipt number, so till sales are recognised in every list and the store's own numbering is not used up.
- **The customer.** When the sale has a Square customer with an e-mail address and a Swell account has that address, the order goes to that account. All other sales go to one account named "Walk-in customer (Square POS)". The app never creates a customer from a Square profile.
- **Refunds.** A refund made in Square is recorded as a refund of the order's Square POS payment, so the order shows as partly refunded or refunded. Stock follows Square's count when the goods are restocked there.
- **Not imported:** exchanges (a sale and returned items on one receipt), and sales that an online checkout took through Square's payment API, since that checkout keeps its own orders. Both are listed under **Skipped**.

Orders → Square sales lists every sale with its order. On an order, the **Square POS** tab shows the receipt number, the location, how it was paid and what was refunded.

## In the dashboard

| Where | What |
| --- | --- |
| Apps → Square POS → Settings | Connection, Inventory and Sales settings; **Test connection** |
| Actions menu on that page | **Sync now**, **Match products**, **Import past sales**, **Retry failed sales** |
| Products → Square stock | The linked items with both quantities and the last change. Tabs: Needs attention, In sync, Ready to start, Not linked. **Start syncing** and **Stop syncing** on selected items or on one item |
| Orders → Square sales | The sales and their orders. Tabs: Needs attention, Imported, Refunded, Skipped. **Retry** and **Mark as resolved** |
| Orders, tab Square POS | The orders imported from Square |

## When something goes wrong

| What you see | Why, and what to do |
| --- | --- |
| E-mail "Square POS is not syncing" | Square refused the access token, or a location named in the settings does not exist. Correct it in the settings and press Test connection. Nothing is lost: when the connection works again, the changes of each side since the last sync are passed to the other, and the sales made meanwhile are imported |
| E-mail "Square's notices have stopped" | Square switches its notices off when they fail for a long time. Press Test connection to switch them on again. Meanwhile changes are found every five minutes |
| An item under Needs attention | The note says what stopped it. Correct the cause and start the item again |
| A sale under Needs attention | The problem is on the sale. **Retry** after correcting the cause, or **Mark as resolved** after recording the sale by hand |
| A sale under Needs attention: "Swell has no payment method Square POS" | The method was removed under Settings → Payments. Press Test connection, which adds it again, then **Retry** |
| Stock differs between Square and Swell for a linked item | It should not for longer than five minutes. Choose **Sync now**. If the item is under Needs attention, see above |
| Test connection: "did not accept the access token" | The token was replaced in Square, or **Square environment** does not match it: a sandbox token works only with Sandbox |

## Limits and known issues

- **The merchant's own token.** The app does not use Square's OAuth sign-in. You create a Square application yourself and paste its token, which has access to your whole Square account and is stored in the store's settings.
- **No catalog sync.** Products are not created or changed on either side. Items are linked by the SKUs you keep.
- **One location for stock.** Sales can be imported from any number of locations.
- **Whole quantities.** Items sold by weight or measure are not linked. On an imported order such a line is one unit with the amount Square charged.
- **Refunds are amounts.** Returns by item and exchanges are not mirrored on the order. As for any refund in Swell that returns no items, a partly refunded order shows the refunded amount as a balance.
- **A refund is recorded when Square has it**, also while Square still shows it as pending (cash refunds are; card refunds complete within days). A card refund that Square later reports as failed stays recorded on the order: correct it by hand.
- **Imported orders are not linked to products** (see "No stock is taken").
- **Square gift cards and loyalty** are shown as the way a sale was paid, nothing more.
- **One environment per Square account.** Connecting the test and the live environment of a store to the same Square location makes both share that location's stock.
- **After uninstalling**, delete the app's subscription under Webhooks in the Square Developer Console ("Swell <store>"), or Square keeps sending notices until it gives up.

## How it is built

| Part | Files | Job |
| --- | --- | --- |
| Route function | `functions/square-events.ts` | Receives Square's notices, checks their signature, marks the items or asks for a sales search, starts a sync |
| Event function | `functions/stock-changed.ts` | `product.stock_adjusted`: marks the item, starts a sync |
| Cron function | `functions/sweep.ts` | Every five minutes: starts a sync that compares everything; once an hour checks that Square's notices are still switched on |
| Workflow | `functions/sync.ts`, `functions/lib/run.ts` | The only place where stock is written and sales are imported. Also runs the dashboard actions |
| Action functions | `functions/test-connection.ts`, `functions/resolve-sale.ts` | The two buttons that answer at once |
| Stock | `functions/lib/merge.ts`, `stock.ts`, `match.ts` | The merge (pure), its execution, the SKU match |
| Sales | `functions/lib/order.ts`, `sales.ts` | The Square order as a Swell order (pure), the import and the refunds |
| Models | `models/` | `items` (the pairs), `sales`, `alerts`, `state`, and the fields on orders |
| Permissions | `swell.json` | Products (stock entries), orders, payments (the records of Square's payments and refunds), customers (the walk-in account and the match by e-mail), settings (the stock locations, and the Square POS payment method) |
| Views | `content/` | Products → Square stock, Orders → Square sales, the Square POS tabs on orders |
| Notification | `notifications/alert.*` | The e-mail to the administrators, one per incident |

What makes it reliable:

1. **Only differences travel.** A change on one side is added to the other; it never replaces what happened there meanwhile.
2. **Every step is written down before it is taken.** The pair's record holds the step in progress. The request to Square carries references made from it, and the Swell stock entry an id made from it. A sync that is cut short repeats the step exactly: it asks Square whether the change is there before sending it again, and a stock entry posted twice under one id is one entry.
3. **One sync at a time.** The functions only mark and start; the workflow alone writes, and holds a claim while it does. A claim that shows no sign of life for four minutes is taken over. Some workflow runs are recorded by the platform and never begin; the function that started a run watches for about fifteen seconds whether it took up its claim, and otherwise ends it and starts another.
4. **Notices are hints, numbers are the truth.** A notice only says "look at this item". The sync compares quantities, so its own changes, repeated notices and notices out of order do no harm.
5. **Nothing is guessed.** A missing count is never read as zero. What cannot be linked or imported is listed with the reason.
6. **Stock and sales are separate.** An imported order never moves stock, and a sale that cannot be imported never holds stock back.

Square's API version is pinned (`SQUARE_VERSION` in `functions/lib/square.ts`), for the calls and for the notices.

## Development

```bash
npm install
npm test            # unit tests, no network
npm run typecheck
swell app push      # deploys to the test environment of the logged-in store
```

The unit tests replace Square with an in-memory stand-in (`test/helpers/square.ts`) that behaves as the sandbox was seen to, and the store with another (`test/helpers/store.ts`). The orders in `test/fixtures/square-orders.ts` are real API responses.

After a change in `functions/lib/` only, push with `--force`: push skips function files whose own content did not change. Workflows do not run under `swell app dev`; they are tested after a push.

Square's sandbox has no till. Orders, payments and refunds are created there through the API, and such sales count as taken by an online checkout: the app imports them in Sandbox mode only.

### App Store listing

| What | Where |
| --- | --- |
| Full description | `DESCRIPTION.md` |
| Short description | `description` in `swell.json` (up to 70 characters) |
| Icon | `assets/icon.png` (600 × 600, the square filled: the dashboard rounds the corners itself) |
| Screenshots | `assets/images/*.png` (3200 × 1800), listed in `images` in `swell.json` |

## License

[MIT](LICENSE.md)
