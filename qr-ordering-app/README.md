# QR Code Ordering App — Restaurant / Hotel / Cafe

A working ordering system built from the use cases you provided:

**Customer**
- Scan a table's QR code → see the menu (food & drinks, prices, ingredients, out-of-stock items)
- Add items to a cart and send the order to the kitchen for their table
- See a running bill of everything they've ordered, and pay
- Order by voice (tap the mic and speak, e.g. "two orange juice and a caesar salad")
- Menu still browses when offline; orders made offline are queued and sent automatically once back online
- Two+ people at the same table, using the same QR code, each get their own cart and bill (each phone is tracked separately) — nobody can see or pay for someone else's order

**Admin / receiver**
- Sign in, then see all orders in a Pending → Accepted → Served board, oldest order first (FIFO)
- Accept an order, then mark it served
- Add, edit, and delete menu items (name, description, ingredients, cost, in/out of stock)

---

## 1. Requirements

- [Node.js](https://nodejs.org) version 16 or later (includes `npm`)
- No database server, no build step, no paid services required

## 2. Setup

Unzip the project, then in a terminal:

```bash
cd qr-ordering-app
npm install
npm start
```

You'll see:

```
QR ordering app running at http://localhost:3000
Customer demo:  http://localhost:3000/?table=5
Admin panel:    http://localhost:3000/admin.html
QR generator:   http://localhost:3000/qr-generator.html
```

## 3. Try it out

- **Customer view:** open `http://localhost:3000/?table=5` (open it in two different browsers, or one normal + one incognito window, to see two "different customers" ordering separately at the same table)
- **Admin panel:** open `http://localhost:3000/admin.html` and sign in with `admin` / `admin123`
- **QR codes to print:** open `http://192.168.1.6:3000/qr-generator.html` — it lists every table and a scannable QR code linking straight to that table's menu. Print these and stick one on each table.

To make the QR codes work from customers' own phones (not just your computer), the app needs to run somewhere reachable from their phones — see "Going live" below.

## 4. How the use cases map to the code

| Use case | Where it's handled |
|---|---|
| Scan QR → see menu, stock, ingredients, price | `public/index.html` + `public/js/customer.js`, `GET /api/menu` |
| Order by table number | Cart → `POST /api/orders` (`tableNumber` on every order) |
| See running cost of consumption | "View my bill" sheet → `GET /api/orders?table=&customer=` |
| Pay | "Pay now" button → `POST /api/orders/:id/pay` |
| Accept orders by table, FIFO | Admin **Orders** tab, `GET /api/admin/orders` (sorted oldest first) |
| Add / update / delete food & drinks with ingredients & cost | Admin **Menu** tab, `POST` / `PUT` / `DELETE /api/admin/menu` |
| Works offline | `public/service-worker.js` caches the menu + app; orders made offline are queued in the browser and sent automatically when back online |
| Two+ customers order & pay separately from one QR code | Each browser generates and stores its own `customerId` (see `getOrCreateCustomerId` in `customer.js`) the first time it loads a table, so two phones scanning the same code are tracked and billed independently |
| Order by voice | Mic button on the customer page uses the browser's built-in speech recognition (see `setupVoiceOrdering` in `customer.js`) |

## 5. Project structure

```
qr-ordering-app/
├── server/
│   ├── server.js        # Express API (menu, orders, admin, payments)
│   ├── db.js             # simple file-based data store
│   └── data/db.json       # menu, tables, orders, admin login — your "database"
├── public/
│   ├── index.html         # customer ordering page
│   ├── admin.html         # admin / staff dashboard
│   ├── qr-generator.html  # prints one QR code per table
│   ├── manifest.json       # installable app (PWA)
│   ├── service-worker.js   # offline caching
│   ├── css/style.css
│   └── js/customer.js, admin.js
└── package.json
```

The whole app runs as a single Node.js process serving both the API and the web pages — nothing else to install or configure.

## 6. Important notes before you open this to real customers

This is a complete, working demo built to match your use cases, but a few things are simplified and **must** be changed before accepting real orders and real payments:

- **Data storage:** menu/orders currently live in `server/data/db.json`, a plain file. That's fine for testing or a very small single-location setup, but for real traffic move to a real database (Postgres, MySQL, SQLite). The `server/db.js` file is the only place that would need rewriting — every route in `server.js` just calls into it.
- **Payments:** the "Pay now" button currently just marks the order as paid — it does **not** move real money. Wire it up to a real payment provider (Stripe, PayPal, a local mobile-money API, etc.) before going live.
- **Admin login:** the demo credentials are `admin` / `admin123`, stored in plain text in `db.json`, with a very simple login token. Before going live: set a strong password, hash it, and use a proper session/JWT library.
- **HTTPS:** offline support (service worker) and voice ordering (speech recognition) both require the site to be served over HTTPS (or `localhost`) in real browsers. Deploy behind HTTPS — most hosting providers (Render, Railway, a VPS with Caddy/Let's Encrypt, etc.) give you this for free.
- **Voice ordering accuracy:** matching is done with simple keyword/number matching against your menu names, not a full language model — it works well for short, clear phrases but won't understand every possible way of speaking. Speech recognition itself depends on the customer's browser (works well in Chrome; Safari/Firefox support varies).
- **Branding:** open `public/js/customer.js` and change the `APP_NAME` constant at the top to your business name. Update colors in `public/css/style.css` (`:root` variables at the top) to match your branding.

## 7. Going live (quick options)

- **Simplest:** deploy to a free/low-cost Node.js host (Render, Railway, Fly.io) — push the folder, set the start command to `npm start`, and you get a public HTTPS URL to put into your QR codes.
- **Your own server:** run `npm start` behind a reverse proxy (Nginx/Caddy) with a free Let's Encrypt certificate.

Once deployed, regenerate your QR codes from `/qr-generator.html` on the live URL (not `localhost`) so customer phones can actually reach it.
