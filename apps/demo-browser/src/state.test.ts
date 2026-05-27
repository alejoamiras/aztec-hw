/**
 * Unit tests for the structured-step phase machinery (M7 P1).
 *
 * Codex audit MINOR #1: backwards phase transitions throw in dev/test.
 * These tests assert the throw fires AND non-backwards transitions
 * (forward or same-phase) don't throw.
 */
import { describe, expect, it } from 'bun:test';
import type { PhaseId } from '@aztec-hwwallet-poc/adapter-ledger';
import { assertMonotonicPhase, PHASE_ORDER } from './state.ts';

describe('assertMonotonicPhase', () => {
  it('PHASE_ORDER is the documented 6-step pipeline', () => {
    expect(PHASE_ORDER).toEqual(['build', 'sign', 'prove', 'submit', 'include', 'done']);
  });

  it('no-op on empty step history', () => {
    expect(() => assertMonotonicPhase('build', [])).not.toThrow();
  });

  it('forward transitions are accepted', () => {
    const steps: { phase: PhaseId }[] = [];
    for (const phase of PHASE_ORDER) {
      expect(() => assertMonotonicPhase(phase, steps)).not.toThrow();
      steps.push({ phase });
    }
  });

  it('same-phase emission is accepted (multiple build-stage steps)', () => {
    const steps: { phase: PhaseId }[] = [{ phase: 'build' }, { phase: 'build' }];
    expect(() => assertMonotonicPhase('build', steps)).not.toThrow();
  });

  it('throws on backwards transition (sign → build)', () => {
    const steps: { phase: PhaseId }[] = [{ phase: 'build' }, { phase: 'sign' }];
    expect(() => assertMonotonicPhase('build', steps)).toThrow(/backwards phase transition/);
  });

  it('throws on backwards transition (done → submit)', () => {
    const steps: { phase: PhaseId }[] = [{ phase: 'build' }, { phase: 'done' }];
    expect(() => assertMonotonicPhase('submit', steps)).toThrow(/backwards phase transition/);
  });

  it('error message names both phases + indices for debuggability', () => {
    const steps: { phase: PhaseId }[] = [{ phase: 'prove' }];
    expect(() => assertMonotonicPhase('build', steps)).toThrow(/prove \(idx=2\).*build \(idx=0\)/);
  });
});
