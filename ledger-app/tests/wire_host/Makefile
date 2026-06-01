# M12 P2 — off-device libFuzzer/ASan/UBSan harness for the wire-parser handlers.
#
# Compiles the REAL handler C + the real l4 sources + the VENDORED lib_standard_app
# buffer cluster (hostshim/, from BOLOS SDK v26.1.6 — see hostshim/VENDORED.md)
# against thin os.h/io.h shims. Built with Homebrew LLVM clang because Apple clang
# ships no libFuzzer runtime. Tests-only; the binary never goes near the device.
#
# Run a campaign to coverage plateau (manual, NOT CI this arc):
#   make fuzz_authwit && ./fuzz_authwit corpus/authwit -print_final_stats=1
#
# Faithfulness posture (see plan.md Security §): the buffer reader is vendored
# verbatim, the APDU buffer is a fixed 260B array, and fuzz-found accept/reject
# decisions are differential-replayed on Speculos. This harness proves per-APDU
# memory-safety + parser robustness, NOT multi-APDU session-state machines.

CLANG ?= /opt/homebrew/opt/llvm/bin/clang
FUZZ  := -fsanitize=fuzzer,address,undefined -g -O1 -std=c11 -Wall -Wextra
# Replay oracle: same sources + sanitizers, NO libFuzzer (replay_main.c owns main).
REPLAY := -fsanitize=address,undefined -g -O1 -std=c11 -Wall -Wextra
SRC     := ../../src
HANDLER := $(SRC)/handler
L4      := $(SRC)/l4
SHIM    := hostshim
INC     := -I$(SHIM) -I$(SRC) -I$(L4) -I$(HANDLER)

# Vendored lib_standard_app cluster — the buffer reader IS the thing under test.
VENDOR := $(SHIM)/buffer.c $(SHIM)/read.c $(SHIM)/varint.c $(SHIM)/write.c $(SHIM)/bip32.c

# --- P2a: begin_authwit (pure wire parser: version/curve/path/Fr-canonical gates) ---
AUTHWIT_SRCS := $(HANDLER)/begin_authwit.c $(L4)/session.c $(L4)/fr_canonical.c $(VENDOR) reservoir.c fuzz_authwit.c

fuzz_authwit: $(AUTHWIT_SRCS)
	$(CLANG) $(FUZZ) $(INC) -o $@ $(AUTHWIT_SRCS)

replay_authwit: $(AUTHWIT_SRCS) replay_main.c
	$(CLANG) $(REPLAY) $(INC) -o $@ $(AUTHWIT_SRCS) replay_main.c

# --- P2a: append_call (richest parser: allowlist gates + args_hash recompute) ---
POSEIDON2 := $(SRC)/crypto/poseidon2
CS        := $(SRC)/clear_signing_v0
APPEND_SRCS := $(HANDLER)/append_call.c $(L4)/session.c $(L4)/fr_canonical.c \
  $(CS)/args_hash.c $(CS)/registry.gen.c $(CS)/selectors.gen.c \
  $(POSEIDON2)/poseidon2.c $(POSEIDON2)/fr.c $(POSEIDON2)/fr_params.c $(POSEIDON2)/constants.c \
  $(VENDOR) reservoir.c fuzz_append_call.c

fuzz_append_call: $(APPEND_SRCS)
	$(CLANG) $(FUZZ) $(INC) -I$(CS) -I$(POSEIDON2) -o $@ $(APPEND_SRCS)

replay_append_call: $(APPEND_SRCS) replay_main.c
	$(CLANG) $(REPLAY) $(INC) -I$(CS) -I$(POSEIDON2) -o $@ $(APPEND_SRCS) replay_main.c

# --- P2b: begin_deploy parse-only seam (Option X — owner-approved) ---
# Fuzzes deploy_parse_and_validate() — the parse+validate half extracted from
# begin_deploy_account.c. The REAL handler .c is linked (so the parser is byte-
# identical to the device), but the fuzzer calls ONLY the parse fn, never the
# crypto/binding tail. begin_deploy_account.c #includes cx.h + crypto_helpers.h:
# both are EMPTY hostshim headers (no cx_* symbol is used directly here), and the
# three binding-tail crypto fns (account_binding_deploy_*, az_account_derive_from_
# path) are dead link-stubs IN fuzz_deploy_parse.c that __builtin_trap if reached
# — so "crypto is off the fuzz path" is self-enforcing, not just asserted.
# deploy_profiles.gen.c is dependency-free (no poseidon2 drag).
DEPLOY_SRCS := $(HANDLER)/begin_deploy_account.c $(L4)/session.c $(L4)/fr_canonical.c \
  $(CS)/deploy_profiles.gen.c $(VENDOR) reservoir.c fuzz_deploy_parse.c

fuzz_deploy_parse: $(DEPLOY_SRCS)
	$(CLANG) $(FUZZ) $(INC) -I$(CS) -o $@ $(DEPLOY_SRCS)

replay_deploy_parse: $(DEPLOY_SRCS) replay_main.c
	$(CLANG) $(REPLAY) $(INC) -I$(CS) -o $@ $(DEPLOY_SRCS) replay_main.c

# Convenience: build all three replay oracles for the differential-replay gate.
replay-all: replay_authwit replay_append_call replay_deploy_parse

# Supply-chain drift check for the vendored lib_standard_app cluster (VENDORED.md).
verify-vendored:
	@bash hostshim/verify-vendored.sh

clean:
	rm -f fuzz_authwit fuzz_append_call fuzz_deploy_parse \
	      replay_authwit replay_append_call replay_deploy_parse

.PHONY: clean verify-vendored replay-all
