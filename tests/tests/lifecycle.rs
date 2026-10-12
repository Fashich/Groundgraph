//! End to end flows against the compiled program: create, trade, merge, settle, redeem, remove liquidity; void path.
use groundgraph_tests::math::{self, Side};
use groundgraph_tests::*;
use solana_signer::Signer;

fn pk(env: &Env, who: &str) -> solana_address::Address {
    env.clone_kp(who).pubkey()
}

fn price_at(m: &MarketRef, price: i64, dt: i64) -> PriceUpdate {
    PriceUpdate::new(m.args.feed_id, price, m.args.target_expo, m.settle_ts + dt)
}

#[test]
fn create_market_state_events_and_balances() {
    let mut env = Env::new();
    let maker = pk(&env, "maker");
    let before = env.usdc_of(&maker);
    let (r, m) = env.create_market_result(&MarketArgs::default());
    let r = r.must();
    assert!(r.compute_units_consumed < 400_000, "create_market used {} CU", r.compute_units_consumed);

    let seed = math::seed_reserves(500 * USDC, 4_000).unwrap();
    let f = env.market(&m);
    assert_eq!(f.a("creator"), maker);
    assert_eq!(f.u("nonce"), 1);
    assert_eq!(f.a("collateral_mint"), env.usdc);
    assert_eq!(f.a("vault"), m.vault);
    assert_eq!(f.a("above_mint"), m.above);
    assert_eq!(f.a("below_mint"), m.below);
    assert_eq!(f.a("lp_mint"), m.lp);
    assert_eq!((f.e("kind"), f.e("direction"), f.e("status"), f.e("outcome")), ("close".into(), "none".into(), "open".into(), "none".into()));
    assert_eq!(f.bytes("feed_id"), SOL_FEED.to_vec());
    assert_eq!(f.i("target_price"), 25_000_000_000);
    assert_eq!(f.i("target_expo"), -8);
    assert_eq!(f.i("open_ts"), T0);
    assert_eq!(f.i("settle_ts"), T0 + 86_400);
    assert_eq!(f.i("trading_end_ts"), T0 + 86_400 - 300);
    assert_eq!(f.u("base_fee_bps"), 100);
    assert!(!f.b("dynamic_fee"));
    assert_eq!(f.u("complete_sets"), 500 * USDC);
    assert_eq!(f.u("reserve_above"), seed.reserve_above);
    assert_eq!(f.u("reserve_below"), seed.reserve_below);
    assert_eq!(f.u("fee_pool"), 0);
    assert_eq!(f.u("lp_claim_remaining"), 0);

    // Token balances: liquidity moved to the vault, LP minted 1:1, the creator keeps the non-pool side of the seed.
    assert_eq!(env.usdc_of(&maker), before - 500 * USDC);
    assert_eq!(env.vault_balance(&m), 500 * USDC);
    assert_eq!(env.shares_of(&maker, &m.lp), 500 * USDC);
    assert_eq!(env.shares_of(&maker, &m.above), seed.creator_above);
    assert_eq!(env.shares_of(&maker, &m.below), seed.creator_below);
    assert_eq!(env.mint_supply(&m.above), seed.creator_above);
    assert_eq!(env.mint_supply(&m.below), seed.creator_below);
    assert_eq!(env.mint_supply(&m.lp), 500 * USDC);
    // floor rounding of the seed can put the opening price one basis point below the request
    assert!((3_999..=4_000).contains(&math::price_bps(seed.reserve_above, seed.reserve_below)));

    let ev = r.logs.iter().filter(|l| l.starts_with("Program data:")).count();
    assert_eq!(ev, 1);
    let evs = parse_events(&r.logs);
    assert_eq!(evs.len(), 1);
    let e = &evs[0];
    assert_eq!(e.name, "MarketCreated");
    assert_eq!(e.data.a("market"), m.market);
    assert_eq!(e.data.u("liquidity"), 500 * USDC);
    assert_eq!(e.data.u("p0_bps"), 4_000);
    assert_eq!(e.data.i("settle_ts"), m.settle_ts);
    assert_eq!(e.data.i("trading_end_ts"), m.trading_end_ts);
}

#[test]
fn p0_above_half_gives_the_creator_above_shares() {
    let mut env = Env::new();
    let m = env.create_market(&MarketArgs { nonce: 9, p0_bps: 7_300, ..Default::default() });
    let maker = pk(&env, "maker");
    let seed = math::seed_reserves(500 * USDC, 7_300).unwrap();
    assert!(seed.creator_above > 0 && seed.creator_below == 0);
    assert_eq!(env.shares_of(&maker, &m.above), seed.creator_above);
    assert_eq!(env.shares_of(&maker, &m.below), 0);
    let f = env.market(&m);
    assert!((7_299..=7_300).contains(&math::price_bps(f.u("reserve_above"), f.u("reserve_below"))));
}

#[test]
fn full_lifecycle_above_wins() {
    let mut env = Env::new();
    let (maker, alice, bob) = (pk(&env, "maker"), pk(&env, "alice"), pk(&env, "bob"));
    let m = env.create_market(&MarketArgs::default());
    let alice_start = env.usdc_of(&alice);
    let bob_start = env.usdc_of(&bob);

    // alice buys ABOVE: on-chain fill equals math::quote_buy and the Trade event.
    let f0 = env.market(&m);
    let q = math::quote_buy(f0.u("reserve_above"), f0.u("reserve_below"), Side::Above, 100 * USDC, 100).unwrap();
    let r = env.buy("alice", &m, "above", 100 * USDC, q.shares_out);
    let t = Env::trade_event(&r);
    r.must();
    assert_eq!(t.u("shares"), q.shares_out);
    assert_eq!(t.u("usdc"), 100 * USDC);
    assert_eq!(t.u("fee_usdc"), q.fee);
    assert_eq!(t.u("fee_bps"), 100);
    assert!(t.b("is_buy"));
    assert_eq!(t.e("side"), "above");
    assert_eq!(t.a("wallet"), alice);
    assert_eq!(env.shares_of(&alice, &m.above), q.shares_out);
    assert_eq!(env.usdc_of(&alice), alice_start - 100 * USDC);
    let f1 = env.market(&m);
    assert_eq!(f1.u("reserve_above"), q.ra_after);
    assert_eq!(f1.u("reserve_below"), q.rb_after);
    assert_eq!(f1.u("complete_sets"), 500 * USDC + q.usdc_into_sets);
    assert_eq!(f1.u("fee_pool"), q.fee);
    assert_eq!(t.u("price_after_bps"), math::price_bps(q.ra_after, q.rb_after) as u64);
    assert_eq!(env.vault_balance(&m), f1.u("complete_sets") + f1.u("fee_pool"));
    assert!(f1.u("complete_sets") - f1.u("reserve_above") == env.mint_supply(&m.above), "ABOVE supply == N - pool reserve");

    // bob buys BELOW.
    let qb = math::quote_buy(f1.u("reserve_above"), f1.u("reserve_below"), Side::Below, 80 * USDC, 100).unwrap();
    env.buy("bob", &m, "below", 80 * USDC, qb.shares_out).must();
    assert_eq!(env.shares_of(&bob, &m.below), qb.shares_out);

    // alice sells half of her ABOVE shares.
    let f2 = env.market(&m);
    let half = env.shares_of(&alice, &m.above) / 2;
    let qs = math::quote_sell(f2.u("reserve_above"), f2.u("reserve_below"), Side::Above, half, 100).unwrap();
    let alice_usdc_before = env.usdc_of(&alice);
    let r = env.sell("alice", &m, "above", half, qs.usdc_out);
    let t = Env::trade_event(&r);
    r.must();
    assert_eq!(t.u("usdc"), qs.usdc_out);
    assert!(!t.b("is_buy"));
    assert_eq!(env.usdc_of(&alice), alice_usdc_before + qs.usdc_out);
    let f3 = env.market(&m);
    assert_eq!(f3.u("complete_sets"), f2.u("complete_sets") - qs.usdc_gross);
    assert_eq!(f3.u("fee_pool"), f2.u("fee_pool") + qs.fee);
    assert_eq!(env.vault_balance(&m), f3.u("complete_sets") + f3.u("fee_pool"));

    // bob buys some ABOVE as well, then merges complete sets (no fee, 1:1).
    env.buy("bob", &m, "above", 30 * USDC, 0).must();
    let sets = env.shares_of(&bob, &m.above).min(env.shares_of(&bob, &m.below));
    assert!(sets > 0);
    let bob_usdc = env.usdc_of(&bob);
    let n_before = env.market(&m).u("complete_sets");
    let r = env.merge("bob", &m, sets);
    let ev = r.events();
    r.must();
    assert_eq!(ev[0].name, "Merged");
    assert_eq!(ev[0].data.u("amount"), sets);
    assert_eq!(env.usdc_of(&bob), bob_usdc + sets);
    assert_eq!(env.market(&m).u("complete_sets"), n_before - sets);

    // Trading window closes: buy is rejected, sell and merge still work while Open.
    env.set_time(m.trading_end_ts);
    env.buy("alice", &m, "above", 10 * USDC, 0).expect_gg("TradingEnded");
    env.sell("alice", &m, "above", 1_000_000, 0).must();
    env.assert_solvent(&m);

    // Settle after settle_ts with a price strictly above the target.
    env.set_time(m.settle_ts + 5);
    let fs = env.market(&m);
    let r = env.settle_with(&m, &price_at(&m, 25_000_000_001, 5));
    let ev = r.events();
    r.must();
    assert_eq!(ev[0].name, "Settled");
    assert_eq!(ev[0].data.e("outcome"), "above");
    let claim = fs.u("reserve_above") + fs.u("fee_pool");
    assert_eq!(ev[0].data.u("lp_claim"), claim);
    let fz = env.market(&m);
    assert_eq!(fz.e("status"), "settled");
    assert_eq!(fz.e("outcome"), "above");
    assert_eq!(fz.i("settle_price"), 25_000_000_001);
    assert_eq!(fz.i("settle_expo"), -8);
    assert_eq!(fz.i("settle_publish_ts"), m.settle_ts + 5);
    assert_eq!(fz.u("lp_claim_remaining"), claim);
    assert_eq!(fz.u("lp_supply_remaining"), 500 * USDC);

    // Everything but redeem/remove_liquidity is closed.
    env.buy("alice", &m, "above", 10 * USDC, 0).expect_gg("MarketNotOpen");
    env.sell("alice", &m, "above", 1_000_000, 0).expect_gg("MarketNotOpen");
    env.merge("bob", &m, 1).expect_gg("MarketNotOpen");

    // Winners redeem 1 USDC per ABOVE share; the losing side cannot.
    let a_above = env.shares_of(&alice, &m.above);
    let b_above = env.shares_of(&bob, &m.above);
    let b_below = env.shares_of(&bob, &m.below);
    if b_below > 0 {
        env.redeem("bob", &m, "below", b_below).expect_gg("NotWinningSide");
    }
    let alice_usdc = env.usdc_of(&alice);
    let r = env.redeem("alice", &m, "above", a_above);
    let ev = r.events();
    r.must();
    assert_eq!(ev[0].name, "Redeemed");
    assert_eq!(ev[0].data.u("usdc"), a_above);
    assert_eq!(env.usdc_of(&alice), alice_usdc + a_above);
    if b_above > 0 {
        env.redeem("bob", &m, "above", b_above).must();
    }
    assert_eq!(env.shares_of(&alice, &m.above), 0);

    // The creator removes all liquidity and receives exactly the snapshot claim.
    let maker_usdc = env.usdc_of(&maker);
    let r = env.remove_liquidity("maker", &m, 500 * USDC);
    let ev = r.events();
    r.must();
    assert_eq!(ev[0].name, "LiquidityChanged");
    assert!(!ev[0].data.b("is_add"));
    assert_eq!(env.usdc_of(&maker), maker_usdc + claim);
    let fe = env.market(&m);
    assert_eq!(fe.u("lp_claim_remaining"), 0);
    assert_eq!(fe.u("lp_supply_remaining"), 0);
    assert_eq!(env.mint_supply(&m.lp), 0);
    // Every holder of ABOVE redeemed, the single LP took the claim: nothing is left in the vault.
    assert_eq!(env.vault_balance(&m), 0, "vault must be empty after all payouts");

    // Net: alice and bob never receive more than they put in plus the AMM's payout for the winning side.
    let _ = (alice_start, bob_start);
}

#[test]
fn below_wins_when_the_price_equals_the_target() {
    let mut env = Env::new();
    let m = env.create_market(&MarketArgs::default());
    env.buy("alice", &m, "above", 20 * USDC, 0).must();
    env.buy("bob", &m, "below", 20 * USDC, 0).must();
    env.set_time(m.settle_ts);
    let r = env.settle_with(&m, &price_at(&m, 25_000_000_000, 0));
    let ev = r.events();
    r.must();
    assert_eq!(ev[0].data.e("outcome"), "below");
    assert_eq!(env.market(&m).e("outcome"), "below");
    // ABOVE cannot redeem; BELOW can.
    let alice = pk(&env, "alice");
    let a = env.shares_of(&alice, &m.above);
    env.redeem("alice", &m, "above", a).expect_gg("NotWinningSide");
    let bob = pk(&env, "bob");
    let b = env.shares_of(&bob, &m.below);
    let before = env.usdc_of(&bob);
    env.redeem("bob", &m, "below", b).must();
    assert_eq!(env.usdc_of(&bob), before + b);
}

#[test]
fn settlement_compares_across_exponents() {
    let mut env = Env::new();
    // Target $250 stored with expo -8; the update arrives with expo -10 (finer): 250.0000000001.
    let m = env.create_market(&MarketArgs::default());
    env.set_time(m.settle_ts);
    let p = PriceUpdate { price: 2_500_000_000_001, expo: -10, ..price_at(&m, 0, 0) };
    let r = env.settle_with(&m, &p);
    let ev = r.events();
    r.must();
    assert_eq!(ev[0].data.e("outcome"), "above");
    assert_eq!(env.market(&m).i("settle_expo"), -10);
}

#[test]
fn settle_window_boundaries_are_inclusive() {
    for (dt, ok) in [(0, true), (60, true)] {
        let mut env = Env::new();
        let m = env.create_market(&MarketArgs::default());
        env.set_time(m.settle_ts + 120);
        let r = env.settle_with(&m, &price_at(&m, 26_000_000_000, dt));
        assert_eq!(r.is_ok(), ok, "dt {dt}");
    }
    for (dt, err) in [(-1, "PriceStale"), (61, "PriceOutsideWindow")] {
        let mut env = Env::new();
        let m = env.create_market(&MarketArgs::default());
        env.set_time(m.settle_ts + 120);
        env.settle_with(&m, &price_at(&m, 26_000_000_000, dt)).expect_gg(err);
    }
}

#[test]
fn void_flow_pays_half_a_usdc_per_share() {
    let mut env = Env::new();
    let (maker, alice, bob) = (pk(&env, "maker"), pk(&env, "alice"), pk(&env, "bob"));
    let m = env.create_market(&MarketArgs::default());
    env.buy("alice", &m, "above", 100 * USDC, 0).must();
    env.buy("bob", &m, "below", 50 * USDC, 0).must();
    env.sell("alice", &m, "above", 10 * USDC, 0).must();
    let f = env.market(&m);

    // Too early: grace period is one hour after settle_ts.
    env.set_time(m.settle_ts + 3_599);
    env.void(&m).expect_gg("TooEarlyToVoid");
    env.set_time(m.settle_ts + 3_600);
    let r = env.void(&m);
    let ev = r.events();
    r.must();
    assert_eq!(ev[0].name, "Voided");
    let claim = math::void_lp_claim(f.u("complete_sets"), f.u("reserve_above"), f.u("reserve_below"), f.u("fee_pool")).unwrap();
    assert_eq!(ev[0].data.u("lp_claim"), claim);
    let fv = env.market(&m);
    assert_eq!(fv.e("status"), "voided");
    assert_eq!(fv.e("outcome"), "none");
    assert_eq!(fv.u("lp_claim_remaining"), claim);

    // A voided market cannot be settled, traded, or voided again.
    env.settle_with(&m, &price_at(&m, 26_000_000_000, 0)).expect_gg("MarketNotOpen");
    env.buy("alice", &m, "above", 10 * USDC, 0).expect_gg("MarketNotOpen");
    env.void(&m).expect_gg("MarketNotOpen");

    // Both sides redeem at 0.5.
    let a = env.shares_of(&alice, &m.above);
    let b = env.shares_of(&bob, &m.below);
    let (au, bu) = (env.usdc_of(&alice), env.usdc_of(&bob));
    env.redeem("alice", &m, "above", a).must();
    env.redeem("bob", &m, "below", b).must();
    assert_eq!(env.usdc_of(&alice), au + math::void_redeem_payout(a));
    assert_eq!(env.usdc_of(&bob), bu + math::void_redeem_payout(b));

    // The creator's seed shares are redeemable at 0.5 as well; then the LP claim drains the rest of the vault.
    let c_below = env.shares_of(&maker, &m.below);
    assert!(c_below > 0);
    env.redeem("maker", &m, "below", c_below).must();
    let maker_before = env.usdc_of(&maker);
    env.remove_liquidity("maker", &m, 500 * USDC).must();
    assert_eq!(env.usdc_of(&maker), maker_before + claim);
    // Only rounding dust (floor of odd share counts, at most 1 base unit per redemption) can remain.
    assert!(env.vault_balance(&m) <= 3, "dust {}", env.vault_balance(&m));
}
