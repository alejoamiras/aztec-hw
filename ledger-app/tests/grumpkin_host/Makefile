# Host-side Grumpkin CLI — compiles the Grumpkin EC sources + their poseidon2
# fr_t coordinate-field dependency for the local machine (no BOLOS SDK) so we
# can exercise [k]G from bun tests.

CC ?= cc
CFLAGS ?= -std=c11 -O2 -Wall -Wextra -Wpedantic -Werror

POSEIDON2_DIR := ../../src/crypto/poseidon2
GRUMPKIN_DIR := ../../src/crypto/grumpkin
L4_DIR := ../../src/l4

SRCS := \
	$(POSEIDON2_DIR)/fr.c \
	$(POSEIDON2_DIR)/fr_params.c \
	$(POSEIDON2_DIR)/constants.c \
	$(POSEIDON2_DIR)/poseidon2.c \
	$(GRUMPKIN_DIR)/fq.c \
	$(GRUMPKIN_DIR)/fq_params.c \
	$(GRUMPKIN_DIR)/point.c \
	$(GRUMPKIN_DIR)/g1_generator.c \
	$(GRUMPKIN_DIR)/mul_generator.c \
	$(L4_DIR)/account_keys.c \
	$(L4_DIR)/deploy_outer_hash.c \
	main.c

OUT := grumpkin_cli

$(OUT): $(SRCS)
	$(CC) $(CFLAGS) -I$(POSEIDON2_DIR) -I$(GRUMPKIN_DIR) -I$(L4_DIR) -o $@ $(SRCS)

smoke: $(OUT)
	./$(OUT) smoke

clean:
	rm -f $(OUT)

.PHONY: smoke clean
