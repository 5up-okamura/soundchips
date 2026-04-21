/**
 * YM2612 (OPN2) emulator in pure JavaScript.
 *
 * Copyright (c) 2026 Hiroshi Okamura (5&UP Inc.)
 * SPDX-License-Identifier: MIT
 *
 * Generated with AI assistance. The log-sin/exponent table approach and
 * detune table values follow algorithms and constants documented in Yamaha
 * OPN2 application notes and widely-referenced open-source OPN2 emulators
 * (Nuked-OPN2 by nukeykt, MAME, Genesis Plus GX). No source code was
 * directly ported, but the numeric constants originate from the same chip
 * documentation those projects use.
 *
 * Covers the FM synthesis core needed for GMLisp playback:
 *   - 6 FM channels, 4 operators each
 *   - 8 FM algorithms
 *   - ADSR envelope generator
 *   - Operator feedback (op1 self-modulation)
 *   - FM3 special mode (4 independent operator frequencies)
 *   - Direct register write interface (write(port, addr, data))
 *   - Sample generation (clock(bufL, bufR, count))
 *
 * Reference clock: 7670454 Hz (NTSC Mega Drive)
 * Sample rate: clock / 144 ≈ 53267 Hz (native)
 *
 * Accuracy note: uses floating-point math rather than integer ROM
 * emulation. Chip-level quirks (ladder effect, specific overflow behaviors)
 * are not reproduced exactly, but the FM synthesis is faithful enough
 * for musical use and intentional parameter abuse.
 */

const MASTER_CLOCK = 7670454;
const SAMPLE_RATE_DIV = 144;
export const NATIVE_SAMPLE_RATE = MASTER_CLOCK / SAMPLE_RATE_DIV; // ~53267 Hz

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

// Quarter-sine in log domain (512 entries, [0, pi/2])
// logsin[i] = -log2(sin((i+0.5)*pi/512)) * 256
const LOGSIN = new Float32Array(512);
// Exponent table: expTable[i] = 2^(i/256)
const EXPTABLE = new Float32Array(256);

(function buildTables() {
  for (let i = 0; i < 512; i++) {
    LOGSIN[i] = -Math.log2(Math.sin(((i + 0.5) * Math.PI) / 512)) * 256;
  }
  for (let i = 0; i < 256; i++) {
    EXPTABLE[i] = Math.pow(2, i / 256);
  }
})();

// ---------------------------------------------------------------------------
// Detune table: dt1 offset in 1/64 phase units per clock
// Index: [DT1(0-7)][KCode(0-31)]  (simplified: 8 rows x 32 entries)
// Values are fine-frequency offsets added to F-num based phase increment.
// Derived from OPM/OPN documentation.
// ---------------------------------------------------------------------------
const DT_TABLE = [
  // DT1=0: no detune
  new Int16Array(32).fill(0),
  // DT1=1
  [
    0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 4, 4, 4, 4, 5, 5, 6, 6, 7,
    8, 8, 8, 11, 10, 0, 0,
  ],
  // DT1=2
  [
    0, 0, 0, 0, 2, 2, 2, 2, 4, 4, 4, 4, 5, 6, 6, 6, 8, 8, 8, 8, 10, 10, 12, 12,
    14, 15, 16, 16, 22, 20, 0, 0,
  ],
  // DT1=3
  [
    0, 0, 0, 0, 2, 2, 2, 2, 4, 4, 4, 4, 6, 6, 7, 8, 10, 10, 10, 10, 12, 12, 14,
    14, 16, 18, 20, 20, 27, 24, 0, 0,
  ],
  // DT1=4 (negative direction; mirrored from DT1=0)
  new Int16Array(32).fill(0),
  // DT1=5 (negative of DT1=1)
  [
    0, 0, 0, 0, -1, -1, -1, -1, -2, -2, -2, -2, -2, -3, -3, -3, -4, -4, -4, -4,
    -5, -5, -6, -6, -7, -8, -8, -8, -11, -10, 0, 0,
  ],
  // DT1=6 (negative of DT1=2)
  [
    0, 0, 0, 0, -2, -2, -2, -2, -4, -4, -4, -4, -5, -6, -6, -6, -8, -8, -8, -8,
    -10, -10, -12, -12, -14, -15, -16, -16, -22, -20, 0, 0,
  ],
  // DT1=7 (negative of DT1=3)
  [
    0, 0, 0, 0, -2, -2, -2, -2, -4, -4, -4, -4, -6, -6, -7, -8, -10, -10, -10,
    -10, -12, -12, -14, -14, -16, -18, -20, -20, -27, -24, 0, 0,
  ],
];

// LFO rate: frequency in Hz for each of the 8 rate settings (0-7)
const LFO_FREQ_HZ = [3.98, 5.56, 6.02, 6.37, 6.88, 9.63, 48.1, 72.2];
// LFO AM depth in envelope attenuation units for AMS 0-3 (~0, 1.4, 5.9, 11.8 dB)
const LFO_AM_DEPTH = [0, 15, 63, 126];
// LFO PM depth as fraction of base phaseInc for FMS 0-7 (~0 to 80 cents)
const LFO_PM_DEPTH = [
  0, 0.00335, 0.00669, 0.01004, 0.01344, 0.01908, 0.03726, 0.07089,
];

// ---------------------------------------------------------------------------
// Envelope timing table
// Rate 0-63 → samples per envelope step (simplified)
// ---------------------------------------------------------------------------
function envelopeStepSamples(rate) {
  if (rate === 0) return Infinity;
  if (rate >= 62) return 1;
  // Approximate: 2^((63-rate)/4) samples per step
  return Math.max(1, Math.round(Math.pow(2, (63 - rate) / 4)));
}

// ---------------------------------------------------------------------------
// Operator state
// ---------------------------------------------------------------------------
class Operator {
  constructor() {
    // Register parameters
    this.dt1 = 0; // detune (0-7)
    this.mul = 1; // multiplier 0-15 (0 = 0.5)
    this.tl = 0; // total level 0-127 (0=loudest)
    this.rs = 0; // rate scaling 0-3
    this.ar = 0; // attack rate 0-31
    this.am = 0; // AM enable
    this.dr = 0; // decay rate 1 (0-31)
    this.d2r = 0; // decay rate 2 / sustain rate (0-31)
    this.sl = 15; // sustain level 0-15 (15 = -93 dB)
    this.rr = 15; // release rate 0-15 → real rr = rr*2+1
    this.ssgEg = 0; // SSG-EG mode 0-15 (bit3=enable, bit2=At, bit1=Alt, bit0=Hold)

    // Internal state
    this.phase = 0; // 20-bit phase accumulator
    this.phaseInc = 0; // phase increment per sample
    this.envLevel = 1023; // current envelope attenuation (0=loud, 1023=silent)
    this.envState = "release"; // 'attack'|'decay'|'sustain'|'release'|'ssg'
    this.envCounter = 0; // samples until next envelope step
    this.output = 0; // last output sample (for feedback / modulation)
    this.outputPrev = 0; // previous output (for feedback averaging)
    this.ssgDir = 1; // SSG-EG direction: +1=decay(louder→silent), -1=attack(silent→loud)
    this.ssgHeld = false; // SSG-EG in hold state
  }

  keyOn(kcode) {
    this.phase = 0;
    this.envCounter = 0;
    this.output = 0;
    this.outputPrev = 0;
    if (this.ssgEg & 0x08) {
      // SSG-EG mode: bypass normal AR, start at position determined by At bit
      const at = (this.ssgEg >> 2) & 0x01;
      this.ssgDir = at ? -1 : 1; // At=0: start decaying, At=1: start attacking
      this.envLevel = at ? 1023 : 0;
      this.ssgHeld = false;
      this.envState = "ssg";
    } else {
      this.envState = "attack";
      this.envLevel = 1023;
    }
  }

  keyOff() {
    if (this.envState !== "release") {
      this.envState = "release";
      this.envCounter = 0;
    }
  }

  // Update envelope one sample
  tickEnvelope(kcode) {
    // SSG-EG mode: override ADSR with looping shape (release still uses RR)
    if (this.ssgEg & 0x08 && this.envState !== "release") {
      if (!this.ssgHeld) this._tickSsgEnvelope(kcode);
      return;
    }

    const rs = this.rs;
    const ksRate = kcode >> (3 - rs); // key scaling

    switch (this.envState) {
      case "attack": {
        const rate = Math.min(63, this.ar * 2 + ksRate);
        const step = envelopeStepSamples(rate);
        if (this.envCounter++ >= step) {
          this.envCounter = 0;
          // Attack is exponential: decrease level by fraction
          if (rate >= 62) {
            this.envLevel = 0;
          } else {
            this.envLevel -= (this.envLevel >> 2) + 1;
          }
          if (this.envLevel <= 0) {
            this.envLevel = 0;
            this.envState = "decay";
          }
        }
        break;
      }
      case "decay": {
        const rate = Math.min(63, this.dr * 2 + ksRate);
        const step = envelopeStepSamples(rate);
        if (this.envCounter++ >= step) {
          this.envCounter = 0;
          this.envLevel += 4; // linear decay
          if (this.envLevel >= this.sl * 64) {
            this.envLevel = this.sl * 64;
            this.envState = "sustain";
          }
        }
        break;
      }
      case "sustain": {
        const rate = Math.min(63, this.d2r * 2 + ksRate);
        if (rate > 0) {
          const step = envelopeStepSamples(rate);
          if (this.envCounter++ >= step) {
            this.envCounter = 0;
            this.envLevel += 4;
            if (this.envLevel >= 1023) this.envLevel = 1023;
          }
        }
        break;
      }
      case "release": {
        const rate = Math.min(63, this.rr * 4 + 2 + ksRate);
        const step = envelopeStepSamples(rate);
        if (this.envCounter++ >= step) {
          this.envCounter = 0;
          this.envLevel += 8;
          if (this.envLevel >= 1023) {
            this.envLevel = 1023;
          }
        }
        break;
      }
    }
  }

  // SSG-EG envelope tick (called instead of normal ADSR when ssgEg bit3 set)
  _tickSsgEnvelope(kcode) {
    const ksRate = kcode >> (3 - this.rs);
    const isDecay = this.ssgDir > 0;
    // Decay uses DR rate, attack uses AR rate
    const rate = Math.min(63, (isDecay ? this.dr * 2 : this.ar * 2) + ksRate);
    const step = envelopeStepSamples(rate);
    if (this.envCounter++ < step) return;
    this.envCounter = 0;
    if (isDecay) {
      this.envLevel += 4;
      if (this.envLevel >= 1023) {
        this.envLevel = 1023;
        this._ssgOnBoundary();
      }
    } else {
      this.envLevel -= (this.envLevel >> 2) + 1;
      if (this.envLevel <= 0) {
        this.envLevel = 0;
        this._ssgOnBoundary();
      }
    }
  }

  // Called when SSG-EG envelope hits a boundary (0 or 1023)
  _ssgOnBoundary() {
    const hold = this.ssgEg & 0x01;
    const alt = (this.ssgEg >> 1) & 0x01;
    const at = (this.ssgEg >> 2) & 0x01;
    if (hold) {
      this.ssgHeld = true;
      return;
    }
    if (alt) {
      // Flip direction for triangle-wave shapes
      this.ssgDir = -this.ssgDir;
    } else {
      // Reset to start position for sawtooth shapes
      this.envLevel = at ? 1023 : 0;
      this.ssgDir = at ? -1 : 1;
    }
  }

  // Compute operator output given modulation input (in phase units, 0-1023)
  compute(modPhase, amAttn = 0) {
    this.outputPrev = this.output;

    const totalAttn = this.tl * 8 + this.envLevel + (this.am ? amAttn : 0);
    if (totalAttn >= 1023) {
      this.output = 0;
      return 0;
    }

    const phaseIndex = ((this.phase >> 10) + modPhase) & 0x3ff; // 10-bit

    // Log-sin lookup: convert phase to quarter-sine index
    const quarter = phaseIndex >> 8; // 0-3
    let sinIndex = phaseIndex & 0xff; // 0-255 within quarter
    if (quarter & 1) sinIndex = 255 - sinIndex;
    const logsinVal = LOGSIN[sinIndex + (quarter & 2 ? 256 : 0)];
    // Actually LOGSIN is 512 entries for a half-period
    // quarter 0: index 0-255 (rising)
    // quarter 1: index 255-0 (falling)
    // then negative of above for quarters 2-3

    // Compute log of output: logsin + attenuation
    const logOutput = logsinVal + totalAttn;

    // Convert from log to linear via exp table
    const expIndex = logOutput & 0xff;
    const shift = logOutput >> 8;
    let linear = (EXPTABLE[expIndex] * 2048) >> shift;
    // Scale to ~[-2048, 2048]
    if (linear > 2047) linear = 2047;

    // Apply sign from quarter
    this.output = quarter >= 2 ? -linear : linear;
    return this.output;
  }
}

// ---------------------------------------------------------------------------
// Channel state
// ---------------------------------------------------------------------------
class Channel {
  constructor(index) {
    this.index = index;
    this.ops = [new Operator(), new Operator(), new Operator(), new Operator()];
    this.algorithm = 0; // 0-7
    this.feedback = 0; // 0-7
    this.fnum = 0; // 11-bit F-number
    this.block = 4; // 3-bit block
    this.fnum3ops = [0, 0, 0, 0]; // FM3 special mode per-op F-nums
    this.block3ops = [4, 4, 4, 4]; // FM3 special mode per-op blocks
    this.stereoL = true;
    this.stereoR = true;
    this.ams = 0; // LFO AM sensitivity 0-3
    this.fms = 0; // LFO FM sensitivity 0-7
    this.keyState = 0; // bitmask of which operators are keyed on

    // Precomputed phase increments
    this._updatePhaseIncs();
  }

  // F_num bits and block determine base frequency
  // phase_inc_per_sample = F_num * 2^(block-1) / 2^9
  // (phase accumulator is 20 bits, we want inc in those units)
  _phaseIncForFnum(fnum, block, mul) {
    const baseMul = mul === 0 ? 0.5 : mul;
    // phase_inc = F_num * 2^(block+1) * MUL / 2^20 * (phase_table_size=1024)
    // Actually: per sample, phase += F_num * 2^(block-1) * MUL (in 1/1024 cycle units, with 20-bit phase)
    return Math.round(fnum * Math.pow(2, block - 1) * baseMul);
  }

  _updatePhaseIncs() {
    const kcode = (this.block << 2) | ((this.fnum >> 7) & 3);
    for (let i = 0; i < 4; i++) {
      const op = this.ops[i];
      const baseMul = op.mul === 0 ? 0.5 : op.mul;
      const baseInc = Math.round(
        this.fnum * Math.pow(2, this.block - 1) * baseMul,
      );
      const dtOffset = DT_TABLE[op.dt1 & 0x07][Math.min(31, kcode)];
      op.phaseInc = Math.max(0, baseInc + dtOffset);
    }
  }

  setFnum(fnum, block) {
    this.fnum = fnum;
    this.block = block;
    this._updatePhaseIncs();
  }

  // FM3 special mode: set per-operator fnum/block (ops 1-3, indexed 0-2)
  setFnum3Op(opIndex, fnum, block) {
    this.fnum3ops[opIndex] = fnum;
    this.block3ops[opIndex] = block;
    const op = this.ops[opIndex];
    const kcode = (block << 2) | ((fnum >> 7) & 3);
    const baseMul = op.mul === 0 ? 0.5 : op.mul;
    const baseInc = Math.round(fnum * Math.pow(2, block - 1) * baseMul);
    const dtOffset = DT_TABLE[op.dt1 & 0x07][Math.min(31, kcode)];
    op.phaseInc = Math.max(0, baseInc + dtOffset);
  }

  keyOn(opMask) {
    // kcode from fnum + block (for rate scaling)
    const kcode = (this.block << 2) | ((this.fnum >> 7) & 3);
    this.keyState = opMask;
    for (let i = 0; i < 4; i++) {
      if (opMask & (1 << i)) this.ops[i].keyOn(kcode);
    }
  }

  keyOff(opMask) {
    this.keyState &= ~opMask;
    for (let i = 0; i < 4; i++) {
      if (opMask & (1 << i)) this.ops[i].keyOff();
    }
  }

  // Advance phase and envelope for each operator
  tick(lfoSin = 0, fmsDepth = 0) {
    const kcode = (this.block << 2) | ((this.fnum >> 7) & 3);
    for (const op of this.ops) {
      const pmOffset = Math.round(lfoSin * fmsDepth * op.phaseInc);
      op.phase = (op.phase + op.phaseInc + pmOffset) & 0xfffff; // 20-bit
      op.tickEnvelope(kcode);
    }
  }

  // Compute stereo output sample pair
  // feedback: op1 output feeds back into its own modulation
  computeOutput(amAttn = 0) {
    const [op1, op2, op3, op4] = this.ops;
    const fb = this.feedback;

    // Per-operator AM attenuation (only for ops with AM flag enabled)
    const am1 = op1.am ? amAttn : 0;
    const am2 = op2.am ? amAttn : 0;
    const am3 = op3.am ? amAttn : 0;
    const am4 = op4.am ? amAttn : 0;

    // Feedback modulation for op1 (average of last two outputs, scaled by feedback)
    const fbMod = fb > 0 ? (op1.output + op1.outputPrev) >> (9 - fb) : 0;

    // FM algorithm wiring (all 8 OPN2 algorithms)
    let out = 0;
    switch (this.algorithm) {
      case 0: {
        // 1 → 2 → 3 → 4
        const o1 = op1.compute(fbMod, am1);
        const o2 = op2.compute(o1 >> 1, am2);
        const o3 = op3.compute(o2 >> 1, am3);
        out = op4.compute(o3 >> 1, am4);
        break;
      }
      case 1: {
        // (1 + 2) → 3 → 4
        const o1 = op1.compute(fbMod, am1);
        const o2 = op2.compute(0, am2);
        const o3 = op3.compute((o1 + o2) >> 2, am3);
        out = op4.compute(o3 >> 1, am4);
        break;
      }
      case 2: {
        // (1 + (2 → 3)) → 4
        const o1 = op1.compute(fbMod, am1);
        const o2 = op2.compute(0, am2);
        const o3 = op3.compute(o2 >> 1, am3);
        out = op4.compute((o1 + o3) >> 2, am4);
        break;
      }
      case 3: {
        // ((1 → 2) + 3) → 4
        const o1 = op1.compute(fbMod, am1);
        const o2 = op2.compute(o1 >> 1, am2);
        const o3 = op3.compute(0, am3);
        out = op4.compute((o2 + o3) >> 2, am4);
        break;
      }
      case 4: {
        // (1 → 2) + (3 → 4)
        const o1 = op1.compute(fbMod, am1);
        const o2 = op2.compute(o1 >> 1, am2);
        const o3 = op3.compute(0, am3);
        const o4 = op4.compute(o3 >> 1, am4);
        out = (o2 + o4) >> 1;
        break;
      }
      case 5: {
        // (1 → 2) + (1 → 3) + (1 → 4)
        const o1 = op1.compute(fbMod, am1);
        const o2 = op2.compute(o1 >> 1, am2);
        const o3 = op3.compute(o1 >> 1, am3);
        const o4 = op4.compute(o1 >> 1, am4);
        out = (o2 + o3 + o4) / 3;
        break;
      }
      case 6: {
        // (1 → 2) + 3 + 4
        const o1 = op1.compute(fbMod, am1);
        const o2 = op2.compute(o1 >> 1, am2);
        const o3 = op3.compute(0, am3);
        const o4 = op4.compute(0, am4);
        out = (o2 + o3 + o4) / 3;
        break;
      }
      case 7: {
        // 1 + 2 + 3 + 4 (all carriers, no modulation)
        const o1 = op1.compute(fbMod, am1);
        const o2 = op2.compute(0, am2);
        const o3 = op3.compute(0, am3);
        const o4 = op4.compute(0, am4);
        out = (o1 + o2 + o3 + o4) >> 2;
        break;
      }
    }

    // Normalize to [-1, 1]
    const sample = out / 2047;
    return {
      l: this.stereoL ? sample : 0,
      r: this.stereoR ? sample : 0,
    };
  }
}

// ---------------------------------------------------------------------------
// YM2612 chip
// ---------------------------------------------------------------------------
export class YM2612 {
  constructor() {
    this.channels = Array.from({ length: 6 }, (_, i) => new Channel(i));
    this.fm3Mode = false; // FM3 special (independent operator) mode
    this.dacEnabled = false;
    this.dacSample = 0; // signed 8-bit DAC value
    this.lfoEnabled = false;
    this.lfoRate = 0;
    this._lfoPhase = 0; // LFO phase accumulator [0, 1)

    // Pending fnum register (needs both high/low bytes)
    this._fnumLow = new Uint16Array(6); // saved F-number low byte
    this._fnumHigh = new Uint16Array(6); // saved block + F-num high bits

    // FM3 per-operator fnum latches
    this._fn3Low = new Uint16Array(4);
    this._fn3High = new Uint16Array(4);
  }

  /**
   * Write a value to a YM2612 register.
   * @param {number} port  0 = bank 0 (ch1-3), 1 = bank 1 (ch4-6)
   * @param {number} addr  Register address (0x20-0xB6)
   * @param {number} data  8-bit value
   */
  write(port, addr, data) {
    data &= 0xff;

    // Global registers (port 0 only)
    if (port === 0) {
      if (addr === 0x22) {
        this.lfoEnabled = !!(data & 0x08);
        this.lfoRate = data & 0x07;
        return;
      }
      if (addr === 0x27) {
        this.fm3Mode = (data & 0xc0) === 0x40;
        return;
      }
      if (addr === 0x28) {
        // Key on/off
        const chSel = data & 0x07;
        if (chSel === 3) return; // invalid
        const chIndex = chSel < 3 ? chSel : chSel - 1; // 0,1,2,4,5,6 → 0..5
        const opMask = (data >> 4) & 0x0f;
        const ch = this.channels[chIndex];
        if (opMask) {
          ch.keyOn(opMask);
        } else {
          ch.keyOff(0x0f);
        }
        return;
      }
      if (addr === 0x2a) {
        this.dacSample = (data - 128) / 128; // normalize to [-1, 1]
        return;
      }
      if (addr === 0x2b) {
        this.dacEnabled = !!(data & 0x80);
        return;
      }
    }

    // Per-channel registers: determine channel index
    const chOffset = addr & 0x03;
    if (chOffset === 3) return; // invalid channel
    const chIndex = chOffset + port * 3;
    if (chIndex >= 6) return;
    const ch = this.channels[chIndex];

    // Per-operator registers (address decodes op via bits 3-2)
    // Operators layout in register space: op1=+0, op3=+4, op2=+8, op4=+12
    // (OPN2 order is 1,3,2,4 in register space)
    const OPN2_OP_ORDER = [0, 2, 1, 3]; // register op slot → logical op index
    const regBase = addr & 0xf0;
    const opSlot = (addr >> 2) & 0x03; // 0-3 within the 16-byte operator block
    const opIndex = OPN2_OP_ORDER[opSlot];
    const op = ch.ops[opIndex];

    switch (regBase) {
      case 0x30: // DT1 / MUL
        op.dt1 = (data >> 4) & 0x07;
        op.mul = data & 0x0f;
        ch._updatePhaseIncs();
        break;
      case 0x40: // TL
        op.tl = data & 0x7f;
        break;
      case 0x50: // RS / AR
        op.rs = (data >> 6) & 0x03;
        op.ar = data & 0x1f;
        break;
      case 0x60: // AM / DR
        op.am = (data >> 7) & 0x01;
        op.dr = data & 0x1f;
        break;
      case 0x70: // D2R (sustain rate)
        op.d2r = data & 0x1f;
        break;
      case 0x80: // SL / RR
        op.sl = (data >> 4) & 0x0f;
        op.rr = data & 0x0f;
        break;
      case 0x90: // SSG-EG
        op.ssgEg = data & 0x0f;
        break;
      case 0xa0: {
        // F-number low byte; the high byte (A4) must have been written first
        if (addr < 0xa4) {
          // 0xA0-0xA2: channel F-number low
          this._fnumLow[chIndex] = data;
          const high = this._fnumHigh[chIndex];
          const block = (high >> 3) & 0x07;
          const fnum = ((high & 0x07) << 8) | data;
          ch.setFnum(fnum, block);
        } else if (addr >= 0xa4 && addr <= 0xa6) {
          // 0xA4-0xA6: block and F-number MSB (write before A0)
          this._fnumHigh[chIndex] = data & 0x3f;
        } else if (addr >= 0xa8 && addr <= 0xaa && port === 0) {
          // 0xA8-0xAA: FM3 special mode operator F-number low (ops 1-3)
          const opIdx = addr - 0xa8; // 0,1,2 → ops 1,2,3 (indices 1,2,3 in ch2)
          this._fn3Low[opIdx + 1] = data;
          const high = this._fn3High[opIdx + 1];
          const block = (high >> 3) & 0x07;
          const fnum = ((high & 0x07) << 8) | data;
          this.channels[2].setFnum3Op(opIdx + 1, fnum, block);
        } else if (addr >= 0xac && addr <= 0xae && port === 0) {
          // 0xAC-0xAE: FM3 special mode operator F-number high
          const opIdx = addr - 0xac;
          this._fn3High[opIdx + 1] = data & 0x3f;
        }
        break;
      }
      case 0xb0: {
        const sub = addr & 0x0f;
        if (sub < 3) {
          // 0xB0-0xB2: algorithm and feedback
          ch.algorithm = data & 0x07;
          ch.feedback = (data >> 3) & 0x07;
        } else if (sub >= 4 && sub < 7) {
          // 0xB4-0xB6: stereo pan + AMS/FMS
          ch.stereoL = !!(data & 0x80);
          ch.stereoR = !!(data & 0x40);
          ch.ams = (data >> 4) & 0x03;
          ch.fms = data & 0x07;
        }
        break;
      }
    }
  }

  /**
   * Generate audio samples.
   * Fills outputL and outputR with 'count' samples in range [-1, 1].
   * @param {Float32Array} outputL
   * @param {Float32Array} outputR
   * @param {number} count
   */
  clock(outputL, outputR, count) {
    for (let s = 0; s < count; s++) {
      // Advance LFO
      if (this.lfoEnabled) {
        this._lfoPhase =
          (this._lfoPhase + LFO_FREQ_HZ[this.lfoRate] / NATIVE_SAMPLE_RATE) % 1;
      }
      const lfoSin = this.lfoEnabled
        ? Math.sin(2 * Math.PI * this._lfoPhase)
        : 0;
      // AM uses one-sided waveform: 0 = no attenuation, 1 = max attenuation
      const lfoAMNorm = this.lfoEnabled ? (1 - lfoSin) / 2 : 0;

      let sumL = 0;
      let sumR = 0;

      for (let ci = 0; ci < 6; ci++) {
        const ch = this.channels[ci];

        // DAC mode replaces channel 5 (FM ch6)
        if (ci === 5 && this.dacEnabled) {
          sumL += this.dacSample;
          sumR += this.dacSample;
          continue;
        }

        const fmsDepth = LFO_PM_DEPTH[ch.fms];
        const amAttn = Math.round(lfoAMNorm * LFO_AM_DEPTH[ch.ams]);
        ch.tick(lfoSin, fmsDepth);
        const out = ch.computeOutput(amAttn);
        sumL += out.l;
        sumR += out.r;
      }

      // Mix 6 channels; normalize
      outputL[s] = Math.max(-1, Math.min(1, sumL / 6));
      outputR[s] = Math.max(-1, Math.min(1, sumR / 6));
    }
  }
}
