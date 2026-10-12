//! LiteSVM harness for the Groundgraph program.
//!
//! Loads `target/deploy/groundgraph.so` and drives it with instructions whose account order and flags come from the
//! committed IDL (`programs/groundgraph/idl/groundgraph.json`). Instruction arguments are hand-encoded (little endian
//! borsh) so the byte layout is verified independently of the IDL. Accounts and events are decoded generically from
//! the IDL type definitions.
//!
//! The pure AMM math is included by path so tests can cross-check what the program did against `math.rs`.
#![allow(clippy::too_many_arguments)]

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::OnceLock;

use litesvm::types::{FailedTransactionMetadata, TransactionMetadata};
use litesvm::LiteSVM;
use sha2::{Digest, Sha256};
use solana_account::Account;
use solana_address::Address;
use solana_clock::Clock;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;
use solana_transaction_error::TransactionError;

pub use solana_address::Address as Addr;
pub use solana_keypair::Keypair as Kp;
pub use solana_signer::Signer as SignerTrait;

#[path = "../../programs/groundgraph/src/math.rs"]
#[allow(dead_code)]
pub mod math;

pub const PROGRAM_ID: Address = Address::from_str_const("5W8BS9j9ZFH7Uscjq2Sh7tU5SVmvf7Ay3fJMDjTnRPCC");
pub const TOKEN_PROGRAM: Address = Address::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const ATA_PROGRAM: Address = Address::from_str_const("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const SYSTEM_PROGRAM: Address = Address::from_str_const("11111111111111111111111111111111");
pub const LOADER_UPGRADEABLE: Address = Address::from_str_const("BPFLoaderUpgradeab1e11111111111111111111111");
pub const COMPUTE_BUDGET_PROGRAM: Address = Address::from_str_const("ComputeBudget111111111111111111111111111111");
pub const PYTH_RECEIVER: Address = Address::from_str_const("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");

pub const USDC: u64 = 1_000_000;
/// Wall clock used by every test (2027-01-15 08:00:00 UTC).
pub const T0: i64 = 1_800_000_000;

/// Anchor framework error codes used by the tests.
pub mod anchor_err {
    pub const CONSTRAINT_SEEDS: u32 = 2006;
    pub const ACCOUNT_DISCRIMINATOR_MISMATCH: u32 = 3002;
    pub const ACCOUNT_OWNED_BY_WRONG_PROGRAM: u32 = 3007;
    pub const ACCOUNT_NOT_INITIALIZED: u32 = 3012;
    pub const INVALID_PROGRAM_ID: u32 = 3008;
    pub const ACCOUNT_NOT_SIGNER: u32 = 3010;
}

/* ------------------------------ IDL access ------------------------------ */

fn idl() -> &'static serde_json::Value {
    static IDL: OnceLock<serde_json::Value> = OnceLock::new();
    IDL.get_or_init(|| {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../programs/groundgraph/idl/groundgraph.json");
        serde_json::from_str(&std::fs::read_to_string(path).expect("IDL file")).expect("IDL json")
    })
}

pub fn disc(kind: &str, name: &str) -> [u8; 8] {
    let h = Sha256::digest(format!("{kind}:{name}").as_bytes());
    h[..8].try_into().unwrap()
}

/// Name of a Groundgraph program error (6000+), if `code` is one.
pub fn error_name(code: u32) -> Option<String> {
    idl()["errors"].as_array()?.iter().find(|e| e["code"].as_u64() == Some(code as u64)).map(|e| e["name"].as_str().unwrap().to_string())
}

pub fn error_code(name: &str) -> u32 {
    idl()["errors"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["name"].as_str() == Some(name))
        .unwrap_or_else(|| panic!("unknown program error {name}"))["code"]
        .as_u64()
        .unwrap() as u32
}

fn idl_ix(name: &str) -> &'static serde_json::Value {
    idl()["instructions"].as_array().unwrap().iter().find(|i| i["name"] == name).unwrap_or_else(|| panic!("no instruction {name} in IDL"))
}

/// Build an instruction: discriminator from the IDL name, accounts ordered and flagged per the IDL.
pub fn build_ix(name: &str, args: Vec<u8>, accounts: &[(&str, Address)]) -> Instruction {
    let def = idl_ix(name);
    let mut data = disc("global", name).to_vec();
    assert_eq!(def["discriminator"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as u8).collect::<Vec<_>>(), data, "IDL discriminator for {name}");
    data.extend(args);
    let metas = def["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| {
            let n = a["name"].as_str().unwrap();
            let key = match a.get("address").and_then(|v| v.as_str()) {
                Some(fixed) => fixed.parse::<Address>().unwrap(),
                None => accounts.iter().find(|(k, _)| *k == n).unwrap_or_else(|| panic!("{name}: missing account {n}")).1,
            };
            let writable = a.get("writable").and_then(|v| v.as_bool()).unwrap_or(false);
            let signer = a.get("signer").and_then(|v| v.as_bool()).unwrap_or(false);
            if writable {
                AccountMeta::new(key, signer)
            } else {
                AccountMeta::new_readonly(key, signer)
            }
        })
        .collect();
    Instruction { program_id: PROGRAM_ID, accounts: metas, data }
}

/// Replace one account of an instruction by IDL account name (for negative tests).
pub fn replace_account(ix: &mut Instruction, ix_name: &str, account: &str, addr: Address) {
    let idx = idl_ix(ix_name)["accounts"].as_array().unwrap().iter().position(|a| a["name"] == account).unwrap_or_else(|| panic!("{ix_name} has no account {account}"));
    ix.accounts[idx].pubkey = addr;
}

/// Drop the signer flag of an account (for "missing signature" tests).
pub fn unsign_account(ix: &mut Instruction, ix_name: &str, account: &str) {
    let idx = idl_ix(ix_name)["accounts"].as_array().unwrap().iter().position(|a| a["name"] == account).unwrap();
    ix.accounts[idx].is_signer = false;
}

/* ------------------------------ decoded values ------------------------------ */

#[derive(Clone, Debug, PartialEq)]
pub enum V {
    U(u128),
    I(i128),
    B(bool),
    S(String),
    A(Address),
    Bytes(Vec<u8>),
    /// Unit enum variant name, lowercase.
    E(String),
    Opt(Option<Box<V>>),
    Struct(Fields),
}

pub type Fields = BTreeMap<String, V>;

pub trait FieldsExt {
    fn u(&self, k: &str) -> u64;
    fn i(&self, k: &str) -> i64;
    fn b(&self, k: &str) -> bool;
    fn a(&self, k: &str) -> Address;
    fn e(&self, k: &str) -> String;
    fn bytes(&self, k: &str) -> Vec<u8>;
}

impl FieldsExt for Fields {
    fn u(&self, k: &str) -> u64 {
        match self.get(k) {
            Some(V::U(v)) => *v as u64,
            other => panic!("field {k}: expected unsigned, got {other:?}"),
        }
    }
    fn i(&self, k: &str) -> i64 {
        match self.get(k) {
            Some(V::I(v)) => *v as i64,
            Some(V::U(v)) => *v as i64,
            other => panic!("field {k}: expected signed, got {other:?}"),
        }
    }
    fn b(&self, k: &str) -> bool {
        match self.get(k) {
            Some(V::B(v)) => *v,
            other => panic!("field {k}: expected bool, got {other:?}"),
        }
    }
    fn a(&self, k: &str) -> Address {
        match self.get(k) {
            Some(V::A(v)) => *v,
            other => panic!("field {k}: expected address, got {other:?}"),
        }
    }
    fn e(&self, k: &str) -> String {
        match self.get(k) {
            Some(V::E(v)) => v.clone(),
            other => panic!("field {k}: expected enum, got {other:?}"),
        }
    }
    fn bytes(&self, k: &str) -> Vec<u8> {
        match self.get(k) {
            Some(V::Bytes(v)) => v.clone(),
            other => panic!("field {k}: expected bytes, got {other:?}"),
        }
    }
}

struct Rd<'a> {
    b: &'a [u8],
    o: usize,
}

impl<'a> Rd<'a> {
    fn take(&mut self, n: usize) -> &'a [u8] {
        let s = &self.b[self.o..self.o + n];
        self.o += n;
        s
    }
}

fn read_type(r: &mut Rd, t: &serde_json::Value) -> V {
    if let Some(s) = t.as_str() {
        return match s {
            "u8" => V::U(r.take(1)[0] as u128),
            "u16" => V::U(u16::from_le_bytes(r.take(2).try_into().unwrap()) as u128),
            "u32" => V::U(u32::from_le_bytes(r.take(4).try_into().unwrap()) as u128),
            "u64" => V::U(u64::from_le_bytes(r.take(8).try_into().unwrap()) as u128),
            "i32" => V::I(i32::from_le_bytes(r.take(4).try_into().unwrap()) as i128),
            "i64" => V::I(i64::from_le_bytes(r.take(8).try_into().unwrap()) as i128),
            "bool" => V::B(r.take(1)[0] != 0),
            "pubkey" => V::A(Address::new_from_array(r.take(32).try_into().unwrap())),
            "string" => {
                let n = u32::from_le_bytes(r.take(4).try_into().unwrap()) as usize;
                V::S(String::from_utf8(r.take(n).to_vec()).unwrap())
            }
            other => panic!("unsupported idl type {other}"),
        };
    }
    if let Some(a) = t.get("array") {
        let n = a[1].as_u64().unwrap() as usize;
        assert_eq!(a[0], "u8", "only byte arrays are supported");
        return V::Bytes(r.take(n).to_vec());
    }
    if let Some(inner) = t.get("option") {
        return if r.take(1)[0] == 0 { V::Opt(None) } else { V::Opt(Some(Box::new(read_type(r, inner)))) };
    }
    let name = t["defined"]["name"].as_str().expect("defined type");
    let def = idl()["types"].as_array().unwrap().iter().find(|d| d["name"] == name).unwrap_or_else(|| panic!("type {name}"));
    match def["type"]["kind"].as_str().unwrap() {
        "struct" => V::Struct(read_fields(r, &def["type"]["fields"])),
        _ => {
            let tag = r.take(1)[0] as usize;
            V::E(def["type"]["variants"][tag]["name"].as_str().unwrap().to_lowercase())
        }
    }
}

fn read_fields(r: &mut Rd, fields: &serde_json::Value) -> Fields {
    let mut out = Fields::new();
    for f in fields.as_array().into_iter().flatten() {
        out.insert(f["name"].as_str().unwrap().to_string(), read_type(r, &f["type"]));
    }
    out
}

/// Decode an Anchor account (8 byte discriminator + borsh body) by its IDL type name.
pub fn decode_account(name: &str, data: &[u8]) -> Fields {
    assert_eq!(&data[..8], &disc("account", name), "discriminator of {name}");
    match read_type(&mut Rd { b: data, o: 8 }, &serde_json::json!({ "defined": { "name": name } })) {
        V::Struct(f) => f,
        _ => unreachable!(),
    }
}

#[derive(Clone, Debug)]
pub struct Event {
    pub name: String,
    pub data: Fields,
}

/// Events logged by the Groundgraph program (not by CPIs) in a transaction's logs.
pub fn parse_events(logs: &[String]) -> Vec<Event> {
    use base64::Engine;
    let names: Vec<String> = idl()["events"].as_array().unwrap().iter().map(|e| e["name"].as_str().unwrap().to_string()).collect();
    let pid = PROGRAM_ID.to_string();
    let mut stack: Vec<String> = vec![];
    let mut out = vec![];
    for line in logs {
        if let Some(rest) = line.strip_prefix("Program ") {
            if let Some((id, tail)) = rest.split_once(' ') {
                if tail.starts_with("invoke [") {
                    stack.push(id.to_string());
                    continue;
                }
                if tail == "success" || tail.starts_with("failed") {
                    stack.pop();
                    continue;
                }
            }
        }
        let Some(b64) = line.strip_prefix("Program data: ") else { continue };
        if stack.last() != Some(&pid) {
            continue;
        }
        let raw = base64::engine::general_purpose::STANDARD.decode(b64.trim()).unwrap();
        if let Some(n) = names.iter().find(|n| disc("event", n) == raw[..8]) {
            let v = read_type(&mut Rd { b: &raw, o: 8 }, &serde_json::json!({ "defined": { "name": n } }));
            if let V::Struct(f) = v {
                out.push(Event { name: n.clone(), data: f });
            }
        }
    }
    out
}

/* ------------------------------ transactions ------------------------------ */

pub type TxResult = Result<TransactionMetadata, FailedTransactionMetadata>;

pub trait TxResultExt {
    /// Unwrap success (not Result::ok, which would drop the error), printing the program logs on failure.
    fn must(self) -> TransactionMetadata;
    /// Custom program error code, if the transaction failed with one.
    fn custom_code(&self) -> Option<u32>;
    /// Assert failure with the named Groundgraph error.
    fn expect_gg(self, name: &str);
    /// Assert failure with a specific numeric custom error (Anchor framework errors).
    fn expect_code(self, code: u32);
    /// Assert any failure.
    fn expect_fail(self);
    fn events(&self) -> Vec<Event>;
}

impl TxResultExt for TxResult {
    fn must(self) -> TransactionMetadata {
        match self {
            Ok(m) => m,
            Err(f) => panic!("transaction failed: {:?}\n{}", f.err, f.meta.logs.join("\n")),
        }
    }
    fn custom_code(&self) -> Option<u32> {
        let Err(f) = self else { return None };
        let TransactionError::InstructionError(_, e) = &f.err else { return None };
        let s = format!("{e:?}");
        s.strip_prefix("Custom(")?.strip_suffix(')')?.parse().ok()
    }
    fn expect_gg(self, name: &str) {
        let want = error_code(name);
        match &self {
            Ok(m) => panic!("expected failure {name}, but the transaction succeeded:\n{}", m.logs.join("\n")),
            Err(f) => {
                let got = self.custom_code();
                assert_eq!(got, Some(want), "expected {name} ({want}), got {:?} ({:?})\n{}", got.and_then(error_name), f.err, f.meta.logs.join("\n"));
            }
        }
    }
    fn expect_code(self, code: u32) {
        match &self {
            Ok(m) => panic!("expected failure {code}, but the transaction succeeded:\n{}", m.logs.join("\n")),
            Err(f) => assert_eq!(self.custom_code(), Some(code), "expected custom error {code}, got {:?}\n{}", f.err, f.meta.logs.join("\n")),
        }
    }
    fn expect_fail(self) {
        assert!(self.is_err(), "expected the transaction to fail");
    }
    fn events(&self) -> Vec<Event> {
        match self {
            Ok(m) => parse_events(&m.logs),
            Err(f) => parse_events(&f.meta.logs),
        }
    }
}

/* ------------------------------ SPL token state ------------------------------ */

pub fn mint_account_data(authority: Option<&Address>, supply: u64, decimals: u8) -> Vec<u8> {
    let mut d = vec![0u8; 82];
    if let Some(a) = authority {
        d[0..4].copy_from_slice(&1u32.to_le_bytes());
        d[4..36].copy_from_slice(a.as_ref());
    }
    d[36..44].copy_from_slice(&supply.to_le_bytes());
    d[44] = decimals;
    d[45] = 1;
    d
}

pub fn token_account_data(mint: &Address, owner: &Address, amount: u64) -> Vec<u8> {
    let mut d = vec![0u8; 165];
    d[0..32].copy_from_slice(mint.as_ref());
    d[32..64].copy_from_slice(owner.as_ref());
    d[64..72].copy_from_slice(&amount.to_le_bytes());
    d[108] = 1; // initialized
    d
}

pub fn ata(owner: &Address, mint: &Address) -> Address {
    Address::find_program_address(&[owner.as_ref(), TOKEN_PROGRAM.as_ref(), mint.as_ref()], &ATA_PROGRAM).0
}

pub fn pda(seeds: &[&[u8]]) -> Address {
    Address::find_program_address(seeds, &PROGRAM_ID).0
}

pub fn config_pda() -> Address {
    pda(&[b"config"])
}
pub fn feed_pda(feed_id: &[u8; 32]) -> Address {
    pda(&[b"feed", feed_id])
}
pub fn market_pda(creator: &Address, nonce: u64) -> Address {
    pda(&[b"market", creator.as_ref(), &nonce.to_le_bytes()])
}

/// Pyth `PriceUpdateV2` account contents.
#[derive(Clone, Debug)]
pub struct PriceUpdate {
    pub feed_id: [u8; 32],
    pub price: i64,
    pub conf: u64,
    pub expo: i32,
    pub publish_time: i64,
    pub full: bool,
    pub owner: Address,
}

impl PriceUpdate {
    pub fn new(feed_id: [u8; 32], price: i64, expo: i32, publish_time: i64) -> Self {
        PriceUpdate { feed_id, price, conf: 1, expo, publish_time, full: true, owner: PYTH_RECEIVER }
    }
    pub fn encode(&self) -> Vec<u8> {
        let mut d = vec![34, 241, 35, 99, 157, 126, 244, 205];
        d.extend_from_slice(&[7u8; 32]); // write authority
        if self.full {
            d.push(1);
        } else {
            d.extend_from_slice(&[0, 5]);
        }
        d.extend_from_slice(&self.feed_id);
        d.extend_from_slice(&self.price.to_le_bytes());
        d.extend_from_slice(&self.conf.to_le_bytes());
        d.extend_from_slice(&self.expo.to_le_bytes());
        d.extend_from_slice(&self.publish_time.to_le_bytes());
        d.extend_from_slice(&(self.publish_time - 1).to_le_bytes());
        d.extend_from_slice(&self.price.to_le_bytes()); // ema price
        d.extend_from_slice(&self.conf.to_le_bytes()); // ema conf
        d.extend_from_slice(&1u64.to_le_bytes()); // posted slot
        d.resize(134, 0);
        d
    }
}

/* ------------------------------ environment ------------------------------ */

pub fn sbf_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../target/deploy/groundgraph.so")
}

pub struct ConfigParams {
    pub admin: Address,
    pub treasury: Address,
    pub protocol_fee_share_bps: u16,
    pub max_fee_bps: u16,
    pub min_liquidity: u64,
    pub min_duration_secs: i64,
    pub max_duration_secs: i64,
    pub max_staleness_secs: u32,
    pub max_conf_bps: u16,
    pub trading_close_secs: u32,
}

#[derive(Clone, Debug)]
pub struct MarketArgs {
    pub nonce: u64,
    pub feed_id: [u8; 32],
    pub kind: u8,
    pub direction: u8,
    pub target_price: i64,
    pub target_expo: i32,
    /// Seconds from the current clock until settlement.
    pub settle_in: i64,
    pub base_fee_bps: u16,
    pub dynamic_fee: bool,
    pub liquidity: u64,
    pub p0_bps: u16,
}

pub const SOL_FEED: [u8; 32] = [0xa1; 32];
pub const OTHER_FEED: [u8; 32] = [0xb2; 32];

impl Default for MarketArgs {
    fn default() -> Self {
        MarketArgs {
            nonce: 1,
            feed_id: SOL_FEED,
            kind: 0,
            direction: 0,
            target_price: 25_000_000_000, // $250.00 with expo -8
            target_expo: -8,
            settle_in: 86_400,
            base_fee_bps: 100,
            dynamic_fee: false,
            liquidity: 500 * USDC,
            p0_bps: 4_000,
        }
    }
}

#[derive(Clone, Debug)]
pub struct MarketRef {
    pub creator: Address,
    pub nonce: u64,
    pub market: Address,
    pub vault: Address,
    pub above: Address,
    pub below: Address,
    pub lp: Address,
    pub settle_ts: i64,
    pub trading_end_ts: i64,
    pub args: MarketArgs,
}

impl MarketRef {
    pub fn outcome_mint(&self, side: u8) -> Address {
        if side == 0 {
            self.above
        } else {
            self.below
        }
    }
}

pub struct Env {
    pub svm: LiteSVM,
    pub usdc: Address,
    pub deployer: Keypair,
    pub admin: Keypair,
    pub maker: Keypair,
    pub alice: Keypair,
    pub bob: Keypair,
    pub keeper: Keypair,
    pub mint_authority: Keypair,
    pub cu: BTreeMap<String, Vec<u64>>,
}

pub fn side_byte(side: &str) -> u8 {
    match side {
        "above" => 0,
        "below" => 1,
        _ => panic!("side"),
    }
}

impl Env {
    /// Fresh LiteSVM with the program loaded, the clock at `T0`, funded actors and an initialized 6-decimal USDC mint.
    /// The deployer is made the program's upgrade authority. Config is NOT initialized.
    pub fn bare() -> Env {
        let mut svm = LiteSVM::new();
        let so = std::fs::read(sbf_path()).expect("build the program first: cargo build-sbf --manifest-path programs/groundgraph/Cargo.toml");
        svm.add_program(PROGRAM_ID, &so).expect("load program");
        let deployer = Keypair::new();
        let admin = Keypair::new();
        let maker = Keypair::new();
        let alice = Keypair::new();
        let bob = Keypair::new();
        let keeper = Keypair::new();
        let mint_authority = Keypair::new();
        for k in [&deployer, &admin, &maker, &alice, &bob, &keeper] {
            svm.airdrop(&k.pubkey(), 100_000_000_000).expect("airdrop");
        }
        // Make the deployer the upgrade authority: ProgramData = tag(4) | slot(8) | Some(1) | authority(32) | ELF.
        let pd = Address::find_program_address(&[PROGRAM_ID.as_ref()], &LOADER_UPGRADEABLE).0;
        let mut acct = svm.get_account(&pd).expect("programdata account");
        acct.data[0..4].copy_from_slice(&3u32.to_le_bytes());
        acct.data[12] = 1;
        acct.data[13..45].copy_from_slice(deployer.pubkey().as_ref());
        svm.set_account(pd, acct).unwrap();

        let usdc = Address::new_unique();
        let rent = svm.minimum_balance_for_rent_exemption(82);
        svm.set_account(usdc, Account { lamports: rent, data: mint_account_data(Some(&mint_authority.pubkey()), 0, 6), owner: TOKEN_PROGRAM, executable: false, rent_epoch: 0 }).unwrap();

        let mut env = Env { svm, usdc, deployer, admin, maker, alice, bob, keeper, mint_authority, cu: BTreeMap::new() };
        env.set_time(T0);
        env
    }

    /// `bare()` plus an initialized config (test parameters), an allowlisted SOL feed, and USDC for the actors.
    pub fn new() -> Env {
        let mut env = Env::bare();
        env.init_config(&env.default_config()).must();
        env.allow_feed(SOL_FEED, "SOL/USD", -8).must();
        let (maker, alice, bob) = (env.maker.pubkey(), env.alice.pubkey(), env.bob.pubkey());
        env.fund_usdc(&maker, 100_000 * USDC);
        env.fund_usdc(&alice, 10_000 * USDC);
        env.fund_usdc(&bob, 10_000 * USDC);
        env
    }

    pub fn default_config(&self) -> ConfigParams {
        ConfigParams {
            admin: self.admin.pubkey(),
            treasury: self.admin.pubkey(),
            protocol_fee_share_bps: 0,
            max_fee_bps: 300,
            min_liquidity: 100 * USDC,
            min_duration_secs: 1_800,
            max_duration_secs: 180 * 86_400,
            max_staleness_secs: 60,
            max_conf_bps: 50,
            trading_close_secs: 300,
        }
    }

    /* ----- clock ----- */

    pub fn now(&self) -> i64 {
        self.svm.get_sysvar::<Clock>().unix_timestamp
    }

    pub fn set_time(&mut self, ts: i64) {
        let mut c = self.svm.get_sysvar::<Clock>();
        c.unix_timestamp = ts;
        c.slot = c.slot.max(1) + 1;
        self.svm.set_sysvar(&c);
    }

    pub fn advance(&mut self, secs: i64) {
        let now = self.now();
        self.set_time(now + secs);
    }

    /* ----- sending ----- */

    pub fn send(&mut self, ixs: &[Instruction], payer: &Keypair, extra: &[&Keypair]) -> TxResult {
        self.svm.expire_blockhash();
        let mut signers: Vec<&Keypair> = vec![payer];
        signers.extend_from_slice(extra);
        let msg = Message::new_with_blockhash(ixs, Some(&payer.pubkey()), &self.svm.latest_blockhash());
        let tx = Transaction::new(&signers, msg, self.svm.latest_blockhash());
        self.svm.send_transaction(tx)
    }

    /// Send and remember the consumed compute units under `tag`.
    pub fn send_tagged(&mut self, tag: &str, ixs: &[Instruction], payer: &Keypair, extra: &[&Keypair]) -> TxResult {
        let r = self.send(ixs, payer, extra);
        if let Ok(m) = &r {
            self.cu.entry(tag.to_string()).or_default().push(m.compute_units_consumed);
        }
        r
    }

    fn kp(&self, which: &str) -> &Keypair {
        match which {
            "deployer" => &self.deployer,
            "admin" => &self.admin,
            "maker" => &self.maker,
            "alice" => &self.alice,
            "bob" => &self.bob,
            "keeper" => &self.keeper,
            other => panic!("unknown actor {other}"),
        }
    }

    pub fn addr(&self, who: &str) -> Address {
        self.kp(who).pubkey()
    }

    pub fn clone_kp(&self, which: &str) -> Keypair {
        Keypair::try_from(self.kp(which).to_bytes().as_slice()).unwrap()
    }

    /* ----- tokens ----- */

    pub fn put_token_account(&mut self, addr: Address, mint: &Address, owner: &Address, amount: u64) {
        let rent = self.svm.minimum_balance_for_rent_exemption(165);
        self.svm.set_account(addr, Account { lamports: rent, data: token_account_data(mint, owner, amount), owner: TOKEN_PROGRAM, executable: false, rent_epoch: 0 }).unwrap();
    }

    /// Give `owner` an associated USDC account holding `amount`.
    pub fn fund_usdc(&mut self, owner: &Address, amount: u64) -> Address {
        let a = ata(owner, &self.usdc);
        let existing = self.token_amount_opt(&a).unwrap_or(0);
        let usdc = self.usdc;
        self.put_token_account(a, &usdc, owner, existing + amount);
        a
    }

    pub fn token_amount_opt(&self, addr: &Address) -> Option<u64> {
        let a = self.svm.get_account(addr)?;
        if a.owner != TOKEN_PROGRAM || a.data.len() < 72 {
            return None;
        }
        Some(u64::from_le_bytes(a.data[64..72].try_into().unwrap()))
    }

    pub fn token_amount(&self, addr: &Address) -> u64 {
        self.token_amount_opt(addr).unwrap_or(0)
    }

    pub fn usdc_of(&self, owner: &Address) -> u64 {
        self.token_amount(&ata(owner, &self.usdc))
    }

    pub fn shares_of(&self, owner: &Address, mint: &Address) -> u64 {
        self.token_amount(&ata(owner, mint))
    }

    pub fn mint_supply(&self, mint: &Address) -> u64 {
        u64::from_le_bytes(self.svm.get_account(mint).expect("mint").data[36..44].try_into().unwrap())
    }

    /* ----- price accounts ----- */

    pub fn put_price(&mut self, addr: Address, p: &PriceUpdate) {
        let data = p.encode();
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        self.svm.set_account(addr, Account { lamports, data, owner: p.owner, executable: false, rent_epoch: 0 }).unwrap();
    }

    /* ----- admin instructions ----- */

    pub fn init_config_ix(&self, authority: &Address, p: &ConfigParams) -> Instruction {
        let mut a = vec![];
        a.extend_from_slice(p.admin.as_ref());
        a.extend_from_slice(p.treasury.as_ref());
        a.extend_from_slice(&p.protocol_fee_share_bps.to_le_bytes());
        a.extend_from_slice(&p.max_fee_bps.to_le_bytes());
        a.extend_from_slice(&p.min_liquidity.to_le_bytes());
        a.extend_from_slice(&p.min_duration_secs.to_le_bytes());
        a.extend_from_slice(&p.max_duration_secs.to_le_bytes());
        a.extend_from_slice(&p.max_staleness_secs.to_le_bytes());
        a.extend_from_slice(&p.max_conf_bps.to_le_bytes());
        a.extend_from_slice(&p.trading_close_secs.to_le_bytes());
        let pd = Address::find_program_address(&[PROGRAM_ID.as_ref()], &LOADER_UPGRADEABLE).0;
        build_ix("initialize_config", a, &[("authority", *authority), ("config", config_pda()), ("usdc_mint", self.usdc), ("program_data", pd)])
    }

    pub fn init_config(&mut self, p: &ConfigParams) -> TxResult {
        let d = self.clone_kp("deployer");
        let ix = self.init_config_ix(&d.pubkey(), p);
        self.send_tagged("initialize_config", &[ix], &d, &[])
    }

    pub fn allow_feed_ix(&self, admin: &Address, feed_id: [u8; 32], symbol: &str, expo: i32) -> Instruction {
        let mut a = feed_id.to_vec();
        a.extend_from_slice(&(symbol.len() as u32).to_le_bytes());
        a.extend_from_slice(symbol.as_bytes());
        a.extend_from_slice(&expo.to_le_bytes());
        build_ix("allow_feed", a, &[("admin", *admin), ("config", config_pda()), ("feed", feed_pda(&feed_id))])
    }

    pub fn allow_feed(&mut self, feed_id: [u8; 32], symbol: &str, expo: i32) -> TxResult {
        let admin = self.clone_kp("admin");
        let ix = self.allow_feed_ix(&admin.pubkey(), feed_id, symbol, expo);
        self.send_tagged("allow_feed", &[ix], &admin, &[])
    }

    pub fn disallow_feed(&mut self, feed_id: [u8; 32]) -> TxResult {
        let admin = self.clone_kp("admin");
        let ix = build_ix("disallow_feed", feed_id.to_vec(), &[("admin", admin.pubkey()), ("config", config_pda()), ("feed", feed_pda(&feed_id))]);
        self.send(&[ix], &admin, &[])
    }

    /// `update_config` with only the listed options set. Each option is encoded as borsh `Option<T>`.
    pub fn update_config_ix(&self, signer: &Address, upd: &ConfigUpdate) -> Instruction {
        let mut a = vec![];
        let opt_pk = |a: &mut Vec<u8>, v: &Option<Address>| match v {
            Some(p) => {
                a.push(1);
                a.extend_from_slice(p.as_ref());
            }
            None => a.push(0),
        };
        opt_pk(&mut a, &upd.new_admin);
        opt_pk(&mut a, &upd.treasury);
        let opt = |a: &mut Vec<u8>, bytes: Option<Vec<u8>>| match bytes {
            Some(b) => {
                a.push(1);
                a.extend(b);
            }
            None => a.push(0),
        };
        opt(&mut a, upd.protocol_fee_share_bps.map(|v| v.to_le_bytes().to_vec()));
        opt(&mut a, upd.max_fee_bps.map(|v| v.to_le_bytes().to_vec()));
        opt(&mut a, upd.min_liquidity.map(|v| v.to_le_bytes().to_vec()));
        opt(&mut a, upd.min_duration_secs.map(|v| v.to_le_bytes().to_vec()));
        opt(&mut a, upd.max_duration_secs.map(|v| v.to_le_bytes().to_vec()));
        opt(&mut a, upd.max_staleness_secs.map(|v| v.to_le_bytes().to_vec()));
        opt(&mut a, upd.max_conf_bps.map(|v| v.to_le_bytes().to_vec()));
        opt(&mut a, upd.trading_close_secs.map(|v| v.to_le_bytes().to_vec()));
        opt(&mut a, upd.paused.map(|v| vec![v as u8]));
        build_ix("update_config", a, &[("admin", *signer), ("config", config_pda())])
    }

    pub fn update_config(&mut self, who: &str, upd: &ConfigUpdate) -> TxResult {
        let kp = self.clone_kp(who);
        let ix = self.update_config_ix(&kp.pubkey(), upd);
        self.send_tagged("update_config", &[ix], &kp, &[])
    }

    pub fn set_paused(&mut self, paused: bool) {
        self.update_config("admin", &ConfigUpdate { paused: Some(paused), ..Default::default() }).must();
    }

    /* ----- market creation ----- */

    pub fn market_ref(&self, creator: &Address, a: &MarketArgs) -> MarketRef {
        let market = market_pda(creator, a.nonce);
        let settle_ts = self.now() + a.settle_in;
        MarketRef {
            creator: *creator,
            nonce: a.nonce,
            market,
            vault: pda(&[b"vault", market.as_ref()]),
            above: pda(&[b"above", market.as_ref()]),
            below: pda(&[b"below", market.as_ref()]),
            lp: pda(&[b"lp", market.as_ref()]),
            settle_ts,
            trading_end_ts: settle_ts - 300,
            args: a.clone(),
        }
    }

    pub fn create_market_ix(&self, creator: &Address, a: &MarketArgs) -> (Instruction, MarketRef) {
        let m = self.market_ref(creator, a);
        let mut d = vec![];
        d.extend_from_slice(&a.nonce.to_le_bytes());
        d.extend_from_slice(&a.feed_id);
        d.push(a.kind);
        d.push(a.direction);
        d.extend_from_slice(&a.target_price.to_le_bytes());
        d.extend_from_slice(&a.target_expo.to_le_bytes());
        d.extend_from_slice(&m.settle_ts.to_le_bytes());
        d.extend_from_slice(&a.base_fee_bps.to_le_bytes());
        d.push(a.dynamic_fee as u8);
        d.extend_from_slice(&a.liquidity.to_le_bytes());
        d.extend_from_slice(&a.p0_bps.to_le_bytes());
        let ix = build_ix(
            "create_market",
            d,
            &[
                ("creator", *creator),
                ("config", config_pda()),
                ("feed", feed_pda(&a.feed_id)),
                ("collateral_mint", self.usdc),
                ("market", m.market),
                ("vault", m.vault),
                ("above_mint", m.above),
                ("below_mint", m.below),
                ("lp_mint", m.lp),
                ("creator_usdc", ata(creator, &self.usdc)),
                ("creator_above", ata(creator, &m.above)),
                ("creator_below", ata(creator, &m.below)),
                ("creator_lp", ata(creator, &m.lp)),
            ],
        );
        (ix, m)
    }

    /// Create a market as `maker` with a larger compute limit (create_market is the heaviest instruction).
    pub fn create_market_result(&mut self, a: &MarketArgs) -> (TxResult, MarketRef) {
        let maker = self.clone_kp("maker");
        let (ix, m) = self.create_market_ix(&maker.pubkey(), a);
        let r = self.send_tagged("create_market", &[compute_limit_ix(400_000), ix], &maker, &[]);
        (r, m)
    }

    pub fn create_market(&mut self, a: &MarketArgs) -> MarketRef {
        let (r, m) = self.create_market_result(a);
        r.must();
        m
    }

    /* ----- trading ----- */

    /// Instruction builder that does not borrow the environment (handy inside closures).
    pub fn ixb(&self) -> Ixb {
        Ixb { usdc: self.usdc }
    }

    pub fn buy_ix(&self, user: &Address, m: &MarketRef, side: u8, usdc_in: u64, min_out: u64) -> Instruction {
        self.ixb().buy_ix(user, m, side, usdc_in, min_out)
    }

    pub fn sell_ix(&self, user: &Address, m: &MarketRef, side: u8, shares_in: u64, min_out: u64) -> Instruction {
        self.ixb().sell_ix(user, m, side, shares_in, min_out)
    }

    pub fn merge_ix(&self, user: &Address, m: &MarketRef, amount: u64) -> Instruction {
        self.ixb().merge_ix(user, m, amount)
    }

    pub fn redeem_ix(&self, user: &Address, m: &MarketRef, side: u8, amount: u64) -> Instruction {
        self.ixb().redeem_ix(user, m, side, amount)
    }

    pub fn remove_liquidity_ix(&self, user: &Address, m: &MarketRef, lp_amount: u64) -> Instruction {
        self.ixb().remove_liquidity_ix(user, m, lp_amount)
    }



    /// Create the user's outcome token account (the SDK does this with an idempotent ATA instruction).
    pub fn ensure_ata(&mut self, owner: &Address, mint: &Address) {
        let a = ata(owner, mint);
        if self.svm.get_account(&a).is_none() {
            self.put_token_account(a, mint, owner, 0);
        }
    }

    pub fn buy(&mut self, who: &str, m: &MarketRef, side: &str, usdc_in: u64, min_out: u64) -> TxResult {
        let kp = self.clone_kp(who);
        let s = side_byte(side);
        self.ensure_ata(&kp.pubkey(), &m.outcome_mint(s));
        let ix = self.buy_ix(&kp.pubkey(), m, s, usdc_in, min_out);
        self.send_tagged("buy", &[ix], &kp, &[])
    }


    pub fn sell(&mut self, who: &str, m: &MarketRef, side: &str, shares_in: u64, min_out: u64) -> TxResult {
        let kp = self.clone_kp(who);
        let ix = self.sell_ix(&kp.pubkey(), m, side_byte(side), shares_in, min_out);
        self.send_tagged("sell", &[ix], &kp, &[])
    }


    pub fn merge(&mut self, who: &str, m: &MarketRef, amount: u64) -> TxResult {
        let kp = self.clone_kp(who);
        let ix = self.merge_ix(&kp.pubkey(), m, amount);
        self.send_tagged("merge", &[ix], &kp, &[])
    }


    pub fn redeem(&mut self, who: &str, m: &MarketRef, side: &str, amount: u64) -> TxResult {
        let kp = self.clone_kp(who);
        let ix = self.redeem_ix(&kp.pubkey(), m, side_byte(side), amount);
        self.send_tagged("redeem", &[ix], &kp, &[])
    }


    pub fn remove_liquidity(&mut self, who: &str, m: &MarketRef, lp_amount: u64) -> TxResult {
        let kp = self.clone_kp(who);
        let ix = self.remove_liquidity_ix(&kp.pubkey(), m, lp_amount);
        self.send_tagged("remove_liquidity", &[ix], &kp, &[])
    }

    pub fn settle_ix(&self, payer: &Address, m: &MarketRef, price_update: &Address) -> Instruction {
        build_ix("settle_close", vec![], &[("payer", *payer), ("config", config_pda()), ("market", m.market), ("lp_mint", m.lp), ("price_update", *price_update)])
    }

    /// Put a price update account at a fresh address and settle with it.
    pub fn settle_with(&mut self, m: &MarketRef, p: &PriceUpdate) -> TxResult {
        let addr = Address::new_unique();
        self.put_price(addr, p);
        let keeper = self.clone_kp("keeper");
        let ix = self.settle_ix(&keeper.pubkey(), m, &addr);
        self.send_tagged("settle_close", &[ix], &keeper, &[])
    }

    pub fn void_ix(&self, caller: &Address, m: &MarketRef) -> Instruction {
        build_ix("void_market", vec![], &[("caller", *caller), ("market", m.market), ("lp_mint", m.lp)])
    }

    pub fn void(&mut self, m: &MarketRef) -> TxResult {
        let keeper = self.clone_kp("keeper");
        let ix = self.void_ix(&keeper.pubkey(), m);
        self.send_tagged("void_market", &[ix], &keeper, &[])
    }

    /* ----- reading state ----- */

    pub fn market(&self, m: &MarketRef) -> Fields {
        decode_account("Market", &self.svm.get_account(&m.market).expect("market account").data)
    }

    pub fn config(&self) -> Fields {
        decode_account("Config", &self.svm.get_account(&config_pda()).expect("config account").data)
    }

    pub fn vault_balance(&self, m: &MarketRef) -> u64 {
        self.token_amount(&m.vault)
    }

    /// The vault covers every liability: `vault >= complete_sets + fee_pool` (equal unless USDC was donated).
    pub fn assert_solvent(&self, m: &MarketRef) {
        let f = self.market(m);
        let status = f.e("status");
        let owed = if status == "open" { f.u("complete_sets") + f.u("fee_pool") } else { f.u("complete_sets") + f.u("lp_claim_remaining") };
        let vault = self.vault_balance(m);
        if status == "open" {
            assert!(vault >= owed, "vault {vault} < complete_sets + fee_pool {owed}");
        } else {
            assert!(vault >= f.u("complete_sets").min(vault), "vault underfunded");
        }
    }

    /// Last Trade event of a transaction.
    pub fn trade_event(r: &TxResult) -> Fields {
        r.events().into_iter().rev().find(|e| e.name == "Trade").expect("Trade event").data
    }
}

/// Builds trading instructions for a given collateral mint.
#[derive(Clone, Copy)]
pub struct Ixb {
    pub usdc: Address,
}

impl Ixb {
    pub fn buy_ix(&self, user: &Address, m: &MarketRef, side: u8, usdc_in: u64, min_out: u64) -> Instruction {
        let mut d = vec![side];
        d.extend_from_slice(&usdc_in.to_le_bytes());
        d.extend_from_slice(&min_out.to_le_bytes());
        let mint = m.outcome_mint(side);
        build_ix(
            "buy",
            d,
            &[
                ("user", *user),
                ("config", config_pda()),
                ("market", m.market),
                ("vault", m.vault),
                ("outcome_mint", mint),
                ("user_usdc", ata(user, &self.usdc)),
                ("user_outcome", ata(user, &mint)),
            ],
        )
    }

    pub fn sell_ix(&self, user: &Address, m: &MarketRef, side: u8, shares_in: u64, min_out: u64) -> Instruction {
        let mut d = vec![side];
        d.extend_from_slice(&shares_in.to_le_bytes());
        d.extend_from_slice(&min_out.to_le_bytes());
        let mint = m.outcome_mint(side);
        build_ix(
            "sell",
            d,
            &[
                ("user", *user),
                ("config", config_pda()),
                ("market", m.market),
                ("vault", m.vault),
                ("outcome_mint", mint),
                ("user_outcome", ata(user, &mint)),
                ("user_usdc", ata(user, &self.usdc)),
            ],
        )
    }

    pub fn merge_ix(&self, user: &Address, m: &MarketRef, amount: u64) -> Instruction {
        build_ix(
            "merge",
            amount.to_le_bytes().to_vec(),
            &[
                ("user", *user),
                ("market", m.market),
                ("vault", m.vault),
                ("above_mint", m.above),
                ("below_mint", m.below),
                ("user_above", ata(user, &m.above)),
                ("user_below", ata(user, &m.below)),
                ("user_usdc", ata(user, &self.usdc)),
            ],
        )
    }

    pub fn redeem_ix(&self, user: &Address, m: &MarketRef, side: u8, amount: u64) -> Instruction {
        let mut d = vec![side];
        d.extend_from_slice(&amount.to_le_bytes());
        let mint = m.outcome_mint(side);
        build_ix(
            "redeem",
            d,
            &[("user", *user), ("market", m.market), ("vault", m.vault), ("outcome_mint", mint), ("user_outcome", ata(user, &mint)), ("user_usdc", ata(user, &self.usdc))],
        )
    }

    pub fn remove_liquidity_ix(&self, user: &Address, m: &MarketRef, lp_amount: u64) -> Instruction {
        build_ix(
            "remove_liquidity",
            lp_amount.to_le_bytes().to_vec(),
            &[("user", *user), ("market", m.market), ("vault", m.vault), ("lp_mint", m.lp), ("user_lp", ata(user, &m.lp)), ("user_usdc", ata(user, &self.usdc))],
        )
    }
}

#[derive(Default, Clone)]
pub struct ConfigUpdate {
    pub new_admin: Option<Address>,
    pub treasury: Option<Address>,
    pub protocol_fee_share_bps: Option<u16>,
    pub max_fee_bps: Option<u16>,
    pub min_liquidity: Option<u64>,
    pub min_duration_secs: Option<i64>,
    pub max_duration_secs: Option<i64>,
    pub max_staleness_secs: Option<u32>,
    pub max_conf_bps: Option<u16>,
    pub trading_close_secs: Option<u32>,
    pub paused: Option<bool>,
}

/// `ComputeBudgetInstruction::SetComputeUnitLimit`.
pub fn compute_limit_ix(units: u32) -> Instruction {
    let mut data = vec![2u8];
    data.extend_from_slice(&units.to_le_bytes());
    Instruction { program_id: COMPUTE_BUDGET_PROGRAM, accounts: vec![], data }
}

/// Print a table of observed compute units per instruction tag.
pub fn cu_table(cu: &BTreeMap<String, Vec<u64>>) -> String {
    let mut s = String::from("instruction            calls     min     max\n");
    for (k, v) in cu {
        s.push_str(&format!("{:<22} {:>5} {:>7} {:>7}\n", k, v.len(), v.iter().min().unwrap(), v.iter().max().unwrap()));
    }
    s
}
