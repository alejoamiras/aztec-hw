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
SRC     := ../../src
HANDLER := $(SRC)/handler
L4      := $(SRC)/l4
SHIM    := hostshim
INC     := -I$(SHIM) -I$(SRC) -I$(L4) -I$(HANDLER)

# Vendored lib_standard_app cluster — the buffer reader IS the thing under test.
VENDOR := $(SHIM)/buffer.c $(SHIM)/read.c $(SHIM)/varint.c $(SHIM)/write.c $(SHIM)/bip32.c

# --- P2a: begin_authwit (pure wire parser: version/curve/path/Fr-canonical gates) ---
AUTHWIT_SRCS := $(HANDLER)/begin_authwit.c $(L4)/session.c $(L4)/fr_canonical.c $(VENDOR) fuzz_authwit.c

fuzz_authwit: $(AUTHWIT_SRCS)
	$(CLANG) $(FUZZ) $(INC) -o $@ $(AUTHWIT_SRCS)

# --- P2a: append_call (richest parser: allowlist gates + args_hash recompute) ---
POSEIDON2 := $(SRC)/crypto/poseidon2
CS        := $(SRC)/clear_signing_v0
APPEND_SRCS := $(HANDLER)/append_call.c $(L4)/session.c $(L4)/fr_canonical.c \
  $(CS)/args_hash.c $(CS)/registry.gen.c $(CS)/selectors.gen.c \
  $(POSEIDON2)/poseidon2.c $(POSEIDON2)/fr.c $(POSEIDON2)/fr_params.c $(POSEIDON2)/constants.c \
  $(VENDOR) fuzz_append_call.c

fuzz_append_call: $(APPEND_SRCS)
	$(CLANG) $(FUZZ) $(INC) -I$(CS) -I$(POSEIDON2) -o $@ $(APPEND_SRCS)

# Supply-chain drift check for the vendored lib_standard_app cluster (VENDORED.md).
verify-vendored:
	@bash hostshim/verify-vendored.sh

clean:
	rm -f fuzz_authwit fuzz_append_call fuzz_deploy_parse

.PHONY: clean verify-vendored
