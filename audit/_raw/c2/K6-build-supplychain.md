<!-- codex K6 build/supply-chain, read-only xhigh -->

### F-K6-1: Mutable GitHub Action Refs In The Firmware Gate
Severity: HIGH — the firmware build gate itself trusts moving action tags, so a compromised/ref-retargeted action can change what source is checked out, whether the build runs, or what artifact gets archived for flashing.

Owned: OURS

Category: BUILD

Location: [.github/workflows/ledger-app.yml](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/.github/workflows/ledger-app.yml:19), [.github/workflows/ci.yml](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/.github/workflows/ci.yml:19)

What: both workflows use mutable `uses:` refs instead of immutable SHAs/digests.

Attack-impact: a build-time actor who compromises `dorny/paths-filter`, `setup-bun`, `upload-artifact`, `download-artifact`, or even `checkout` can skip the firmware job, alter the workspace, or swap the ELF that later gets tested and flashed.

Evidence: `"uses: dorny/paths-filter@v4"`, `"uses: oven-sh/setup-bun@v2"`, `"uses: actions/upload-artifact@v4"`, `"uses: actions/download-artifact@v4"`.

Fix-sketch: pin every `uses:` target to a full commit SHA; pin `docker://rhysd/actionlint:1.7.7` by digest too.

Confidence: high

Dedup-check: novel; distinct from AHW-031/039/067/069/072, which are CI coverage, lockfile, warning-policy, or compiler drift findings, not workflow-action supply chain.

### F-K6-2: Firmware Workflow Compiles Unchecked Generated Tables
Severity: HIGH — the device binary can be built from hand-edited checked-in `*.gen.*` without that workflow ever reconciling them against the reviewed manifest/codegen.

Owned: OURS

Category: BUILD

Location: [.github/workflows/ledger-app.yml](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/.github/workflows/ledger-app.yml:63), [ledger-app/Makefile](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/Makefile:23), [.github/workflows/ci.yml](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/.github/workflows/ci.yml:33), [ledger-app/src/clear_signing_v0/registry.gen.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/clear_signing_v0/registry.gen.c:1)

What: `ledger-app.yml` runs `make BOLOS_SDK=...` directly; the only explicit `gen:clear-signing-v0:check` gate is in `ci.yml`, not in the firmware build workflow.

Attack-impact: a malicious build-time actor can hand-edit `registry.gen.c` / `selectors.gen.c` / `deploy_profiles.gen.c` and produce a poisoned `app.elf`; the firmware workflow will compile it, and downstream tests will exercise that poisoned artifact rather than bind it back to the manifest.

Evidence: `"APP_SOURCE_PATH += src"`, `"make BOLOS_SDK=${{ matrix.sdk.path }}"`, and only CI has `"bun run --cwd packages/adapter-ledger gen:clear-signing-v0:check"`.

Fix-sketch: make the firmware workflow fail closed on gen drift before `make`, or regenerate in-job and diff the emitted C/TS tables.

Confidence: high

Dedup-check: distinct from AHW-035 (mutable artifact provenance), AHW-042 (registry-field coverage), and in-flight F-H-1 (unchecked deploy-profile literals). This is the missing build gate on the emitted generated sources themselves.

### F-K6-3: CI Blesses The Same ELF It Built, Not An Independently Reproduced One
Severity: HIGH — the exact ELF that would ship is neither independently rebuilt nor digest-verified; a poisoned build can self-bless.

Owned: OURS

Category: BUILD

Location: [.github/workflows/ledger-app.yml](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/.github/workflows/ledger-app.yml:66), [.github/workflows/ledger-app.yml](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/.github/workflows/ledger-app.yml:96), [.github/workflows/ledger-app.yml](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/.github/workflows/ledger-app.yml:104), [ledger-app/README.md](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/README.md:41)

What: the build job uploads `ledger-app/build/**` and `ledger-app/bin/**`; Speculos and ragger then download that same artifact and test it. There is no second clean rebuild, and `app.sha256` is never consumed as a verification gate.

Attack-impact: if the builder, workflow, or post-build artifact handling is compromised, the compromised ELF is exactly what gets tested and later flashed. That is not reproducibility; it is same-artifact validation.

Evidence: `"uses: actions/upload-artifact@v4"`, `"uses: actions/download-artifact@v4"`, Speculos runs `"/app/app.elf"`, while README says outputs include `"bin/app.sha256"`.

Fix-sketch: add a second clean rebuild that must match byte-for-byte, and verify the ELF digest between jobs before tests count. Prefer signed provenance over a bare hash file.

Confidence: high

Dedup-check: distinct from AHW-034. AHW-034 is source-tree provenance; this is binary attestation/reproducibility of the built ELF.

### F-K6-4: BOLOS SDK Identity Is Not Asserted Or Recorded
Severity: MED — the firmware output depends on whatever SDK is mounted at `BOLOS_SDK`, but the build interface never proves which SDK revision produced the ELF.

Owned: MIXED — Ledger BOLOS SDK plus our build interface

Category: BUILD

Location: [ledger-app/Makefile](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/Makefile:7), [ledger-app/Makefile](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/Makefile:11), [ledger-app/README.md](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/README.md:35), [ledger-app/tests/README.md](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/tests/README.md:16)

What: the Makefile only checks that `BOLOS_SDK` exists, then blindly includes `$(BOLOS_SDK)/Makefile.target` and `Makefile.standard_app`. The local ragger README worsens this by using `ledger-app-builder-lite:latest`.

Attack-impact: a stale or malicious SDK revision can silently change compiler/runtime behavior while the build still succeeds, leaving no machine-readable proof that the shipped ELF came from the reviewed SDK/toolchain set.

Evidence: `"include $(BOLOS_SDK)/Makefile.target"`, `"include $(BOLOS_SDK)/Makefile.standard_app"`, `"make BOLOS_SDK=/opt/nanosplus-secure-sdk"`, and local test docs use `"ledger-app-builder-lite:latest"`.

Fix-sketch: assert an expected SDK version/hash at build time, emit it alongside `app.sha256`, and point the local harness at the same digest-pinned builder path as CI.

Confidence: med-high

Dedup-check: distinct from AHW-034 and AHW-069. AHW-034 is firmware subtree provenance; AHW-069 is clang drift inside the builder. This is the unasserted BOLOS SDK identity at the build interface.

**Confirmed clean**
- CI does digest-pin the production builder and Speculos images in [.github/workflows/ledger-app.yml](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/.github/workflows/ledger-app.yml:49) and [.github/workflows/ledger-app.yml](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/.github/workflows/ledger-app.yml:107).
- The production build README uses the same digest-pinned images as CI in [ledger-app/README.md](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/README.md:35).
- CI uses frozen installs in [.github/workflows/ci.yml](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/.github/workflows/ci.yml:27) and [.github/workflows/ledger-app.yml](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/.github/workflows/ledger-app.yml:93), and Bun min-age is set in [bunfig.toml](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/bunfig.toml:7).
- The codegen checker is fail-closed on selector/arg-count/visibility and deploy class-id/ctor-selector drift in [gen-clear-signing-v0.ts](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/packages/adapter-ledger/scripts/gen-clear-signing-v0.ts:142) and [gen-clear-signing-v0.ts](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/packages/adapter-ledger/scripts/gen-clear-signing-v0.ts:478).
- `EXTRA_DEFINES` is empty by default in [ledger-app/Makefile](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/Makefile:40); I did not find a release-path define that enables the spike by default.