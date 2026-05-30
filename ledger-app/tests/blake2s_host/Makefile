# Host-side Blake2s CLI — compiles the SAME src/crypto/blake2s.c that ships in
# the Ledger app (standalone, no BOLOS SDK / poseidon2 deps) so bun can parity
# it against node:crypto blake2s256 + RFC-7693.

CC ?= cc
CFLAGS ?= -std=c11 -O2 -Wall -Wextra -Wpedantic -Werror

CRYPTO_DIR := ../../src/crypto

SRCS := \
	$(CRYPTO_DIR)/blake2s.c \
	main.c

OUT := blake2s_cli

$(OUT): $(SRCS)
	$(CC) $(CFLAGS) -I$(CRYPTO_DIR) -o $@ $(SRCS)

smoke: $(OUT)
	./$(OUT) smoke

clean:
	rm -f $(OUT)

.PHONY: smoke clean
