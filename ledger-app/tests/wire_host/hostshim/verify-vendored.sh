#!/usr/bin/env bash
# M12 P2 — drift check: the vendored lib_standard_app files (+ status_words.h)
# must match the pinned SDK image verbatim. A silent drift weakens the fuzzer
# (false negatives). Requires docker.
#
# FAIL-CLOSED (codex P7 Major-3): if docker is unavailable we CANNOT verify, so we
# exit NON-ZERO — "unverified" must never read as "verified". Set
# VERIFY_VENDORED_ALLOW_NO_DOCKER=1 to downgrade to an advisory skip (accept the
# risk explicitly). NOTE: this pins the SDK image to v26.1.6; the FIRMWARE build
# must use the SAME BOLOS_SDK revision (ledger-app/Makefile BOLOS_SDK) or the
# fuzzer is exercising different buffer code than the device ships — re-pin both
# together. See hostshim/VENDORED.md.
set -euo pipefail
SDK_IMG="ghcr.io/ledgerhq/ledger-app-builder/ledger-app-builder-lite@sha256:852e1def30b4b8377120df663ebff91e9fd9b7548ee1fd8c0a3ff74df708a162"
HERE="$(cd "$(dirname "$0")" && pwd)"

if ! docker info >/dev/null 2>&1; then
  if [ "${VERIFY_VENDORED_ALLOW_NO_DOCKER:-0}" = "1" ]; then
    echo "verify-vendored: docker unavailable — ADVISORY SKIP (VERIFY_VENDORED_ALLOW_NO_DOCKER=1)"
    exit 0
  fi
  echo "verify-vendored: docker unavailable — CANNOT verify drift, failing closed." >&2
  echo "  (set VERIFY_VENDORED_ALLOW_NO_DOCKER=1 to skip at your own risk)" >&2
  exit 2
fi

docker run --rm -v "$HERE:/v" "$SDK_IMG" bash -c '
  ok=1; S=/opt/nanosplus-secure-sdk
  for f in buffer.h buffer.c read.h read.c varint.h varint.c write.h write.c macros.h bip32.h bip32.c; do
    diff -q "$S/lib_standard_app/$f" "/v/$f" >/dev/null 2>&1 || { echo "DRIFT: lib_standard_app/$f"; ok=0; }
  done
  diff -q "$S/include/status_words.h" "/v/status_words.h" >/dev/null 2>&1 || { echo "DRIFT: status_words.h"; ok=0; }
  if [ "$ok" = 1 ]; then echo "OK: vendored files match BOLOS SDK v26.1.6"; else echo "RE-VENDOR NEEDED (or re-pin the tag)"; exit 1; fi
'
