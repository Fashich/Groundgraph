# Risk Disclosure

version: 2026-10-01
updated: Oct 1, 2026
read: 3 min read

Price markets are high-risk. Only use funds you can afford to lose. Groundgraph currently runs on Solana devnet with a test token.

## Total loss
A position on the wrong side of the level settles at $0. Shares bought at 90 cents can still end at zero.

## Pool pricing
Prices come from a liquidity pool. Large trades move the price, and thin markets can be volatile or hard to exit before resolution.

## Oracle risk
Resolution relies on Pyth price feeds. Delays, outages or abnormal prices at resolution time can affect outcomes. When a feed is stale, buying is paused and selling stays available.

## Smart contract risk
The Groundgraph program is new, open-source and not yet audited. Bugs could cause loss of funds. That is why the interface shows a devnet badge.

## Signal risk
Smart money signals can be wrong, delayed, or gamed by wallets that trade in order to create a false signal. Following a signal does not guarantee a gain. The radar shows its sample size and a confidence interval so you can judge how much weight to give it.

## Regulatory risk
Rules for price markets are changing and differ by country. Access may be restricted at any time.
