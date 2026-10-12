//! Randomized end-to-end runs: random trade sequences through the real program in LiteSVM, compared at every step with
//! the pure model in `math.rs`, followed by a random resolution and a full drain of the vault.
use groundgraph_tests::math::{self, Side};
use groundgraph_tests::*;
use proptest::prelude::*;

#[derive(Debug, Clone)]
enum Op {
    Buy { who: bool, side: bool, amount: u64, dt: u32 },
    Sell { who: bool, side: bool, frac: u8, dt: u32 },
    Merge { who: bool, frac: u8, dt: u32 },
}

fn op() -> impl Strategy<Value = Op> {
    prop_oneof![
        4 => (any::<bool>(), any::<bool>(), 1u64..3_000, 0u32..500).prop_map(|(who, side, a, dt)| Op::Buy { who, side, amount: a * USDC + a * 1_234 % USDC, dt }),
        3 => (any::<bool>(), any::<bool>(), 1u8..=100, 0u32..500).prop_map(|(who, side, frac, dt)| Op::Sell { who, side, frac, dt }),
        1 => (any::<bool>(), 1u8..=100, 0u32..500).prop_map(|(who, frac, dt)| Op::Merge { who, frac, dt }),
    ]
}

#[derive(Debug, Clone, Copy)]
enum Resolution {
    AboveWins,
    BelowWins,
    Void,
}

fn model_fee(env: &Env, m: &MarketRef, now: i64) -> u16 {
    let f = env.market(m);
    math::fee_bps_now(
        f.u("base_fee_bps") as u16,
        f.b("dynamic_fee"),
        env.config().u("max_fee_bps") as u16,
        f.u("ema_impact_bps") as u32,
        f.i("ema_ts"),
        f.i("settle_ts"),
        now,
    )
    .total
}

fn check_invariants(env: &Env, m: &MarketRef) {
    let f = env.market(m);
    let (n, ra, rb, fees) = (f.u("complete_sets"), f.u("reserve_above"), f.u("reserve_below"), f.u("fee_pool"));
    assert_eq!(env.vault_balance(m), n + fees, "vault == N + fee_pool");
    assert_eq!(env.mint_supply(&m.above), n - ra, "ABOVE supply == N - pool reserve");
    assert_eq!(env.mint_supply(&m.below), n - rb, "BELOW supply == N - pool reserve");
    assert!(ra < math::MAX_RESERVE && rb < math::MAX_RESERVE && ra > 0 && rb > 0);
}

fn run_case(p0: u16, base_fee: u16, dynamic: bool, ops: Vec<Op>, res: Resolution) {
    let mut env = Env::new();
    for who in ["alice", "bob"] {
        let a = env.addr(who);
        env.fund_usdc(&a, 1_000_000 * USDC);
    }
    let m = env.create_market(&MarketArgs { p0_bps: p0, base_fee_bps: base_fee, dynamic_fee: dynamic, settle_in: 7_200, ..Default::default() });
    check_invariants(&env, &m);
    let who = |b: bool| if b { "alice" } else { "bob" };

    for o in ops {
        let (dt, w) = match &o {
            Op::Buy { dt, who: w, .. } | Op::Sell { dt, who: w, .. } | Op::Merge { dt, who: w, .. } => (*dt, who(*w)),
        };
        let now = (env.now() + dt as i64).min(m.settle_ts - 1);
        env.set_time(now);
        let f = env.market(&m);
        let (ra, rb) = (f.u("reserve_above"), f.u("reserve_below"));
        let me = env.addr(w);
        match o {
            Op::Buy { side, amount, .. } => {
                let s = if side { Side::Below } else { Side::Above };
                let name = if side { "below" } else { "above" };
                let fee = model_fee(&env, &m, now);
                let q = math::quote_buy(ra, rb, s, amount, fee).unwrap();
                let r = env.buy(w, &m, name, amount, 0);
                if now >= m.trading_end_ts {
                    r.expect_gg("TradingEnded");
                    continue;
                }
                if q.shares_out == 0 {
                    r.expect_gg("SlippageExceeded");
                    continue;
                }
                let t = Env::trade_event(&r);
                r.must();
                assert_eq!(t.u("shares"), q.shares_out);
                assert_eq!(t.u("fee_usdc"), q.fee);
                assert_eq!(t.u("fee_bps"), fee as u64);
                let g = env.market(&m);
                assert_eq!((g.u("reserve_above"), g.u("reserve_below")), (q.ra_after, q.rb_after));
                assert_eq!(g.u("complete_sets"), f.u("complete_sets") + q.usdc_into_sets);
                assert_eq!(g.u("fee_pool"), f.u("fee_pool") + q.fee);
                if dynamic {
                    let impact = math::impact_bps(ra, rb, q.ra_after, q.rb_after);
                    assert_eq!(g.u("ema_impact_bps"), math::update_ema(f.u("ema_impact_bps") as u32, f.i("ema_ts"), impact, now) as u64);
                    assert_eq!(g.i("ema_ts"), now);
                } else {
                    assert_eq!(g.u("ema_impact_bps"), f.u("ema_impact_bps"));
                }
            }
            Op::Sell { side, frac, .. } => {
                let mint = if side { m.below } else { m.above };
                let held = env.shares_of(&me, &mint);
                let shares = held * frac as u64 / 100;
                if shares == 0 {
                    continue;
                }
                let s = if side { Side::Below } else { Side::Above };
                let name = if side { "below" } else { "above" };
                let fee = model_fee(&env, &m, now);
                let r = env.sell(w, &m, name, shares, 0);
                match math::quote_sell(ra, rb, s, shares, fee) {
                    Ok(q) if q.usdc_gross >= math::MIN_SELL_GROSS_USDC => {
                        let t = Env::trade_event(&r);
                        r.must();
                        assert_eq!(t.u("usdc"), q.usdc_out);
                        assert_eq!(t.u("fee_usdc"), q.fee);
                        let g = env.market(&m);
                        assert_eq!((g.u("reserve_above"), g.u("reserve_below")), (q.ra_after, q.rb_after));
                        assert_eq!(g.u("complete_sets"), f.u("complete_sets") - q.usdc_gross);
                    }
                    Ok(_) => r.expect_gg("SellTooSmall"),
                    Err(_) => r.expect_fail(),
                }
            }
            Op::Merge { frac, .. } => {
                let sets = env.shares_of(&me, &m.above).min(env.shares_of(&me, &m.below)) * frac as u64 / 100;
                if sets == 0 {
                    continue;
                }
                let usdc = env.usdc_of(&me);
                env.merge(w, &m, sets).must();
                assert_eq!(env.usdc_of(&me), usdc + sets);
                assert_eq!(env.market(&m).u("complete_sets"), f.u("complete_sets") - sets);
            }
        }
        check_invariants(&env, &m);
    }

    // Resolve.
    let actors = [env.addr("alice"), env.addr("bob"), env.addr("maker")];
    let names = ["alice", "bob", "maker"];
    match res {
        Resolution::AboveWins | Resolution::BelowWins => {
            env.set_time(m.settle_ts);
            let price = if matches!(res, Resolution::AboveWins) { 25_000_000_001 } else { 25_000_000_000 };
            env.settle_with(&m, &PriceUpdate::new(SOL_FEED, price, -8, m.settle_ts)).must();
            let (win_side, win_mint) = if matches!(res, Resolution::AboveWins) { ("above", m.above) } else { ("below", m.below) };
            for (a, n) in actors.iter().zip(names) {
                let bal = env.shares_of(a, &win_mint);
                if bal > 0 {
                    let before = env.usdc_of(a);
                    env.redeem(n, &m, win_side, bal).must();
                    assert_eq!(env.usdc_of(a), before + bal, "winners get exactly 1 USDC per share");
                }
            }
            let claim = env.market(&m).u("lp_claim_remaining");
            let before = env.usdc_of(&actors[2]);
            env.remove_liquidity("maker", &m, 500 * USDC).must();
            assert_eq!(env.usdc_of(&actors[2]) - before, claim);
            assert_eq!(env.vault_balance(&m), 0, "every unit of collateral is accounted for");
        }
        Resolution::Void => {
            env.set_time(m.settle_ts + 3_600);
            env.void(&m).must();
            let mut redeems = 0u64;
            for (a, n) in actors.iter().zip(names) {
                for (side, mint) in [("above", m.above), ("below", m.below)] {
                    let bal = env.shares_of(a, &mint);
                    if bal >= 2 {
                        env.redeem(n, &m, side, bal).must();
                        redeems += 1;
                    }
                }
            }
            env.remove_liquidity("maker", &m, 500 * USDC).must();
            assert!(env.vault_balance(&m) <= redeems + 1, "dust {} after {redeems} redemptions", env.vault_balance(&m));
        }
    }
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 60, max_shrink_iters: 200, .. ProptestConfig::default() })]

    #[test]
    fn random_sequences_match_the_model_and_drain_exactly(
        p0 in 300u16..9_700,
        base_fee in prop::sample::select(vec![50u16, 100, 200]),
        dynamic in any::<bool>(),
        ops in prop::collection::vec(op(), 1..22),
        res in prop_oneof![Just(Resolution::AboveWins), Just(Resolution::BelowWins), Just(Resolution::Void)],
    ) {
        run_case(p0, base_fee, dynamic, ops, res);
    }
}
