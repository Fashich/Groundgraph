//! Config, feed allowlist, admin gating and the pause switch.
use groundgraph_tests::*;
use solana_account::Account;
use solana_address::Address;
use solana_signer::Signer;

fn bad_config_variants(env: &Env) -> Vec<(&'static str, ConfigParams)> {
    let base = || env.default_config();
    vec![
        ("max_fee below 2%", ConfigParams { max_fee_bps: 199, ..base() }),
        ("max_fee above 10%", ConfigParams { max_fee_bps: 1_001, ..base() }),
        ("min_liquidity below 1 USDC", ConfigParams { min_liquidity: USDC - 1, ..base() }),
        ("min_duration below 60s", ConfigParams { min_duration_secs: 59, trading_close_secs: 0, ..base() }),
        ("max_duration below min", ConfigParams { max_duration_secs: 1_799, ..base() }),
        ("max_duration above 400 days", ConfigParams { max_duration_secs: 401 * 86_400, ..base() }),
        ("staleness zero", ConfigParams { max_staleness_secs: 0, ..base() }),
        ("staleness above one hour", ConfigParams { max_staleness_secs: 3_601, ..base() }),
        ("confidence zero", ConfigParams { max_conf_bps: 0, ..base() }),
        ("confidence above 10%", ConfigParams { max_conf_bps: 1_001, ..base() }),
        ("trading close above a day", ConfigParams { trading_close_secs: 86_401, min_duration_secs: 90_000, max_duration_secs: 200_000, ..base() }),
        ("min_duration not above trading close", ConfigParams { trading_close_secs: 1_800, ..base() }),
        ("protocol share above 100%", ConfigParams { protocol_fee_share_bps: 10_001, ..base() }),
    ]
}

#[test]
fn initialize_config_is_gated_on_the_upgrade_authority() {
    let mut env = Env::bare();
    let p = env.default_config();
    // The admin key is not the upgrade authority: rejected.
    let admin = env.clone_kp("admin");
    let ix = env.init_config_ix(&admin.pubkey(), &p);
    env.send(&[ix], &admin, &[]).expect_gg("NotUpgradeAuthority");
    assert!(env.svm.get_account(&config_pda()).is_none());

    // The upgrade authority succeeds and emits ConfigUpdated.
    let r = env.init_config(&p);
    let ev = r.events();
    r.must();
    assert_eq!(ev[0].name, "ConfigUpdated");
    let c = env.config();
    assert_eq!(c.a("admin"), env.admin.pubkey());
    assert_eq!(c.a("usdc_mint"), env.usdc);
    assert_eq!(c.u("max_fee_bps"), 300);
    assert_eq!(c.u("min_liquidity"), 100 * USDC);
    assert_eq!(c.i("min_duration_secs"), 1_800);
    assert_eq!(c.u("trading_close_secs"), 300);
    assert!(!c.b("paused"));

    // A second initialization cannot overwrite it.
    env.init_config(&ConfigParams { max_fee_bps: 500, ..env.default_config() }).expect_fail();
    assert_eq!(env.config().u("max_fee_bps"), 300);
}

#[test]
fn initialize_config_fails_when_the_program_is_not_upgradeable_by_anyone() {
    let mut env = Env::bare();
    // Revoke the upgrade authority (None): nobody can initialize.
    let pd = Address::find_program_address(&[PROGRAM_ID.as_ref()], &LOADER_UPGRADEABLE).0;
    let mut acct: Account = env.svm.get_account(&pd).unwrap();
    acct.data[12] = 0;
    env.svm.set_account(pd, acct).unwrap();
    env.init_config(&env.default_config()).expect_gg("NotUpgradeAuthority");
}

#[test]
fn initialize_config_rejects_out_of_range_parameters() {
    let mut env = Env::bare();
    for (what, p) in bad_config_variants(&env) {
        let r = env.init_config(&p);
        assert_eq!(r.custom_code(), Some(error_code("InvalidConfig")), "{what}");
    }
    assert!(env.svm.get_account(&config_pda()).is_none());
}

#[test]
fn initialize_config_requires_a_six_decimal_mint() {
    let mut env = Env::bare();
    let p = env.default_config();
    let deployer = env.clone_kp("deployer");
    // 9 decimals.
    let m9 = Address::new_unique();
    env.svm.set_account(m9, Account { lamports: 1_461_600, data: mint_account_data(None, 0, 9), owner: TOKEN_PROGRAM, executable: false, rent_epoch: 0 }).unwrap();
    let mut ix = env.init_config_ix(&deployer.pubkey(), &p);
    replace_account(&mut ix, "initialize_config", "usdc_mint", m9);
    env.send(&[ix], &deployer, &[]).expect_gg("InvalidCollateralMint");
    // Not a mint at all.
    let mut ix = env.init_config_ix(&deployer.pubkey(), &p);
    replace_account(&mut ix, "initialize_config", "usdc_mint", env.alice.pubkey());
    env.send(&[ix], &deployer, &[]).expect_gg("InvalidCollateralMint");
}

#[test]
fn update_config_is_admin_only_and_validated() {
    let mut env = Env::new();
    let upd = ConfigUpdate { max_fee_bps: Some(400), ..Default::default() };
    env.update_config("alice", &upd).expect_gg("NotAdmin");
    env.update_config("deployer", &upd).expect_gg("NotAdmin");
    assert_eq!(env.config().u("max_fee_bps"), 300);

    let r = env.update_config("admin", &upd);
    let ev = r.events();
    r.must();
    assert_eq!(ev[0].name, "ConfigUpdated");
    assert_eq!(env.config().u("max_fee_bps"), 400);
    // Untouched fields keep their value.
    assert_eq!(env.config().u("max_conf_bps"), 50);
    assert_eq!(env.config().u("min_liquidity"), 100 * USDC);

    // Each invalid change is rejected and leaves the config as it was.
    for upd in [
        ConfigUpdate { max_fee_bps: Some(100), ..Default::default() },
        ConfigUpdate { max_fee_bps: Some(1_500), ..Default::default() },
        ConfigUpdate { max_staleness_secs: Some(0), ..Default::default() },
        ConfigUpdate { max_conf_bps: Some(5_000), ..Default::default() },
        ConfigUpdate { min_duration_secs: Some(200), ..Default::default() }, // not above trading_close_secs (300)
        ConfigUpdate { trading_close_secs: Some(1_800), ..Default::default() },
        ConfigUpdate { max_duration_secs: Some(10), ..Default::default() },
    ] {
        env.update_config("admin", &upd).expect_gg("InvalidConfig");
    }
    assert_eq!(env.config().u("max_fee_bps"), 400);
}

#[test]
fn admin_can_be_handed_over() {
    let mut env = Env::new();
    let alice = env.alice.pubkey();
    env.update_config("admin", &ConfigUpdate { new_admin: Some(alice), treasury: Some(alice), ..Default::default() }).must();
    assert_eq!(env.config().a("admin"), alice);
    assert_eq!(env.config().a("treasury"), alice);
    env.update_config("admin", &ConfigUpdate { paused: Some(true), ..Default::default() }).expect_gg("NotAdmin");
    env.update_config("alice", &ConfigUpdate { paused: Some(true), ..Default::default() }).must();
    assert!(env.config().b("paused"));
}

#[test]
fn feed_allowlist_is_admin_only_and_validated() {
    let mut env = Env::new();
    // Non-admin cannot add or remove.
    let alice = env.clone_kp("alice");
    let ix = env.allow_feed_ix(&alice.pubkey(), OTHER_FEED, "ETH/USD", -8);
    env.send(&[ix], &alice, &[]).expect_gg("NotAdmin");
    let ix = build_ix("disallow_feed", SOL_FEED.to_vec(), &[("admin", alice.pubkey()), ("config", config_pda()), ("feed", feed_pda(&SOL_FEED))]);
    env.send(&[ix], &alice, &[]).expect_gg("NotAdmin");

    // Symbol and exponent validation.
    env.allow_feed(OTHER_FEED, "", -8).expect_gg("InvalidSymbol");
    env.allow_feed(OTHER_FEED, "ABCDEFGHIJKLMNOPQ", -8).expect_gg("InvalidSymbol");
    env.allow_feed(OTHER_FEED, "ETH/USD", 1).expect_gg("InvalidTarget");
    env.allow_feed(OTHER_FEED, "ETH/USD", -19).expect_gg("InvalidTarget");

    let r = env.allow_feed(OTHER_FEED, "ETH/USD", -8);
    let ev = r.events();
    r.must();
    assert_eq!(ev[0].name, "FeedUpdated");
    assert!(ev[0].data.b("enabled"));
    let f = decode_account("FeedAllowlist", &env.svm.get_account(&feed_pda(&OTHER_FEED)).unwrap().data);
    assert!(f.b("enabled"));
    assert_eq!(f.i("expo"), -8);
    assert_eq!(f.bytes("feed_id"), OTHER_FEED.to_vec());
    assert_eq!(f.get("symbol"), Some(&V::S("ETH/USD".into())));

    // Disable: markets can no longer be created on it; existing markets are unaffected.
    let existing = env.create_market(&MarketArgs { nonce: 5, feed_id: OTHER_FEED, ..Default::default() });
    let r = env.disallow_feed(OTHER_FEED);
    let ev = r.events();
    r.must();
    assert!(!ev[0].data.b("enabled"));
    let (r, _) = env.create_market_result(&MarketArgs { nonce: 6, feed_id: OTHER_FEED, ..Default::default() });
    r.expect_gg("FeedNotAllowed");
    env.buy("alice", &existing, "above", 10 * USDC, 0).must();

    // Re-enable.
    env.allow_feed(OTHER_FEED, "ETH/USD", -8).must();
    env.create_market(&MarketArgs { nonce: 6, feed_id: OTHER_FEED, ..Default::default() });
}

#[test]
fn pause_blocks_creation_and_buys_only() {
    let mut env = Env::new();
    let m = env.create_market(&MarketArgs::default());
    env.buy("alice", &m, "above", 50 * USDC, 0).must();
    env.buy("bob", &m, "below", 50 * USDC, 0).must();

    env.set_paused(true);
    assert!(env.config().b("paused"));
    env.buy("alice", &m, "above", 10 * USDC, 0).expect_gg("Paused");
    let (r, _) = env.create_market_result(&MarketArgs { nonce: 2, ..Default::default() });
    r.expect_gg("Paused");
    // Exits stay open: sell and merge work while paused.
    let alice = env.clone_kp("alice").pubkey();
    let s = env.shares_of(&alice, &m.above) / 2;
    env.sell("alice", &m, "above", s, 0).must();
    let bob = env.clone_kp("bob").pubkey();
    let b = env.shares_of(&bob, &m.below);
    env.buy("bob", &m, "above", 10 * USDC, 0).expect_gg("Paused");
    let _ = b;

    // Settlement and redemption keep working under pause.
    env.set_time(m.settle_ts + 1);
    env.settle_with(&m, &PriceUpdate::new(SOL_FEED, 30_000_000_000, -8, m.settle_ts + 1)).must();
    let a = env.shares_of(&alice, &m.above);
    env.redeem("alice", &m, "above", a).must();

    env.set_paused(false);
    let m2 = env.create_market(&MarketArgs { nonce: 3, ..Default::default() });
    env.buy("alice", &m2, "above", 10 * USDC, 0).must();
}

#[test]
fn merge_works_while_paused() {
    let mut env = Env::new();
    let m = env.create_market(&MarketArgs::default());
    env.buy("alice", &m, "above", 50 * USDC, 0).must();
    env.buy("alice", &m, "below", 50 * USDC, 0).must();
    let alice = env.clone_kp("alice").pubkey();
    let n = env.shares_of(&alice, &m.above).min(env.shares_of(&alice, &m.below));
    env.set_paused(true);
    env.merge("alice", &m, n).must();
}
