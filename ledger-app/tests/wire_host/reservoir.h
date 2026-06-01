/* M12 P2 — reject reservoir for the differential-replay gate (codex Critical).
 *
 * libFuzzer's on-disk corpus is COVERAGE-minimized — it keeps one representative
 * per coverage feature, NOT a representative sample of REJECTED inputs. The
 * dangerous false-negative class the differential-replay exists to catch ("host
 * harness rejects, device accepts") can therefore be ABSENT from the corpus. So
 * during a fuzz campaign we separately harvest a STRATIFIED reservoir of inputs
 * keyed by (emitted SW, length bucket), capped per bucket, written to a dir.
 * The Speculos differential-replay then replays reservoir ∪ corpus ∪ valid-seeds.
 *
 * Zero overhead when WIRE_RESERVOIR is unset (one cached check, then a no-op):
 * a normal fuzz run is unaffected; a harvest run sets WIRE_RESERVOIR=<dir>.
 */
#pragma once

#include <stddef.h>
#include <stdint.h>

/* Capture `data[0..size)` into the reservoir IFF env WIRE_RESERVOIR=<dir> is set
 * and this (sw, len-bucket) bucket is not yet full. No-op otherwise. */
void reservoir_maybe_put(const uint8_t *data, size_t size, uint16_t sw);
