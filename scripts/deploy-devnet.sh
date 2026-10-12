#!/usr/bin/env bash
# Deploy (or upgrade) the Groundgraph program to devnet and record the result in
# programs/groundgraph/deployments/devnet.json.
#
#   scripts/deploy-devnet.sh [--check]
#
# Keys (git-ignored, never printed): .keys/program.json (program address), .keys/deployer.json (payer + upgrade authority).
# Environment:
#   RPC_URL        cluster endpoint (default https://api.devnet.solana.com)
#   MAX_LEN        reserved ProgramData size in bytes (default 280000; the CLI default of 2x the binary costs about 2.7 SOL).
#                  The program can later be upgraded to any binary up to MAX_LEN bytes; a bigger one needs `solana program extend`.
#   SKIP_BUILD=1   do not (re)build target/deploy/groundgraph.so
#   DEPLOY_RECORD  where to write the result (default programs/groundgraph/deployments/devnet.json); local rehearsals
#                  must point this elsewhere so the real record is not overwritten
#   KEYS_DIR       override the key directory
#
# Exit codes: 0 deployed (or --check passed), 1 error, 2 deployer balance too low (the exact SOL needed is printed).
set -euo pipefail
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

RPC_URL="${RPC_URL:-https://api.devnet.solana.com}"
MAX_LEN="${MAX_LEN:-280000}"
KEYS_DIR="${KEYS_DIR:-$ROOT/.keys}"
SO="$ROOT/target/deploy/groundgraph.so"
RECORD="${DEPLOY_RECORD:-$ROOT/programs/groundgraph/deployments/devnet.json}"
BUFFER_KEY="$KEYS_DIR/deploy-buffer.json"
CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

for f in program deployer; do
  [ -f "$KEYS_DIR/$f.json" ] || { echo "missing key file $KEYS_DIR/$f.json" >&2; exit 1; }
done
PROGRAM_ID="$(solana-keygen pubkey "$KEYS_DIR/program.json")"
DEPLOYER="$(solana-keygen pubkey "$KEYS_DIR/deployer.json")"

# ---- build ----
newest_src="$(find programs/groundgraph/src programs/groundgraph/Cargo.toml Cargo.toml -type f -newer "$SO" 2>/dev/null | head -1 || true)"
if [ "${SKIP_BUILD:-0}" != "1" ] && { [ ! -f "$SO" ] || [ -n "$newest_src" ]; }; then
  echo "[deploy] building program (cargo build-sbf)"
  CARGO_BUILD_JOBS=2 cargo build-sbf --manifest-path programs/groundgraph/Cargo.toml --sbf-out-dir target/deploy >/dev/null
fi
[ -f "$SO" ] || { echo "missing $SO (run cargo build-sbf)" >&2; exit 1; }
# build-sbf drops a fresh random keypair next to the binary; it is not the program key and must not be used.
rm -f "$ROOT/target/deploy/groundgraph-keypair.json"
SIZE="$(stat -c %s "$SO")"
SHA="$(sha256sum "$SO" | awk '{print $1}')"
[ "$SIZE" -le "$MAX_LEN" ] || { echo "binary is $SIZE bytes, larger than MAX_LEN=$MAX_LEN" >&2; exit 1; }

# ---- is it already there? ----
EXISTS=0
if solana program show "$PROGRAM_ID" --url "$RPC_URL" --keypair "$KEYS_DIR/deployer.json" >/dev/null 2>&1; then EXISTS=1; fi

# ---- balance check ----
BAL_LAMPORTS="$(solana balance "$DEPLOYER" --url "$RPC_URL" --lamports 2>/dev/null | awk '{print $1}')"
BAL_LAMPORTS="${BAL_LAMPORTS:-0}"
rent() { solana rent "$1" --url "$RPC_URL" --lamports | awk '/Rent-exempt minimum/ {print $3}'; }
FEES=20000000   # 0.02 SOL for ~300 write transactions plus margin
if [ "$EXISTS" = "1" ]; then
  NEED=$(( FEES + 10000000 ))
  MODE=upgrade
else
  # ProgramData = 45 + MAX_LEN bytes, program account = 36 bytes. The buffer (37 + len) is rent-exempt first and its
  # lamports move into ProgramData at the end, so the peak equals the final cost to within a few thousand lamports.
  NEED=$(( $(rent $((45 + MAX_LEN))) + $(rent 36) + FEES ))
  MODE=deploy
fi
# A buffer left by an earlier interrupted run already holds its rent; only the remainder has to come from the balance.
if [ "$MODE" = "deploy" ] && [ -f "$BUFFER_KEY" ]; then
  BUF_PK="$(solana-keygen pubkey "$BUFFER_KEY")"
  BUF_LAM="$(solana balance "$BUF_PK" --url "$RPC_URL" --lamports 2>/dev/null | awk '{print $1}')"
  BUF_LAM="${BUF_LAM:-0}"
  if [ "$BUF_LAM" -gt 0 ] 2>/dev/null; then
    if [ "$NEED" -gt "$BUF_LAM" ]; then NEED=$(( NEED - BUF_LAM + FEES )); else NEED=$FEES; fi
    echo "[deploy] resuming with an existing buffer holding $BUF_LAM lamports"
  fi
fi
fmt() { awk -v l="$1" 'BEGIN{printf "%.4f", l/1e9}'; }
echo "[deploy] mode=$MODE program=$PROGRAM_ID size=${SIZE}B max_len=${MAX_LEN}B"
echo "[deploy] deployer=$DEPLOYER balance=$(fmt "$BAL_LAMPORTS") SOL, needs about $(fmt "$NEED") SOL"
if [ "$BAL_LAMPORTS" -lt "$NEED" ]; then
  SHORT=$(( NEED - BAL_LAMPORTS ))
  cat <<EOF
[deploy] BLOCKED: the deployer is short by $(fmt "$SHORT") SOL.
  Fund $DEPLOYER on devnet (https://faucet.solana.com, network: devnet).
  Deploy alone needs about $(fmt "$NEED") SOL (rent for ${MAX_LEN} bytes of ProgramData at the current devnet rate);
  the bootstrap script then moves roughly 0.55 SOL to the admin, maker, keeper and faucet keys, so the deployer
  should hold about 2.1 SOL in total (2.5 SOL leaves a margin). Then re-run scripts/deploy-devnet.sh.
EOF
  exit 2
fi
[ "$CHECK_ONLY" = "1" ] && { echo "[deploy] check passed"; exit 0; }

# ---- deploy (resumable: the buffer keypair is kept in .keys until the deploy succeeds) ----
[ -f "$BUFFER_KEY" ] || solana-keygen new --no-bip39-passphrase --silent --outfile "$BUFFER_KEY" >/dev/null
OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT
set +e
solana program deploy "$SO" \
  --url "$RPC_URL" \
  --keypair "$KEYS_DIR/deployer.json" \
  --program-id "$KEYS_DIR/program.json" \
  --upgrade-authority "$KEYS_DIR/deployer.json" \
  --buffer "$BUFFER_KEY" \
  --max-len "$MAX_LEN" \
  --with-compute-unit-price 1000 \
  --use-rpc \
  --max-sign-attempts 20 2>&1 | tee "$OUT" | grep -E "Program Id|Signature|Error|error"
STATUS=${PIPESTATUS[0]}
set -e
if [ "$STATUS" -ne 0 ]; then
  echo "[deploy] FAILED (exit $STATUS). The buffer keypair $BUFFER_KEY is kept; re-running resumes the same deploy." >&2
  exit 1
fi
rm -f "$BUFFER_KEY"

TX="$(awk '/^Signature:/ {print $2}' "$OUT" | tail -1)"
SHOW="$(solana program show "$PROGRAM_ID" --url "$RPC_URL" --keypair "$KEYS_DIR/deployer.json")"
SLOT="$(printf '%s\n' "$SHOW" | awk -F': ' '/Last Deployed In Slot/ {print $2}')"
AUTH="$(printf '%s\n' "$SHOW" | awk -F': ' '/Authority/ {print $2}')"
LEN="$(printf '%s\n' "$SHOW" | awk -F': ' '/Data Length/ {print $2}' | awk '{print $1}')"

# ---- verify what is on chain equals what we built ----
DUMP="$(mktemp)"
solana program dump "$PROGRAM_ID" "$DUMP" --url "$RPC_URL" --keypair "$KEYS_DIR/deployer.json" >/dev/null
ONCHAIN_SHA="$(head -c "$SIZE" "$DUMP" | sha256sum | awk '{print $1}')"
rm -f "$DUMP"
if [ "$ONCHAIN_SHA" != "$SHA" ]; then
  echo "[deploy] WARNING: on-chain bytes differ from target/deploy/groundgraph.so (sha256 $ONCHAIN_SHA vs $SHA)" >&2
  exit 1
fi

python3 -I - "$RECORD" "$RPC_URL" "$PROGRAM_ID" "$TX" "$SLOT" "$DEPLOYER" "$SIZE" "$SHA" "$LEN" "$AUTH" "$MAX_LEN" <<'PY'
import json, sys, datetime
path, rpc, pid, tx, slot, deployer, size, sha, plen, auth, max_len = sys.argv[1:]
rec = {
    "cluster": "devnet" if "devnet" in rpc else rpc,
    "programId": pid,
    "deployed": True,
    "deployTx": tx or None,
    "slot": int(slot) if slot.isdigit() else None,
    "deployer": deployer,
    "upgradeAuthority": auth,
    "deployedAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "programSizeBytes": int(size),
    "programDataLengthBytes": int(plen) if plen.isdigit() else None,
    "maxLenBytes": int(max_len),
    "binarySha256": sha,
    "verified": "on-chain program bytes equal target/deploy/groundgraph.so (sha256)",
}
with open(path, "w") as f:
    json.dump(rec, f, indent=2)
    f.write("\n")
print(json.dumps({k: rec[k] for k in ("programId", "deployTx", "slot", "programSizeBytes")}))
PY
echo "[deploy] done; record written to ${RECORD#$ROOT/}"
