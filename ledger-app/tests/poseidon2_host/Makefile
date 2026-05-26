# Host-side Poseidon2 CLI — compiles `src/crypto/poseidon2/*.c` for the local
# machine (no BOLOS SDK) so we can exercise it from bun tests.

CC ?= cc
CFLAGS ?= -std=c11 -O2 -Wall -Wextra -Wpedantic -Werror

POSEIDON2_DIR := ../../src/crypto/poseidon2
SRCS := \
	$(POSEIDON2_DIR)/fr.c \
	$(POSEIDON2_DIR)/fr_params.c \
	$(POSEIDON2_DIR)/constants.c \
	$(POSEIDON2_DIR)/poseidon2.c \
	main.c

OUT := poseidon2_cli

$(OUT): $(SRCS)
	$(CC) $(CFLAGS) -I$(POSEIDON2_DIR) -o $@ $(SRCS)

smoke: $(OUT)
	./$(OUT) smoke

clean:
	rm -f $(OUT)

.PHONY: smoke clean
