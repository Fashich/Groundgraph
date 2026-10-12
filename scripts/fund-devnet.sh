#!/usr/bin/env bash
# Best-effort devnet funding from the public faucet, with backoff. The public faucet rate-limits per IP and per
# address, so this loops over several of the project keys and retries for a while.
#
# Usage: scripts/fund-devnet.sh [max_minutes] [target_sol_for_deployer]
#   Keys are read from .keys/ (git-ignored). Nothing secret is printed.
#   If the faucet never cooperates, fund the printed deployer address manually at https://faucet.solana.com
set -uo pipefail
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
URL="${SOLANA_URL:-https://api.devnet.solana.com}"
MAX_MIN="${1:-120}"
TARGET="${2:-3}"
KEYS=(deployer admin maker keeper faucet)

deadline=$(( $(date +%s) + MAX_MIN * 60 ))
delay=20
bal() { solana balance "$1" --url "$URL" 2>/dev/null | awk '{print $1}'; }

echo "[fund] deployer: $(solana-keygen pubkey "$ROOT/.keys/deployer.json")"
while [ "$(date +%s)" -lt "$deadline" ]; do
  got=0
  for k in "${KEYS[@]}"; do
    pk="$(solana-keygen pubkey "$ROOT/.keys/$k.json")"
    out="$(timeout 60 solana airdrop 2 "$pk" --url "$URL" 2>&1 | tail -1)"
    case "$out" in
      *SOL*) echo "[fund] $(date -u +%T) airdrop ok for $k ($pk): $out"; got=1; delay=20 ;;
      *) echo "[fund] $(date -u +%T) airdrop failed for $k: $out" ;;
    esac
    sleep 3
  done
  dep="$(bal "$(solana-keygen pubkey "$ROOT/.keys/deployer.json")")"
  echo "[fund] deployer balance: ${dep:-0} SOL"
  # Consolidate other keys into the deployer (keep 0.05 SOL on each for fees).
  for k in admin maker keeper faucet; do
    b="$(bal "$(solana-keygen pubkey "$ROOT/.keys/$k.json")")"
    if [ -n "${b:-}" ] && awk "BEGIN{exit !($b > 2.05)}"; then
      amt="$(awk "BEGIN{printf \"%.3f\", $b - 0.05}")"
      echo "[fund] consolidating $amt SOL from $k"
      # Only moves SOL that already belongs to our own keys.
      solana transfer "$(solana-keygen pubkey "$ROOT/.keys/deployer.json")" "$amt" --keypair "$ROOT/.keys/$k.json" \
        --url "$URL" --allow-unfunded-recipient --fee-payer "$ROOT/.keys/$k.json" >/dev/null 2>&1 || true
    fi
  done
  dep="$(bal "$(solana-keygen pubkey "$ROOT/.keys/deployer.json")")"
  if [ -n "${dep:-}" ] && awk "BEGIN{exit !($dep >= $TARGET)}"; then
    echo "[fund] target reached: $dep SOL"
    exit 0
  fi
  if [ "$got" -eq 0 ]; then
    delay=$(( delay * 2 )); [ "$delay" -gt 600 ] && delay=600
  fi
  echo "[fund] sleeping ${delay}s"
  sleep "$delay"
done
echo "[fund] gave up after ${MAX_MIN} minutes"
exit 1
