# Square POS for Swell

Connects a shop that sells with [Square Point of Sale](https://squareup.com/point-of-sale) to its Swell store, so that both sell from one stock and keep one order history. A sale, a delivery or a recount on either side reaches the other, usually within a minute. Each sale completed in Square becomes a paid order in Swell, with the lines, discounts, taxes and total of the receipt, on the customer's account when Swell knows the customer.

The app runs inside Swell with the merchant's own Square access token; there is no other service in between. In Square it writes stock adjustments only: it never changes the catalog, orders or customers there. In Swell it writes stock entries, the orders it imports with their payments and refunds, one account for walk-in customers, and one payment method, "Square POS", which shoppers never see.

## Setup

### What you need from Square

- A Square account with at least one location, and the products you sell in both places carrying the **same SKU** in Square and in Swell. Items are linked by SKU only.
- An application in the [Square Developer Console](https://developer.squareup.com/apps) (any name; it is only a holder for the token). Open its **Credentials** page, switch to **Production**, and copy the **access token**. The token gives access to your whole Square account: treat it like a password.

### Install and connect

1. Install the app from Apps in the Swell dashboard.
2. Open Apps → Square POS → Settings, paste the token under **Square access token**, save, and press **Test connection**. It shows the connected account and its locations, registers the notices Square sends to this store when stock or payments change, and adds the payment method "Square POS" that imported sales are recorded with (a manual method, switched off for the checkout).
3. **Stock.** Under Inventory, turn on **Keep the stock of linked items in sync** and save. Choose **Match products** in the Actions menu. Then open Products → Square stock: each Square item with a matching SKU is listed as **Ready to start**, with its quantity on both sides. Select the items, choose **Start syncing**, and say which side has the right quantities. Nothing moves before an item is started.
4. **Sales.** Under Sales, turn on **Import completed Square sales as orders** and save. Sales are imported from that moment on. For earlier sales choose **Import past sales** in the Actions menu.

To try the app first, use the **Sandbox** access token of your Square application in the store's test environment, with **Square environment** set to Sandbox. Settings are separate for the test and live environments, and both start empty. Do not connect the test environment to your production Square account: stock changes of test orders would reach your shop.

### Settings

| Group | Setting | What it does |
| --- | --- | --- |
| Connection | **Square access token** | The token from your Square application. Stored as a secret |
| | **Square environment** | Production (default) or Sandbox. Must match the token: a sandbox token works only with Sandbox |
| | **Connected account** | Filled in by Test connection: the Square business name. The locations are listed in Test connection's message |
| | **Test connection** | Checks the token, lists the locations, registers Square's notices and adds the Square POS payment method. Run it again after changing the token |
| Inventory | **Keep the stock of linked items in sync** | Off by default. While off, no stock moves in either direction |
| | **Square location (name)** | The one Square location whose stock is shared with the store. Empty: the account's main location |
| | **Swell stock location (name)** | Only for stores that keep stock by location: the Swell location paired with the Square one. Empty: the store's stock as a whole |
| Sales | **Import completed Square sales as orders** | Off by default. Turning it on starts the import from that moment |
| | **Square locations (names, separated by commas)** | The locations whose sales are imported, up to 10. Empty: the first 10 active locations |
| | **Let other apps and webhooks react to imported orders** | Off by default: imported orders raise no events, so other apps and webhooks are not told about them. Turn it on if, for example, an accounting app should see till sales. Customers get no e-mail either way |

Changing the Square location or the Swell stock location stops the started items, since another location holds other quantities. Match products again and start them anew.

## Features

### One stock

**Which items are linked.** An item is linked when exactly one Square variation and exactly one Swell product or variant have the same SKU. Nothing is guessed: everything else is listed under **Not linked** with the reason.

| Not linked because | What to do |
| --- | --- |
| No Swell product or variant has the SKU | Give the Swell product the SKU of the Square item, then match again |
| More than one Square variation, or more than one Swell product or variant, has the SKU | Give each its own SKU |
| The Swell product or variant is linked to another Square item already (its SKU changed in Square after it was started, for example) | Stop the other item first |
| The Swell product has variants and the SKU is on the product | Stock is kept on the variants: give each variant its SKU |
| Square does not track stock for the item at the location | Turn on stock tracking in Square |
| The Swell product does not track stock | Turn on stock tracking for the product |
| Square sells the item by weight or measure | Only whole quantities can be shared |

Square variations without a SKU are not listed. Matching changes nothing in Square and moves no stock, and it leaves items that are in sync alone. Run it again whenever you add products or SKUs.

**Starting an item** is the one time a side wins. You say whether Square or Swell has the right quantity, and the other side receives the difference as a single stock adjustment ("Square POS: starting stock taken from Square" in Swell's stock history; stock received or removed in Square's). An item that Square has never counted can be started from Swell's quantity.

**After that, only changes travel, never totals.** The app remembers the quantity both sides held after the last sync. What Swell gained or lost since then is added to Square, and what Square gained or lost is added to Swell. A sale at the till and an online order at the same moment therefore both count.

| Happens | Arrives as |
| --- | --- |
| In Square: a sale, a delivery, a recount, a loss, a restocked return | An entry in the product's stock history in Swell, marked "Square POS", with what happened when Square's history says so ("Square POS: 2 sold") |
| In Swell: an online order | An adjustment in Square: stock sold |
| In Swell: a canceled order, a restocked return, received stock | An adjustment in Square: stock received |
| In Swell: stock marked damaged or missing | An adjustment in Square: stock lost |

- **How fast.** Square announces a change within seconds, and Swell records its own at once; the sync that follows takes a few seconds more. Every five minutes the app also compares all linked items, whether or not a change was announced, so a lost notice costs minutes, not stock.
- **The last unit sold on both sides at once** cannot be prevented by any sync. Both sides then show −1, and the item is listed under **Needs attention** as oversold until its stock is back to zero or more.
- **An item that stops.** When an item can no longer be synced (its product was deleted, Square has no count for it any more, Square refuses the change), it stops and is listed under **Needs attention** with the reason, and the store's administrators get one e-mail. All other items go on. After correcting the cause, start the item again.
- **Stop syncing** ends the sharing for the selected items. Nothing changes on either side.

Where: Products → Square stock, and the item's own page. Implemented by `functions/square-events.ts` (Square's `inventory.count.updated` notices), `functions/stock-changed.ts` (Swell's `product.stock_adjusted` event), `functions/sweep.ts` (the five-minute comparison) and the `sync` workflow.

### Till sales as orders

Each completed Square sale at the chosen locations becomes one Swell order.

- **The receipt, to the cent.** Lines with name, variation, quantity and price; the discounts and taxes Square charged; tips, service charges and cash rounding as lines of their own. The order's total is what the customer paid. A sale whose lines do not add up to Square's total is not imported: it is listed with the reason, so that no order differs from its receipt.
- **Paid.** Each Square payment of the sale is recorded on the order as a payment with the method "Square POS" (Square has the money; nothing is charged in Swell), so the order shows as paid. A sale paid by card and cash gets one payment per tender. The order needs no fulfillment.
- **Silent.** No e-mail goes to the customer or to the staff. Other apps and webhooks are not told about the order unless **Let other apps and webhooks react to imported orders** is on.
- **No stock is taken.** The lines carry names and amounts, not products, so the order cannot change stock: the stock sync passes on what Square counted. One side effect: Swell's sales reports by product do not include till sales.
- **Order numbers** are `SQ-` followed by Square's receipt number, so till sales stand out in every list and the store's own numbering is not used up. The order is dated when the sale was completed, and its comments say where it was sold and how it was paid ("Sold in Square at Main Street, receipt x3Hn. Paid with: Card (Visa 4242).").
- **The customer.** When the sale has a Square customer with an e-mail address and a Swell account has that address, the order goes to that account. All other sales go to one account, "Walk-in customer (Square POS)". The app never creates a customer from a Square profile.
- **Refunds.** A refund made in Square is recorded as a refund of the order's Square POS payment, so the order shows as partly refunded or refunded. A refund of a sale that was not imported is left out. Stock follows Square's count when the goods are restocked there.
- **Not imported:** exchanges (a sale and returned items on one receipt), and sales that an online checkout took through Square's payment API, since that checkout keeps its own orders. Both are listed under **Skipped** with the reason.
- **How fast.** A sale usually arrives within half a minute of its payment. The five-minute comparison also looks for sales whose notice was lost.
- **Where it starts.** Sales completed before the import was switched on stay out, also when they are refunded later. Switching the import off and on again starts it anew from that moment: the sales made while it was off stay out too. **Import past sales** brings them in from a date you choose; a long period is imported in the background a part at a time, with the stock sync going on in between, and a sale imported before is never imported twice.

Where: Orders → Square sales; the **Square POS** tab on every order (receipt number, location, how it was paid, what was refunded, the Square order ID and a receipt link); the **Square POS** tab in the order list. Implemented by `functions/square-events.ts` (Square's `payment.*` and `refund.*` notices), `functions/sweep.ts` and the `sync` workflow.

### Alerts

The store's administrators get one e-mail per incident, not one per item or sale, and no other while it lasts:

| Subject starts with "Action needed:" and | Sent when |
| --- | --- |
| "Square POS is not syncing with \<store\>" | Square refuses the access token, a location named in the settings does not exist, or the sales import has no start time yet |
| "Square's notices to \<store\> have stopped" | Square switched off its notices to the store (checked once an hour) |
| "stock of \<store\> is no longer shared with Square for some items" | An item stopped syncing |
| "a Square sale could not be imported into \<store\>" | A sale is listed under Needs attention |

Each e-mail says what to do and links to the app. When the subject starts with "(TEST)", the problem is in the store's test environment. Implemented by `models/alerts.json` and `notifications/alert.*`.

### Dashboard actions

| Where | Action | What it does |
| --- | --- | --- |
| Settings, Connection | **Test connection** | See "Settings" |
| Settings, Actions menu | **Sync now** | Compares the stock of every linked item and looks for new Square sales now |
| | **Match products** | Lists the Square items and their Swell match under Products → Square stock |
| | **Import past sales** | Imports the sales completed since a date |
| | **Retry failed sales** | Tries again every sale under Needs attention |
| Products → Square stock, selected items or one item | **Start syncing**, **Stop syncing** | See "One stock" |
| | **Open Square** | Opens the item library in the Square Dashboard |
| Orders → Square sales, selected sales or one sale | **Retry** | Tries the import again and reads the sale's refunds again. A sale that has its order is not imported twice |
| | **Open Square** | Opens the transactions in the Square Dashboard |
| A sale's page | **Mark as resolved** | For a failed or skipped sale you recorded by hand, or that needs no order: it is no longer imported or listed under Needs attention |
| | **View receipt** | Opens Square's receipt |

The buttons start a run in the background; the lists show its result a few seconds later.

## Day-to-day use

- **Selling** needs nothing from you: sell at the till and online as before.
- **New products.** Give a new product the same SKU in Square and in Swell, choose **Match products**, and start it under Products → Square stock (**Ready to start** tab).
- **Refunds and returns** are made in Square for till sales, and in Swell for online orders, as before. Restock returned goods on the side that took them back; the stock sync passes the count on.
- **When an e-mail arrives**, open the app and look under **Needs attention** in Products → Square stock or Orders → Square sales. Each entry names its cause. See "When something goes wrong".
- **To check the two sides now**, choose **Sync now** in the Actions menu of the settings.

## When something goes wrong

| What you see | Why, and what to do |
| --- | --- |
| E-mail "Square POS is not syncing" | Square refused the access token, or a location named in the settings does not exist. Correct it in the settings and press Test connection. Nothing is lost: once the connection works, the changes of each side since the last sync are passed to the other, and the sales made meanwhile are imported |
| E-mail "Square's notices have stopped" | Square switches its notices off when they fail for a long time. Press Test connection to switch them on again. Meanwhile changes are found every five minutes |
| An item under Needs attention | The note says what stopped it. Correct the cause and start the item again |
| A sale under Needs attention | The problem is on the sale. **Retry** after correcting the cause, or **Mark as resolved** after recording the sale by hand |
| A sale under Needs attention: "Swell has no payment method "Square POS"" | The method was removed under Settings → Payments. Press Test connection, which adds it again, then **Retry** |
| E-mail "Square POS is not syncing": "The sales import has no start time yet" | The settings were last saved before the app recorded the start time. Open the settings and save them once |
| Stock differs between Square and Swell for a linked item | It should not for longer than five minutes. Choose **Sync now**. If the item is under Needs attention, see above |
| Test connection: "Square did not accept the access token" | The token was replaced in Square, or **Square environment** does not match it: a sandbox token works only with Sandbox |

## Limits and known issues

- **The merchant's own token.** The app does not use Square's OAuth sign-in. You create a Square application yourself and paste its token, which has access to your whole Square account and is stored in the store's settings.
- **No catalog sync.** Products are not created or changed on either side. Items are linked by the SKUs you keep.
- **One location for stock.** Sales are imported from up to 10 locations.
- **Whole quantities.** Items sold by weight or measure are not linked. On an imported order such a line is one unit with the amount Square charged.
- **Taxes included in the price and taxes added on top in one sale.** Only the added taxes are listed on the order; the included ones stay in the prices. The total is Square's.
- **One currency.** Orders are imported in the currency of the Square location. When the store only shows that currency without prices of its own, Swell would record the order in the store's currency at the receipt's numbers: such sales are listed under Needs attention instead of imported.
- **Refunds are amounts.** Returns by item and exchanges are not mirrored on the order. As for any refund in Swell that returns no items, a partly refunded order shows the refunded amount as a balance.
- **A refund is recorded when Square has it**, also while Square still shows it as pending (cash refunds are; card refunds complete within days). A card refund that Square later reports as failed stays recorded on the order: correct it by hand.
- **Imported orders are not linked to products** (see "No stock is taken").
- **Square gift cards and loyalty** are shown as the way a sale was paid, nothing more.
- **One environment per Square location.** Connecting the test and the live environment of a store to the same Square location makes both share that location's stock.
- **After uninstalling**, delete the app's subscription under Webhooks in the Square Developer Console ("Swell \<store\>"), or Square keeps sending notices until it gives up.
- **Environments.** The app works in the store's live and test environments, against Square's production and sandbox. Square's sandbox has no till: sales made there through the API count as taken by an online checkout, and the app imports them in Sandbox mode only.

## Development

```bash
npm install
npm test            # unit tests, no network
npm run typecheck
swell app push      # deploys to the test environment of the logged-in store
```

The unit tests replace Square with an in-memory stand-in (`test/helpers/square.ts`) that behaves as the sandbox was seen to, and the store with another (`test/helpers/store.ts`). The orders in `test/fixtures/square-orders.ts` are real API responses.

Use `swell app push --force` after a change that touches only `functions/lib/`: push skips function files whose own content did not change. Workflows do not run under `swell app dev`; test them after a push. Square's API version is pinned (`SQUARE_VERSION` in `functions/lib/square.ts`), for the calls and for the notices.

### How it stays right

1. **Only differences travel.** A change on one side is added to the other; it never replaces what happened there meanwhile.
2. **Every step is written down before it is taken.** The item's record holds the step in progress. The request to Square carries references made from it, and the Swell stock entry an id made from it. A sync that is cut short repeats the step exactly: it asks Square whether the change is there before sending it again, and a stock entry posted twice under one id is one entry.
3. **One sync at a time.** The functions only mark and start; the workflow alone writes, and holds a claim while it does. A claim that shows no sign of life for four minutes is taken over, also when its run never began.
4. **Notices are hints, numbers are the truth.** A notice only says "look at this item". The sync compares quantities, so its own changes, repeated notices and notices out of order do no harm.
5. **Nothing is guessed.** A missing count is never read as zero. What cannot be linked or imported is listed with the reason.
6. **Stock and sales are separate.** An imported order never moves stock, and a sale that cannot be imported never holds stock back.

The time the sales import was switched on is computed by the settings save that switches it on (a hidden field with a formula, `sales.enabled_at`); later saves keep it, and switching off clears it. Only the workflow, while it holds the claim, starts or drops a search from it.

### Structure

| Path | Purpose |
| --- | --- |
| `swell.json` | Manifest: permissions and the listing's short description and images. Products (stock entries), orders, payments (the records of Square's payments and refunds), accounts (the walk-in account and the match by e-mail), settings (the stock locations, and the Square POS payment method) |
| `settings/connection.json`, `inventory.json`, `sales.json` | The three settings groups, Test connection and the Actions menu |
| `functions/square-events.ts` | Route: receives Square's notices, checks their signature, marks the items or asks for a sales search, starts a sync |
| `functions/stock-changed.ts` | `product.stock_adjusted` → marks the item, starts a sync |
| `functions/sweep.ts` | Cron, every five minutes: starts a sync that compares everything; once an hour checks that Square's notices are still on |
| `functions/sync.ts`, `functions/lib/run.ts` | Workflow: the only place where stock is written and sales are imported. Also runs the dashboard actions |
| `functions/test-connection.ts`, `resolve-sale.ts` | The two actions that answer at once |
| `functions/lib/merge.ts`, `stock.ts`, `match.ts` | Stock: the merge (pure), its execution, the SKU match |
| `functions/lib/order.ts`, `sales.ts` | Sales: the Square order as a Swell order (pure), the import and the refunds |
| `functions/lib/square.ts` | The only module that talks to Square |
| `models/` | `items` (the linked pairs), `sales`, `alerts`, `state`, and the app's fields on orders |
| `content/` | Products → Square stock, Orders → Square sales, the Square POS tabs on orders |
| `notifications/alert.*` | The e-mail to the administrators, sent when an alert record is created |
| `test/unit/` | Unit tests; Square and the store are stand-ins |

### App Store listing

| What | Where |
| --- | --- |
| Full description | `DESCRIPTION.md` |
| Short description | `description` in `swell.json` (up to 70 characters) |
| Icon | `assets/icon.png` (600 × 600, the square filled: the dashboard rounds the corners itself) |
| Screenshots | `assets/images/*.png` (3200 × 1800), listed in `images` in `swell.json` |

## License

[MIT](LICENSE.md)
