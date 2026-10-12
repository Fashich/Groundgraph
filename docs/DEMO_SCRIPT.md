# Demo script (3 minutes)

Everything below runs on Solana devnet with free test USDC. Prepare once, then the live run takes about three minutes.

## Before recording

1. Start the stack (`docker compose up -d`) or open the hosted URL. Check `/api/health` shows `ok: true` and the keeper heartbeat.
2. Install a Solana wallet (Phantom, Solflare or Backpack), switch it to **Devnet**, and get a little devnet SOL from https://faucet.solana.com (about 0.1 SOL pays for many transactions).
3. Open the app. The first connect asks you to accept the Terms and sign a Sign-In With Solana message. This is a message signature, not a transaction.
4. Click **Get test USDC** (wallet menu, or the trade panel when the balance is empty) once, so the balance is ready.
5. Keep two tabs: the app, and the Solana Explorer page of the program (devnet) for the closing shot.

## Script

**0:00 - Hook (15 s)**
"Prediction markets show you the price. Groundgraph also shows you who is positioned, and how good they have been. Every market here is a simple ABOVE or BELOW question that settles at one dollar or zero, on Solana, with a wallet-graph model that flags smart money."

**0:15 - Markets (25 s)**
Open Markets. Point out: ten live markets read straight from devnet, the implied price in cents, time left, the radar chip, and the "Demo data" ribbon at the top.
"The ribbon is deliberate. The market, price and trades are real devnet data; the wallet radar runs on a synthetic world until a Helius key lets it read real wallets, and the app says so on every screen."

**0:40 - Market detail and trade (50 s)**
Open "SOL above or below $110 at the Oct 31 close". Show the header: Pyth price with its age, liquidity, time to settlement.
Type 25 in the amount box and choose Buy ABOVE. Show the live quote: estimated shares, average price, price impact, and the fee breakdown (base, near-expiry, **Recent flow**).
Confirm in the wallet. When the toast shows the transaction, point at the position row and the price tick in the chart.
"The quote on the screen is computed in the SDK and is bit-identical to the program's integer math; the smoke test asserts the on-chain fill equals the quote."

**1:30 - Radar signal (35 s)**
Scroll to the radar summary: P(above), the interval, and the edge versus the market in cents, then flagged volume split between ABOVE and BELOW.
Click a flagged entry on the chart, then open Radar from the top bar: the 3D wallet graph, clusters, top flagged wallets with their five-feature breakdown.
"Smart money is a graph problem. Clusters that look like one actor are capped at half weight, and when there is not enough evidence the screen says Building instead of inventing a number."

**2:05 - Create a market (25 s)**
Open Create. Pick SOL, a target, a settlement time 30 minutes out, base fee tier, liquidity. Show the opening price: it is the fair value from Pyth spot and volatility, so the creator is not donating an edge.
Submit and sign. The new market appears in the list within a few seconds.

**2:30 - Settlement and redeem (20 s)**
Open Positions and pick a market that has already resolved (market 1 settled ABOVE on devnet; trade a short demo market beforehand to hold a position in it). With the keeper running on a `PYTH_API_KEY`, the keeper posted the Pyth update and called `settle_close`, and the winning side shows a Redeem button at 1 USDC per share. Without a key, an unsettled market is voided one hour after its settlement time and both sides redeem at $0.50 per share; say so on camera, it is the designed safety net.
Redeem and show the receipt. Mention that merge returns a complete set at any time before settlement.

**2:50 - Close (10 s)**
Switch to the Explorer tab on the program account.
"Original Anchor program, 266 kilobytes, 90 Rust tests, 131 SDK parity tests against the Rust vectors, self-hostable with one compose file. Groundgraph: see who is on the other side of the market."

## If something goes wrong on camera

- Wallet rejects or times out: the app shows a retry with the same quote; mention that nothing was sent.
- Oracle reading flagged stale: the app blocks trading on that market and says why. This is the intended guard.
- Region block page: only appears for countries in `BLOCKED_COUNTRIES` when a CDN or tunnel adds a country header; edit the list in `.env` and restart `web` and `api` if you record from a listed country.
