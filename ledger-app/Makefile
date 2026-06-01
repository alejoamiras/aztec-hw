# ****************************************************************************
#    Ledger app — Aztec (PoC, L2 K1 baseline)
#
#   Licensed under the Apache License, Version 2.0.
# ****************************************************************************

ifeq ($(BOLOS_SDK),)
$(error Environment variable BOLOS_SDK is not set)
endif

include $(BOLOS_SDK)/Makefile.target

########################################
#        Mandatory configuration       #
########################################
APPNAME = "Aztec"

APPVERSION_M = 0
APPVERSION_N = 0
APPVERSION_P = 1
APPVERSION = "$(APPVERSION_M).$(APPVERSION_N).$(APPVERSION_P)"

APP_SOURCE_PATH += src

# Icons
ICON_NANOX = icons/app_aztec_14px.gif
ICON_NANOSP = icons/app_aztec_14px.gif
ICON_STAX = icons/app_aztec_32px.gif
ICON_FLEX = icons/app_aztec_40px.gif
ICON_APEX_P = icons/app_aztec_32px_apex.png

# Allowed derivation curves — L2 is K1-only. L4/L5 add r1/grumpkin later.
CURVE_APP_LOAD_PARAMS = secp256k1

# Allowed derivation paths. PoC placeholder per plan-final.md §2 (build-time override).
# Production builds set AZTEC_COIN_TYPE via `make AZTEC_COIN_TYPE=N`.
AZTEC_COIN_TYPE ?= 1666
PATH_APP_LOAD_PARAMS = "44'/$(AZTEC_COIN_TYPE)'" "13'"
DEFINES += AZTEC_COIN_TYPE=$(AZTEC_COIN_TYPE)
# Opt-in extra defines (empty by default → shipped build byte-identical). Used by
# the M12 P3 throwaway spike: `make … EXTRA_DEFINES=CX_MATH_SPIKE`.
DEFINES += $(EXTRA_DEFINES)

# Variant (just one — no token / family forks)
VARIANT_PARAM = COIN
VARIANT_VALUES = AZT

# Communication: USB-HID always; BLE only on devices with the radio.
ENABLE_BLUETOOTH = 1
ENABLE_NBGL_FOR_NANO_DEVICES = 1

# NBGL features
ENABLE_NBGL_QRCODE = 1

# Standard app feature flags pulled from the SDK build system
include $(BOLOS_SDK)/Makefile.standard_app
