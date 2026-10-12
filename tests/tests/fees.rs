//! Fee tiers and the dynamic fee (near expiry + recent flow), checked against `math::fee_bps_now` on the on-chain state.
use groundgraph_tests::math::{self, Side};
use groundgraph_tests::*;
use solana_signer::Signer;

fn fee_expected(env: &Env, m: &MarketRef) -> math::FeeParts {
    let f = env.market(m);
    math::fee_bps_now(
        f.u("base_fee_bps") as u16,
        f.b("dynamic_fee"),
        env.config().u("max_fee_bps") as u16,
        f.u("ema_impact_bps") as u32,
        f.i("ema_ts"),
        f.i("settle_ts"),
        env.now(),
    )
}

#[test]
fn base_fee_tiers_charge_the_exact_ceiling_on_buy_and_sell() {
    for (i, bps) in [50u16, 100, 200].into_iter().enumerate() {
        let mut env = Env::new();
        let m = env.create_market(&MarketArgs { nonce: 10 + i as u64, base_fee_bps: bps, ..Default::default() });
        let alice = env.clone_kp("alice").pubkey();

        let r = env.buy("alice", &m, "above", 100 * USDC, 0);
        let t = Env::trade_event(&r);
        r.must();
        let fee = (100 * USDC * bps as u64).div_ceil(10_000);
        assert_eq!(t.u("fee_usdc"), fee, "buy fee at {bps} bps");
        assert_eq!(t.u("fee_bps"), bps as u64);
        assert_eq!(env.market(&m).u("fee_pool"), fee);
        assert_eq!(env.market(&m).u("complete_sets"), 500 * USDC + 100 * USDC - fee);

        // A sell charges the fee on the gross proceeds.
        let shares = env.shares_of(&alice, &m.above) / 3;
        let f = env.market(&m);
        let q = math::quote_sell(f.u("reserve_above"), f.u("reserve_below"), Side::Above, shares, bps).unwrap();
        let r = env.sell("alice", &m, "above", shares, 0);
        let t = Env::trade_event(&r);
        r.must();
        assert_eq!(t.u("fee_usdc"), (q.usdc_gross * bps as u64).div_ceil(10_000));
        assert_eq!(t.u("usdc"), q.usdc_gross - t.u("fee_usdc"));
        assert_eq!(env.market(&m).u("fee_pool"), fee + t.u("fee_usdc"));
        env.assert_solvent(&m);
    }
}

#[test]
fn only_the_three_listed_base_fees_are_accepted() {
    let mut env = Env::new();
    for (i, bps) in [0u16, 1, 49, 75, 150, 201, 300, 10_000].into_iter().enumerate() {
        let (r, _) = env.create_market_result(&MarketArgs { nonce: 100 + i as u64, base_fee_bps: bps, ..Default::default() });
        r.expect_gg("InvalidBaseFee");
    }
}

#[test]
fn dynamic_fee_adds_a_near_expiry_component() {
    let mut env = Env::new();
    // 48h to settle: near = 80 * (72h - 48h) / 72h = 26 bps; a flow component is zero while the EMA is zero.
    let m = env.create_market(&MarketArgs { dynamic_fee: true, settle_in: 48 * 3_600, base_fee_bps: 100, ..Default::default() });
    let want = fee_expected(&env, &m);
    assert_eq!((want.base, want.near, want.flow, want.total), (100, 26, 0, 126));
    let r = env.buy("alice", &m, "above", 10 * USDC, 0);
    assert_eq!(Env::trade_event(&r).u("fee_bps"), 126);
    r.must();

    // 24h later the near component has grown: 80 * (72 - 24) / 72 = 53 bps.
    env.advance(24 * 3_600 - 5);
    let want = fee_expected(&env, &m);
    assert_eq!(want.near, 53);
    let r = env.buy("alice", &m, "above", 10 * USDC, 0);
    let t = Env::trade_event(&r);
    r.must();
    assert_eq!(t.u("fee_bps"), want.total as u64);
    assert_eq!(t.u("fee_bps"), 100 + 53 + want.flow as u64);

    // Static markets ignore all of it.
    let s = env.create_market(&MarketArgs { nonce: 2, dynamic_fee: false, settle_in: 48 * 3_600, ..Default::default() });
    let r = env.buy("alice", &s, "above", 10 * USDC, 0);
    assert_eq!(Env::trade_event(&r).u("fee_bps"), 100);
    r.must();
    assert_eq!(env.market(&s).u("ema_impact_bps"), 0);
}

#[test]
fn dynamic_fee_flow_component_follows_the_decayed_ema() {
    let mut env = Env::new();
    // 100h to settle keeps the near component at zero, so only the flow component moves.
    let m = env.create_market(&MarketArgs { dynamic_fee: true, settle_in: 100 * 3_600, ..Default::default() });
    env.advance(1_800);
    let f0 = env.market(&m);
    // A large trade after 30 minutes: the new observation gets half the weight.
    let q = math::quote_buy(f0.u("reserve_above"), f0.u("reserve_below"), Side::Above, 1_000 * USDC, 100).unwrap();
    let impact = math::impact_bps(f0.u("reserve_above"), f0.u("reserve_below"), q.ra_after, q.rb_after);
    assert!(impact > 500, "test needs a big move, got {impact}");
    env.buy("alice", &m, "above", 1_000 * USDC, 0).must();
    let f1 = env.market(&m);
    let expected_ema = math::update_ema(0, T0, impact, T0 + 1_800);
    assert_eq!(f1.u("ema_impact_bps"), expected_ema as u64);
    assert_eq!(f1.i("ema_ts"), T0 + 1_800);
    assert!(expected_ema > 100);

    // The next trade pays base + flow, with flow = min(ema/4, 50).
    let want = fee_expected(&env, &m);
    assert_eq!(want.near, 0);
    assert!(want.flow > 0);
    let r = env.buy("bob", &m, "below", 5 * USDC, 0);
    let t = Env::trade_event(&r);
    r.must();
    assert_eq!(t.u("fee_bps"), (100 + want.flow) as u64);

    // After a quiet period the flow component fades: 3 hours is six half-lives.
    env.advance(3 * 3_600);
    let later = fee_expected(&env, &m);
    assert!(later.flow < want.flow, "flow {} should decay below {}", later.flow, want.flow);
    let r = env.buy("bob", &m, "below", 5 * USDC, 0);
    assert_eq!(Env::trade_event(&r).u("fee_bps"), later.total as u64);
    r.must();
}

#[test]
fn total_fee_never_exceeds_the_config_cap() {
    let mut env = Env::new();
    // base 200 + near ~79 + flow up to 50 would be 329; the cap is 300.
    let m = env.create_market(&MarketArgs { dynamic_fee: true, base_fee_bps: 200, settle_in: 3_600, ..Default::default() });
    env.advance(1_500);
    env.buy("alice", &m, "above", 1_500 * USDC, 0).must();
    env.advance(60);
    let want = fee_expected(&env, &m);
    assert!(want.base as u32 + want.near as u32 + want.flow as u32 > 300, "setup must exceed the cap: {want:?}");
    assert_eq!(want.total, 300);
    let r = env.buy("bob", &m, "below", 5 * USDC, 0);
    assert_eq!(Env::trade_event(&r).u("fee_bps"), 300);
    r.must();

    // Lowering the cap in config applies immediately to existing markets.
    env.update_config("admin", &ConfigUpdate { max_fee_bps: Some(250), ..Default::default() }).must();
    let r = env.buy("bob", &m, "below", 5 * USDC, 0);
    assert_eq!(Env::trade_event(&r).u("fee_bps"), 250);
    r.must();
}

#[test]
fn fee_on_sell_uses_the_same_dynamic_rate() {
    let mut env = Env::new();
    let m = env.create_market(&MarketArgs { dynamic_fee: true, settle_in: 48 * 3_600, ..Default::default() });
    env.buy("alice", &m, "above", 50 * USDC, 0).must();
    let alice = env.clone_kp("alice").pubkey();
    let shares = env.shares_of(&alice, &m.above) / 2;
    let want = fee_expected(&env, &m);
    let r = env.sell("alice", &m, "above", shares, 0);
    let t = Env::trade_event(&r);
    r.must();
    assert_eq!(t.u("fee_bps"), want.total as u64);
}
