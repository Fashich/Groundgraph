//! Compute unit budget. Run with `--nocapture` to print the table that is copied into docs/AMM.md.
use groundgraph_tests::*;

const CREATE_LIMIT: u64 = 400_000;
const TRADE_LIMIT: u64 = 200_000;

#[test]
fn compute_unit_report() {
    let mut env = Env::new();
    // Exercise every instruction, on both a static and a dynamic-fee market, and on a market with a long history.
    let s = env.create_market(&MarketArgs { nonce: 1, ..Default::default() });
    let d = env.create_market(&MarketArgs { nonce: 2, dynamic_fee: true, settle_in: 48 * 3_600, p0_bps: 7_000, ..Default::default() });
    for m in [&s, &d] {
        env.advance(60);
        for _ in 0..3 {
            env.buy("alice", m, "above", 25 * USDC, 0).must();
            env.buy("bob", m, "below", 25 * USDC, 0).must();
            env.advance(120);
        }
        let alice = env.addr("alice");
        let sh = env.shares_of(&alice, &m.above) / 4;
        env.sell("alice", m, "above", sh, 0).must();
        let n = env.shares_of(&alice, &m.above).min(env.shares_of(&alice, &m.below));
        env.buy("alice", m, "below", 25 * USDC, 0).must();
        let n2 = env.shares_of(&alice, &m.above).min(env.shares_of(&alice, &m.below)).max(n);
        env.merge("alice", m, n2 / 2).must();
    }
    // Settle one market, void the other.
    env.set_time(s.settle_ts);
    env.settle_with(&s, &PriceUpdate::new(SOL_FEED, 26_000_000_000, -8, s.settle_ts)).must();
    let alice = env.addr("alice");
    let a = env.shares_of(&alice, &s.above);
    env.redeem("alice", &s, "above", a).must();
    env.remove_liquidity("maker", &s, 100 * USDC).must();

    env.set_time(d.settle_ts + 3_600);
    env.void(&d).must();
    let b = env.shares_of(&alice, &d.below);
    env.redeem("alice", &d, "below", b).must();
    env.remove_liquidity("maker", &d, 100 * USDC).must();

    println!("\nCompute units consumed (LiteSVM, SBPF v3 build):\n{}", cu_table(&env.cu));

    let max = |k: &str| *env.cu.get(k).unwrap_or_else(|| panic!("no samples for {k}")).iter().max().unwrap();
    assert!(max("create_market") < CREATE_LIMIT, "create_market {} CU", max("create_market"));
    for k in ["buy", "sell", "merge", "redeem", "remove_liquidity", "settle_close", "void_market", "initialize_config", "allow_feed"] {
        assert!(max(k) < TRADE_LIMIT, "{k} used {} CU", max(k));
    }
}
