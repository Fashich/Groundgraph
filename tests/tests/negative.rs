//! Negative tests: every constraint of every instruction must reject bad input with the documented error and leave
//! the state untouched.
use groundgraph_tests::*;
use solana_address::Address;
use solana_signer::Signer;

/// Market with some activity: alice holds ABOVE, bob holds BELOW.
fn fixture() -> (Env, MarketRef) {
    let mut env = Env::new();
    let m = env.create_market(&MarketArgs::default());
    env.buy("alice", &m, "above", 100 * USDC, 0).must();
    env.buy("bob", &m, "below", 60 * USDC, 0).must();
    (env, m)
}

fn pk(env: &Env, who: &str) -> Address {
    env.clone_kp(who).pubkey()
}

fn snapshot(env: &Env, m: &MarketRef) -> (Fields, u64) {
    (env.market(m), env.vault_balance(m))
}

fn price(m: &MarketRef, price: i64, dt: i64) -> PriceUpdate {
    PriceUpdate::new(m.args.feed_id, price, m.args.target_expo, m.settle_ts + dt)
}

/* ------------------------------ buy ------------------------------ */

#[test]
fn buy_rejections() {
    let (mut env, m) = fixture();
    let before = snapshot(&env, &m);
    let alice = env.clone_kp("alice");

    env.buy("alice", &m, "above", 0, 0).expect_gg("ZeroAmount");
    env.buy("alice", &m, "above", USDC - 1, 0).expect_gg("BelowMinTrade");
    // Slippage: demand one share more than the quote.
    let f = env.market(&m);
    let q = groundgraph_tests::math::quote_buy(f.u("reserve_above"), f.u("reserve_below"), groundgraph_tests::math::Side::Above, 10 * USDC, 100).unwrap();
    env.buy("alice", &m, "above", 10 * USDC, q.shares_out + 1).expect_gg("SlippageExceeded");
    env.buy("alice", &m, "above", 10 * USDC, q.shares_out).must();

    let b = env.ixb();
    let ix = || b.buy_ix(&alice.pubkey(), &m, 0, 10 * USDC, 0);

    // Wrong outcome mint for the requested side.
    let mut i = ix();
    replace_account(&mut i, "buy", "outcome_mint", m.below);
    env.send(&[i], &alice, &[]).expect_gg("WrongMint");
    // Wrong vault.
    let mut i = ix();
    replace_account(&mut i, "buy", "vault", Address::new_unique());
    env.send(&[i], &alice, &[]).expect_gg("WrongVault");
    // Vault of another market.
    let other = env.create_market(&MarketArgs { nonce: 2, ..Default::default() });
    let mut i = ix();
    replace_account(&mut i, "buy", "vault", other.vault);
    env.send(&[i], &alice, &[]).expect_gg("WrongVault");
    // Outcome account holding the wrong mint.
    let mut i = ix();
    replace_account(&mut i, "buy", "user_outcome", ata(&alice.pubkey(), &m.below));
    env.ensure_ata(&alice.pubkey(), &m.below);
    env.send(&[i], &alice, &[]).expect_gg("WrongTokenAccount");
    // Collateral account owned by somebody else.
    let mut i = ix();
    replace_account(&mut i, "buy", "user_usdc", ata(&pk(&env, "bob"), &env.usdc));
    env.send(&[i], &alice, &[]).expect_gg("WrongTokenAccount");
    // Collateral account holding a different mint.
    let fake = Address::new_unique();
    let fake_mint = env.usdc;
    let _ = fake_mint;
    env.put_token_account(fake, &m.above, &alice.pubkey(), 1_000 * USDC);
    let mut i = ix();
    replace_account(&mut i, "buy", "user_usdc", fake);
    env.send(&[i], &alice, &[]).expect_gg("WrongTokenAccount");
    // Config account replaced by a different program account.
    let mut i = ix();
    replace_account(&mut i, "buy", "config", m.market);
    env.send(&[i], &alice, &[]).expect_code(anchor_err::ACCOUNT_DISCRIMINATOR_MISMATCH);
    // Market account that is not a market PDA.
    let mut i = ix();
    replace_account(&mut i, "buy", "market", config_pda());
    env.send(&[i], &alice, &[]).expect_fail();
    // Missing user signature (bob pays the fee, alice does not sign).
    let bob = env.clone_kp("bob");
    let mut i = ix();
    unsign_account(&mut i, "buy", "user");
    env.send(&[i], &bob, &[]).expect_code(anchor_err::ACCOUNT_NOT_SIGNER);
    // Wrong token program.
    let mut i = ix();
    replace_account(&mut i, "buy", "token_program", SYSTEM_PROGRAM);
    // The IDL pins the token program address, so the builder forces it; patch the raw meta instead.
    let tp = i.accounts.len() - 1;
    i.accounts[tp].pubkey = SYSTEM_PROGRAM;
    env.send(&[i], &alice, &[]).expect_fail();

    // Nothing but the one valid buy changed the market or the vault.
    let after = snapshot(&env, &m);
    assert_eq!(after.0.u("fee_pool"), before.0.u("fee_pool") + q.fee);
    assert_eq!(after.0.u("complete_sets"), before.0.u("complete_sets") + q.usdc_into_sets);
    assert_eq!(after.1, before.1 + 10 * USDC);
}

#[test]
fn buy_after_trading_end_and_after_resolution() {
    let (mut env, m) = fixture();
    env.set_time(m.trading_end_ts - 1);
    env.buy("alice", &m, "above", 5 * USDC, 0).must();
    env.set_time(m.trading_end_ts);
    env.buy("alice", &m, "above", 5 * USDC, 0).expect_gg("TradingEnded");
    env.buy("bob", &m, "below", 5 * USDC, 0).expect_gg("TradingEnded");
    env.set_time(m.settle_ts);
    env.settle_with(&m, &price(&m, 26_000_000_000, 0)).must();
    env.buy("alice", &m, "above", 5 * USDC, 0).expect_gg("MarketNotOpen");
}

#[test]
fn buy_cannot_exceed_the_reserve_cap() {
    let (mut env, m) = fixture();
    // A buy that would push a reserve to 2^62 (4.6e18 base units) or more must be rejected cleanly.
    let alice = pk(&env, "alice");
    let usdc = env.usdc;
    env.put_token_account(ata(&alice, &usdc), &usdc, &alice, u64::MAX / 2);
    env.buy("alice", &m, "above", 5_000_000_000_000_000_000, 0).expect_gg("ReserveTooLarge");
}

/* ------------------------------ sell ------------------------------ */

#[test]
fn sell_rejections() {
    let (mut env, m) = fixture();
    let alice = env.clone_kp("alice");
    let held = env.shares_of(&alice.pubkey(), &m.above);

    env.sell("alice", &m, "above", 0, 0).expect_gg("ZeroAmount");
    env.sell("alice", &m, "above", 1, 0).expect_gg("SellTooSmall");
    // Slippage.
    let f = env.market(&m);
    let q = groundgraph_tests::math::quote_sell(f.u("reserve_above"), f.u("reserve_below"), groundgraph_tests::math::Side::Above, held / 2, 100).unwrap();
    env.sell("alice", &m, "above", held / 2, q.usdc_out + 1).expect_gg("SlippageExceeded");
    // More shares than held: the token program refuses to burn them (InsufficientFunds = 1).
    env.sell("alice", &m, "above", held + 1, 0).expect_code(1);
    // A wallet that never held any.
    env.sell("maker", &m, "above", 1_000_000, 0).expect_fail();

    let b = env.ixb();
    let ix = || b.sell_ix(&alice.pubkey(), &m, 0, held / 2, 0);
    let mut i = ix();
    replace_account(&mut i, "sell", "outcome_mint", m.below);
    env.send(&[i], &alice, &[]).expect_gg("WrongMint");
    let mut i = ix();
    replace_account(&mut i, "sell", "vault", Address::new_unique());
    env.send(&[i], &alice, &[]).expect_gg("WrongVault");
    let mut i = ix();
    replace_account(&mut i, "sell", "user_usdc", ata(&pk(&env, "bob"), &env.usdc));
    env.send(&[i], &alice, &[]).expect_gg("WrongTokenAccount");
    let mut i = ix();
    replace_account(&mut i, "sell", "user_outcome", ata(&pk(&env, "bob"), &m.below));
    env.send(&[i], &alice, &[]).expect_gg("WrongTokenAccount");
    let bob = env.clone_kp("bob");
    let mut i = ix();
    unsign_account(&mut i, "sell", "user");
    env.send(&[i], &bob, &[]).expect_code(anchor_err::ACCOUNT_NOT_SIGNER);

    // Sells are still allowed after trading ends (the market is Open), but not after settlement.
    env.set_time(m.trading_end_ts + 10);
    env.sell("alice", &m, "above", held / 2, 0).must();
    env.set_time(m.settle_ts);
    env.settle_with(&m, &price(&m, 26_000_000_000, 0)).must();
    env.sell("alice", &m, "above", 1_000_000, 0).expect_gg("MarketNotOpen");
}

/* ------------------------------ merge ------------------------------ */

#[test]
fn merge_rejections() {
    let (mut env, m) = fixture();
    let alice = env.clone_kp("alice");
    env.buy("alice", &m, "below", 20 * USDC, 0).must();
    let have = env.shares_of(&alice.pubkey(), &m.above).min(env.shares_of(&alice.pubkey(), &m.below));

    env.merge("alice", &m, 0).expect_gg("ZeroAmount");
    // More than the smaller side held.
    env.merge("alice", &m, have + 1).expect_code(1);
    // A wallet holding only one side.
    env.merge("bob", &m, 1_000_000).expect_fail();

    let b = env.ixb();
    let ix = || b.merge_ix(&alice.pubkey(), &m, have);
    let mut i = ix();
    replace_account(&mut i, "merge", "vault", Address::new_unique());
    env.send(&[i], &alice, &[]).expect_gg("WrongVault");
    let mut i = ix();
    replace_account(&mut i, "merge", "above_mint", m.below);
    env.send(&[i], &alice, &[]).expect_gg("WrongMint");
    let mut i = ix();
    replace_account(&mut i, "merge", "below_mint", m.above);
    env.send(&[i], &alice, &[]).expect_gg("WrongMint");
    let mut i = ix();
    replace_account(&mut i, "merge", "user_above", ata(&alice.pubkey(), &m.below));
    env.send(&[i], &alice, &[]).expect_gg("WrongTokenAccount");
    let mut i = ix();
    replace_account(&mut i, "merge", "user_usdc", ata(&pk(&env, "bob"), &env.usdc));
    env.send(&[i], &alice, &[]).expect_gg("WrongTokenAccount");

    env.merge("alice", &m, have).must();
    // After resolution merge is closed.
    env.set_time(m.settle_ts);
    env.settle_with(&m, &price(&m, 26_000_000_000, 0)).must();
    env.merge("alice", &m, 1).expect_gg("MarketNotOpen");
}

/* ------------------------------ settle_close ------------------------------ */

#[test]
fn settle_rejections() {
    let (mut env, m) = fixture();
    let before = snapshot(&env, &m);
    let good = price(&m, 26_000_000_000, 0);

    // Early: even a perfectly valid update cannot settle before settle_ts.
    env.set_time(m.settle_ts - 1);
    env.settle_with(&m, &good).expect_gg("TooEarlyToSettle");
    env.set_time(m.settle_ts + 30);

    // Verification level and feed id.
    env.settle_with(&m, &PriceUpdate { full: false, ..good.clone() }).expect_gg("InsufficientVerification");
    env.settle_with(&m, &PriceUpdate { feed_id: OTHER_FEED, ..good.clone() }).expect_gg("WrongFeedId");
    // Publish time window: [settle_ts, settle_ts + 60].
    env.settle_with(&m, &price(&m, 26_000_000_000, -1)).expect_gg("PriceStale");
    env.settle_with(&m, &price(&m, 26_000_000_000, -3_600)).expect_gg("PriceStale");
    env.settle_with(&m, &price(&m, 26_000_000_000, 61)).expect_gg("PriceOutsideWindow");
    env.settle_with(&m, &price(&m, 26_000_000_000, 86_400)).expect_gg("PriceOutsideWindow");
    // Price must be positive.
    env.settle_with(&m, &price(&m, 0, 0)).expect_gg("NonPositivePrice");
    env.settle_with(&m, &price(&m, -5, 0)).expect_gg("NonPositivePrice");
    // Confidence: max 0.50% of price. 125_000_000 is exactly 0.50% of 25_000_000_000.
    env.settle_with(&m, &PriceUpdate { conf: 125_000_001, price: 25_000_000_000, ..good.clone() }).expect_gg("ConfidenceTooWide");
    env.settle_with(&m, &PriceUpdate { conf: u64::MAX, ..good.clone() }).expect_gg("ConfidenceTooWide");
    // Exponent difference beyond 18 digits.
    env.settle_with(&m, &PriceUpdate { price: 1, conf: 0, expo: -30, ..good.clone() }).expect_gg("ExponentOutOfRange");
    // Not a price account: wrong owner, wrong discriminator, empty account.
    env.settle_with(&m, &PriceUpdate { owner: SYSTEM_PROGRAM, ..good.clone() }).expect_code(anchor_err::ACCOUNT_OWNED_BY_WRONG_PROGRAM);
    env.settle_with(&m, &PriceUpdate { owner: TOKEN_PROGRAM, ..good.clone() }).expect_code(anchor_err::ACCOUNT_OWNED_BY_WRONG_PROGRAM);
    let junk = Address::new_unique();
    env.svm.set_account(junk, solana_account::Account { lamports: 10_000_000, data: vec![0u8; 134], owner: PYTH_RECEIVER, executable: false, rent_epoch: 0 }).unwrap();
    let keeper = env.clone_kp("keeper");
    let ix = env.settle_ix(&keeper.pubkey(), &m, &junk);
    env.send(&[ix], &keeper, &[]).expect_code(anchor_err::ACCOUNT_DISCRIMINATOR_MISMATCH);
    // The market account in the price slot.
    let ix = env.settle_ix(&keeper.pubkey(), &m, &m.market);
    env.send(&[ix], &keeper, &[]).expect_fail();
    // Wrong lp_mint account.
    let addr = Address::new_unique();
    env.put_price(addr, &good);
    let mut ix = env.settle_ix(&keeper.pubkey(), &m, &addr);
    replace_account(&mut ix, "settle_close", "lp_mint", m.above);
    env.send(&[ix], &keeper, &[]).expect_gg("WrongMint");
    // The payer must sign.
    let bob = env.clone_kp("bob");
    let mut ix = env.settle_ix(&keeper.pubkey(), &m, &addr);
    unsign_account(&mut ix, "settle_close", "payer");
    env.send(&[ix], &bob, &[]).expect_code(anchor_err::ACCOUNT_NOT_SIGNER);

    // None of that changed anything.
    let after = snapshot(&env, &m);
    assert_eq!(after.0.e("status"), "open");
    assert_eq!(before.0.u("reserve_above"), after.0.u("reserve_above"));
    assert_eq!(before.1, after.1);

    // Anyone can settle with a valid update (the keeper key is a plain wallet); then it cannot be settled twice.
    env.settle_with(&m, &good).must();
    env.settle_with(&m, &price(&m, 20_000_000_000, 1)).expect_gg("MarketNotOpen");
    assert_eq!(env.market(&m).e("outcome"), "above");
    assert_eq!(env.market(&m).i("settle_price"), 26_000_000_000);
}

#[test]
fn settle_accepts_the_boundary_confidence() {
    let (mut env, m) = fixture();
    env.set_time(m.settle_ts);
    env.settle_with(&m, &PriceUpdate { conf: 125_000_000, price: 25_000_000_000 + 1, ..price(&m, 0, 0) }).must();
    assert_eq!(env.market(&m).e("outcome"), "above");
}

/* ------------------------------ void_market ------------------------------ */

#[test]
fn void_rejections() {
    let (mut env, m) = fixture();
    env.void(&m).expect_gg("TooEarlyToVoid");
    env.set_time(m.settle_ts);
    env.void(&m).expect_gg("TooEarlyToVoid");
    env.set_time(m.settle_ts + 3_599);
    env.void(&m).expect_gg("TooEarlyToVoid");

    // wrong lp_mint account
    let keeper = env.clone_kp("keeper");
    env.set_time(m.settle_ts + 3_600);
    let mut ix = env.void_ix(&keeper.pubkey(), &m);
    replace_account(&mut ix, "void_market", "lp_mint", m.above);
    env.send(&[ix], &keeper, &[]).expect_gg("WrongMint");

    // A market that settled cannot be voided later.
    let m2 = env.create_market(&MarketArgs { nonce: 7, settle_in: 1_800, ..Default::default() });
    env.set_time(m2.settle_ts);
    env.settle_with(&m2, &price(&m2, 26_000_000_000, 0)).must();
    env.set_time(m2.settle_ts + 7_200);
    env.void(&m2).expect_gg("MarketNotOpen");
    // The first one can still be voided (nobody settled it).
    env.void(&m).must();
}

/* ------------------------------ redeem ------------------------------ */

#[test]
fn redeem_rejections() {
    let (mut env, m) = fixture();
    let (alice, bob) = (pk(&env, "alice"), pk(&env, "bob"));
    let a = env.shares_of(&alice, &m.above);
    let b = env.shares_of(&bob, &m.below);

    // Open market: nothing to redeem yet.
    env.redeem("alice", &m, "above", a).expect_gg("NotResolved");
    env.redeem("alice", &m, "above", 0).expect_gg("ZeroAmount");

    env.set_time(m.settle_ts);
    env.settle_with(&m, &price(&m, 26_000_000_000, 0)).must(); // ABOVE wins

    // Losing side.
    env.redeem("bob", &m, "below", b).expect_gg("NotWinningSide");
    env.redeem("bob", &m, "below", 1).expect_gg("NotWinningSide");
    env.redeem("alice", &m, "above", 0).expect_gg("ZeroAmount");
    // More than held.
    env.redeem("alice", &m, "above", a + 1).expect_code(1);

    let alice_kp = env.clone_kp("alice");
    let b = env.ixb();
    let ix = || b.redeem_ix(&alice, &m, 0, a);
    let mut i = ix();
    replace_account(&mut i, "redeem", "outcome_mint", m.below);
    env.send(&[i], &alice_kp, &[]).expect_gg("WrongMint");
    let mut i = ix();
    replace_account(&mut i, "redeem", "vault", Address::new_unique());
    env.send(&[i], &alice_kp, &[]).expect_gg("WrongVault");
    let mut i = ix();
    replace_account(&mut i, "redeem", "user_usdc", ata(&bob, &env.usdc));
    env.send(&[i], &alice_kp, &[]).expect_gg("WrongTokenAccount");
    let mut i = ix();
    replace_account(&mut i, "redeem", "user_outcome", ata(&bob, &m.above));
    env.ensure_ata(&bob, &m.above);
    env.send(&[i], &alice_kp, &[]).expect_gg("WrongTokenAccount");
    let bob_kp = env.clone_kp("bob");
    let mut i = ix();
    unsign_account(&mut i, "redeem", "user");
    env.send(&[i], &bob_kp, &[]).expect_code(anchor_err::ACCOUNT_NOT_SIGNER);

    // The winning redemption works and cannot be repeated beyond the balance.
    env.redeem("alice", &m, "above", a).must();
    env.redeem("alice", &m, "above", 1).expect_code(1);
}

#[test]
fn void_redeem_rejects_dust() {
    let (mut env, m) = fixture();
    env.set_time(m.settle_ts + 3_600);
    env.void(&m).must();
    // One share is worth less than one base unit at 0.5 each.
    env.redeem("alice", &m, "above", 1).expect_gg("AmountTooSmall");
    env.redeem("alice", &m, "above", 2).must();
}

/* ------------------------------ remove_liquidity ------------------------------ */

#[test]
fn remove_liquidity_rejections() {
    let (mut env, m) = fixture();
    let maker = env.clone_kp("maker");

    // Before settlement.
    env.remove_liquidity("maker", &m, 100 * USDC).expect_gg("NotResolved");

    env.set_time(m.settle_ts);
    env.settle_with(&m, &price(&m, 20_000_000_000, 0)).must();
    env.remove_liquidity("maker", &m, 0).expect_gg("InvalidLpAmount");
    env.remove_liquidity("maker", &m, 500 * USDC + 1).expect_gg("InvalidLpAmount");
    // A wallet with no LP tokens cannot withdraw (its token account does not exist).
    env.remove_liquidity("alice", &m, 1).expect_fail();

    let b = env.ixb();
    let ix = || b.remove_liquidity_ix(&maker.pubkey(), &m, 100 * USDC);
    let mut i = ix();
    replace_account(&mut i, "remove_liquidity", "vault", Address::new_unique());
    env.send(&[i], &maker, &[]).expect_gg("WrongVault");
    let mut i = ix();
    replace_account(&mut i, "remove_liquidity", "lp_mint", m.above);
    env.send(&[i], &maker, &[]).expect_gg("WrongMint");
    let mut i = ix();
    replace_account(&mut i, "remove_liquidity", "user_usdc", ata(&pk(&env, "bob"), &env.usdc));
    env.send(&[i], &maker, &[]).expect_gg("WrongTokenAccount");
    let mut i = ix();
    replace_account(&mut i, "remove_liquidity", "user_lp", ata(&pk(&env, "bob"), &m.lp));
    env.ensure_ata(&pk(&env, "bob"), &m.lp);
    env.send(&[i], &maker, &[]).expect_gg("WrongTokenAccount");
    let alice = env.clone_kp("alice");
    let mut i = ix();
    unsign_account(&mut i, "remove_liquidity", "user");
    env.send(&[i], &alice, &[]).expect_code(anchor_err::ACCOUNT_NOT_SIGNER);

    // Partial withdrawals are pro rata and never exceed the claim.
    let claim = env.market(&m).u("lp_claim_remaining");
    let before = env.usdc_of(&maker.pubkey());
    env.remove_liquidity("maker", &m, 125 * USDC).must();
    assert_eq!(env.usdc_of(&maker.pubkey()) - before, claim / 4);
    env.remove_liquidity("maker", &m, 375 * USDC).must();
    assert_eq!(env.usdc_of(&maker.pubkey()) - before, claim);
    assert_eq!(env.market(&m).u("lp_claim_remaining"), 0);
    env.remove_liquidity("maker", &m, 1).expect_gg("InvalidLpAmount");
}

#[test]
fn lp_tokens_are_transferable_and_split_the_claim() {
    // A second LP wallet holding half of the LP tokens gets half of the claim (floor).
    let (mut env, m) = fixture();
    let (maker, alice) = (pk(&env, "maker"), pk(&env, "alice"));
    // Move half the LP tokens by rewriting balances (SPL transfer semantics are not under test here).
    let half = 250 * USDC;
    let lp = m.lp;
    env.put_token_account(ata(&maker, &lp), &lp, &maker, half);
    env.put_token_account(ata(&alice, &lp), &lp, &alice, half);
    env.set_time(m.settle_ts);
    env.settle_with(&m, &price(&m, 26_000_000_000, 0)).must();
    let claim = env.market(&m).u("lp_claim_remaining");
    let b0 = env.usdc_of(&maker);
    env.remove_liquidity("maker", &m, half).must();
    let b1 = env.usdc_of(&alice);
    env.remove_liquidity("alice", &m, half).must();
    assert_eq!((env.usdc_of(&maker) - b0) + (env.usdc_of(&alice) - b1), claim);
}

/* ------------------------------ create_market ------------------------------ */

#[test]
fn create_market_rejections() {
    let mut env = Env::new();
    let def = MarketArgs::default();
    let mk = |env: &mut Env, a: MarketArgs, err: &str| {
        let (r, m) = env.create_market_result(&a);
        r.expect_gg(err);
        assert!(env.svm.get_account(&m.market).is_none(), "{err}: no market may be left behind");
    };
    // Touch markets and directions are reserved.
    mk(&mut env, MarketArgs { kind: 1, direction: 1, ..def.clone() }, "NotEnabledInThisVersion");
    mk(&mut env, MarketArgs { kind: 1, direction: 0, ..def.clone() }, "NotEnabledInThisVersion");
    mk(&mut env, MarketArgs { direction: 2, ..def.clone() }, "NotEnabledInThisVersion");
    // Target.
    mk(&mut env, MarketArgs { target_price: 0, ..def.clone() }, "InvalidTarget");
    mk(&mut env, MarketArgs { target_price: -1, ..def.clone() }, "InvalidTarget");
    mk(&mut env, MarketArgs { target_expo: 1, ..def.clone() }, "InvalidTarget");
    mk(&mut env, MarketArgs { target_expo: -19, ..def.clone() }, "InvalidTarget");
    // Fee tier.
    mk(&mut env, MarketArgs { base_fee_bps: 25, ..def.clone() }, "InvalidBaseFee");
    // Liquidity (config minimum is 100 USDC; the maker only owns 100_000 USDC).
    mk(&mut env, MarketArgs { liquidity: 100 * USDC - 1, ..def.clone() }, "LiquidityTooLow");
    mk(&mut env, MarketArgs { liquidity: 100_001 * USDC, ..def.clone() }, "LiquidityTooLow");
    // Duration: min 1800s, max 180 days, and the trading window must be non-empty.
    mk(&mut env, MarketArgs { settle_in: 1_799, ..def.clone() }, "DurationTooShort");
    mk(&mut env, MarketArgs { settle_in: 60, ..def.clone() }, "DurationTooShort");
    mk(&mut env, MarketArgs { settle_in: -5, ..def.clone() }, "DurationTooShort");
    mk(&mut env, MarketArgs { settle_in: 180 * 86_400 + 1, ..def.clone() }, "DurationTooLong");
    // Opening price outside [2%, 98%].
    mk(&mut env, MarketArgs { p0_bps: 199, ..def.clone() }, "InvalidOpeningPrice");
    mk(&mut env, MarketArgs { p0_bps: 9_801, ..def.clone() }, "InvalidOpeningPrice");
    mk(&mut env, MarketArgs { p0_bps: 0, ..def.clone() }, "InvalidOpeningPrice");
    // Bounds that are accepted.
    env.create_market(&MarketArgs { nonce: 50, settle_in: 1_800, p0_bps: 200, ..def.clone() });
    env.create_market(&MarketArgs { nonce: 51, settle_in: 180 * 86_400, p0_bps: 9_800, ..def.clone() });
}

#[test]
fn create_market_account_rejections() {
    let mut env = Env::new();
    let maker = env.clone_kp("maker");
    let def = MarketArgs::default();
    let (ix, m) = env.create_market_ix(&maker.pubkey(), &def);
    let send = |env: &mut Env, ix: solana_instruction::Instruction| env.send(&[compute_limit_ix(400_000), ix], &maker, &[]);

    // Feed never allowlisted.
    let (ix_f, _) = env.create_market_ix(&maker.pubkey(), &MarketArgs { feed_id: OTHER_FEED, ..def.clone() });
    send(&mut env, ix_f).expect_code(anchor_err::ACCOUNT_NOT_INITIALIZED);
    // Feed account of another id: seeds mismatch.
    let mut i = ix.clone();
    replace_account(&mut i, "create_market", "feed", feed_pda(&OTHER_FEED));
    send(&mut env, i).expect_fail();
    // Wrong collateral mint.
    let mut i = ix.clone();
    replace_account(&mut i, "create_market", "collateral_mint", Address::new_unique());
    send(&mut env, i).expect_gg("WrongCollateralMint");
    // Wrong PDAs for the vault and the mints.
    for acct in ["vault", "above_mint", "below_mint", "lp_mint"] {
        let mut i = ix.clone();
        replace_account(&mut i, "create_market", acct, Address::new_unique());
        send(&mut env, i).expect_code(anchor_err::CONSTRAINT_SEEDS);
    }
    // Creator collateral account of someone else / wrong mint.
    let mut i = ix.clone();
    replace_account(&mut i, "create_market", "creator_usdc", ata(&pk(&env, "alice"), &env.usdc));
    send(&mut env, i).expect_gg("WrongTokenAccount");
    // Creator ATAs for the wrong owner: the ATA program rejects the derivation.
    let mut i = ix.clone();
    replace_account(&mut i, "create_market", "creator_above", ata(&pk(&env, "alice"), &m.above));
    send(&mut env, i).expect_fail();
    // The creator must sign.
    let alice = env.clone_kp("alice");
    let mut unsigned = ix.clone();
    unsign_account(&mut unsigned, "create_market", "creator");
    env.send(&[compute_limit_ix(400_000), unsigned], &alice, &[]).expect_code(anchor_err::ACCOUNT_NOT_SIGNER);
    assert!(env.svm.get_account(&m.market).is_none());
    assert!(env.svm.get_account(&m.vault).is_none());

    // The valid one still works, and the same (creator, nonce) cannot be created twice.
    send(&mut env, ix.clone()).must();
    let snap = env.market(&m);
    env.set_time(T0 + 5);
    let (dup, _) = env.create_market_ix(&maker.pubkey(), &MarketArgs { liquidity: 200 * USDC, ..def.clone() });
    send(&mut env, dup).expect_fail();
    assert_eq!(env.market(&m).u("complete_sets"), snap.u("complete_sets"));
    assert_eq!(env.market(&m).i("settle_ts"), snap.i("settle_ts"));

    // Another creator can reuse the nonce (the creator is part of the PDA seeds).
    let (ix2, m2) = env.create_market_ix(&alice.pubkey(), &def);
    env.send(&[compute_limit_ix(400_000), ix2], &alice, &[]).must();
    assert_ne!(m.market, m2.market);
    assert_eq!(env.market(&m2).a("creator"), alice.pubkey());
}

#[test]
fn a_prefunded_market_pda_cannot_block_creation() {
    // Anyone can send lamports to the predictable vault/mint addresses before the market exists.
    let mut env = Env::new();
    let args = MarketArgs { nonce: 77, ..Default::default() };
    let m = env.market_ref(&pk(&env, "maker"), &args);
    for a in [m.vault, m.above, m.below, m.lp] {
        env.svm.airdrop(&a, 1_000_000).unwrap();
    }
    let (r, _) = env.create_market_result(&args);
    r.must();
    assert_eq!(env.market(&m).e("status"), "open");
    assert_eq!(env.vault_balance(&m), 500 * USDC);
}

#[test]
fn donations_to_the_vault_do_not_break_trading_or_payouts() {
    let (mut env, m) = fixture();
    // Somebody sends 25 USDC straight to the vault.
    let v = env.token_amount(&m.vault);
    let usdc = env.usdc;
    let owner = m.market;
    env.put_token_account(m.vault, &usdc, &owner, v + 25 * USDC);
    env.buy("alice", &m, "above", 10 * USDC, 0).must();
    env.sell("bob", &m, "below", 5 * USDC, 0).must();
    let f = env.market(&m);
    assert!(env.vault_balance(&m) >= f.u("complete_sets") + f.u("fee_pool"));
}
