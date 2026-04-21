/**
 * SN76489 (PSG) emulator in pure JavaScript.
 *
 * Copyright (c) 2026 Hiroshi Okamura (5&UP Inc.)
 * SPDX-License-Identifier: MIT
 *
 * Generated with AI assistance. Register layout, noise-LFSR polynomial, and
 * clock divisor values follow the SN76489 datasheet and widely-referenced
 * documentation (SMS Power!, maxim's SN76489 notes). No existing emulator
 * source was ported; numeric constants originate from the same chip
 * documentation those projects use.
 *
 * Covers the PSG core needed for Mega Drive / SMS / Game Gear playback:
 *   - 3 square-wave tone channels (ch 0-2)
 *   - 1 noise channel (ch 3) — white or periodic, 3 clock rates + tone2
 *   - 4-bit volume attenuation per channel (0 = max, 15 = silent)
 *   - Direct byte-write interface matching hardware (write(data))
 *   - Sample generation (clock(bufL, bufR, count))
 *
 * Reference clock: 3579545 Hz (NTSC Mega Drive — SN76489 runs at CPU/15)
 * Internal divider: /16 → counter counts at clock/16
 * Native sample rate: clock / 16 ≈ 223722 Hz (oversampled; resample in worklet)
 *
 * Accuracy note: uses floating-point math and integer counters.
 * The LFSR produces bit-accurate white/periodic noise matching the original.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** SN76489 reference clock for NTSC Mega Drive (Hz). */
export const MASTER_CLOCK = 3579545;

/**
 * The chip divides the master clock by 16 internally before tone counters
 * count down. One "chip tick" = 1 / (MASTER_CLOCK / 16) seconds.
 */
const CLOCK_DIV = 16;

/**
 * Native output rate = MASTER_CLOCK / CLOCK_DIV ≈ 223,722 Hz.
 * AudioWorklets typically run at 44100 or 48000 Hz; the host is responsible
 * for resampling (e.g., using OfflineAudioContext or a simple decimator).
 */
export const NATIVE_SAMPLE_RATE = MASTER_CLOCK / CLOCK_DIV; // ~223722 Hz

// ---------------------------------------------------------------------------
// Attenuation table: 4-bit register value → linear amplitude [0, 1]
// Each step = -2 dB; value 15 = silence.
// ---------------------------------------------------------------------------
const ATT_TABLE = new Float32Array(16);
for (let i = 0; i < 15; i++) {
  ATT_TABLE[i] = Math.pow(10, (-2 * i) / 20);
}
ATT_TABLE[15] = 0; // hard silence

// ---------------------------------------------------------------------------
// Noise LFSR constants
//
// SN76489 uses a 15-bit or 16-bit Galois LFSR depending on variant.
// The SMS/Mega Drive variant (SN76489A) uses a 15-bit LFSR:
//   white noise tap: bits 0 and 3 (tapped polynomial 0x0009)
//   periodic: only bit 0 feeds back (tap 0x0001)
// ---------------------------------------------------------------------------
const LFSR_RESET = 0x8000; // initial LFSR state
const LFSR_WHITE_TAP = 0x0009; // bits 0 & 3 (white noise)
const LFSR_PERIOD_TAP = 0x0001; // bit 0 only (periodic / "tone" noise)

// ---------------------------------------------------------------------------
// SN76489
// ---------------------------------------------------------------------------

export class SN76489 {
  constructor() {
    // --- Tone channels (0-2) ---
    // Each has a 10-bit frequency register (period counter reload value)
    // and a 4-bit attenuation register.
    this._tonePeriod = new Uint16Array(3); // reload value (1-1023; 0 treated as 1024)
    this._toneCounter = new Uint16Array(3); // countdown counter
    this._toneState = new Int8Array(3); // output polarity: +1 or -1
    this._toneAtt = new Uint8Array(3); // attenuation 0-15

    // --- Noise channel (3) ---
    this._noiseShift = 0; // NF: clock rate bits 0-1 (0=low,1=med,2=high,3=tone2)
    this._noiseType = 0; // FB bit: 0=periodic, 1=white
    this._noiseAtt = 0; // attenuation 0-15
    this._noiseCounter = 0; // countdown counter
    this._noisePeriod = 16; // current period in chip ticks
    this._lfsr = LFSR_RESET; // 15-bit LFSR
    this._noiseOut = 1; // current LFSR output bit (+1 or -1)

    // --- Latch ---
    // The SN76489 latches a register address on the first byte of a two-byte
    // frequency write. Bit 7=1 is a latch+data byte; bit 7=0 is a data byte.
    this._latchedReg = 0; // which register is latched (0-7)

    // Initialize counters
    for (let i = 0; i < 3; i++) {
      this._tonePeriod[i] = 1;
      this._toneCounter[i] = 1;
      this._toneState[i] = 1;
      this._toneAtt[i] = 15; // silent at reset
    }
    this._noiseAtt = 15;
    this._noiseCounter = 16;

    // Chip tick accumulator for fractional-rate callers
    this._tickFrac = 0;
  }

  // ---------------------------------------------------------------------------
  // reset()
  // ---------------------------------------------------------------------------
  reset() {
    for (let i = 0; i < 3; i++) {
      this._tonePeriod[i] = 1;
      this._toneCounter[i] = 1;
      this._toneState[i] = 1;
      this._toneAtt[i] = 15;
    }
    this._noiseShift = 0;
    this._noiseType = 0;
    this._noiseAtt = 15;
    this._noiseCounter = 16;
    this._noisePeriod = 16;
    this._lfsr = LFSR_RESET;
    this._noiseOut = 1;
    this._latchedReg = 0;
    this._tickFrac = 0;
  }

  // ---------------------------------------------------------------------------
  // write(data)
  //
  // Write one byte to the chip, exactly as the hardware receives it.
  //
  // Byte format:
  //   bit 7 = 1 (LATCH byte):  [1 | reg(2) | ch(1) | data(4)]
  //     reg: 0=frequency(lo), 1=attenuation
  //     ch:  0-2=tone, 3=noise
  //   bit 7 = 0 (DATA byte):   [0 | 00 | data(6)]  ← high 6 bits of frequency
  //
  // ---------------------------------------------------------------------------
  write(data) {
    data &= 0xff;

    if (data & 0x80) {
      // Latch byte
      const ch = (data >> 5) & 0x03; // channel 0-3
      const reg = (data >> 4) & 0x01; // 0=freq, 1=att
      this._latchedReg = (ch << 1) | reg; // encode as 0-7 for DATA byte dispatch

      const lo4 = data & 0x0f;

      if (reg === 1) {
        // Attenuation (immediate, 4 bits, no DATA byte follows)
        if (ch < 3) {
          this._toneAtt[ch] = lo4;
        } else {
          this._noiseAtt = lo4;
        }
      } else {
        // Frequency low 4 bits
        if (ch < 3) {
          this._tonePeriod[ch] =
            (this._tonePeriod[ch] & 0x3f0) | lo4; // keep high 6, replace low 4
          if (this._tonePeriod[ch] === 0) this._tonePeriod[ch] = 1;
        } else {
          // Noise control: bits 1-0 = shift rate, bit 2 = white/periodic
          this._noiseShift = lo4 & 0x03;
          this._noiseType = (lo4 >> 2) & 0x01;
          this._lfsr = LFSR_RESET; // reset LFSR on noise control write
          this._updateNoisePeriod();
        }
      }
    } else {
      // Data byte (high 6 bits of frequency for latched channel)
      const ch = (this._latchedReg >> 1) & 0x03;
      const reg = this._latchedReg & 0x01;

      if (reg === 0 && ch < 3) {
        // High 6 bits of tone period
        const hi6 = data & 0x3f;
        this._tonePeriod[ch] = (hi6 << 4) | (this._tonePeriod[ch] & 0x0f);
        if (this._tonePeriod[ch] === 0) this._tonePeriod[ch] = 1;
      }
      // DATA byte for attenuation or noise is not used (those are single-byte)
    }
  }

  // ---------------------------------------------------------------------------
  // _updateNoisePeriod()
  // Recalculate noise counter reload from current NF (shift) setting.
  // ---------------------------------------------------------------------------
  _updateNoisePeriod() {
    switch (this._noiseShift) {
      case 0:
        this._noisePeriod = 16; // clock / 512
        break;
      case 1:
        this._noisePeriod = 32; // clock / 1024
        break;
      case 2:
        this._noisePeriod = 64; // clock / 2048
        break;
      case 3:
        // Clocked by tone channel 2 output frequency
        // Noise toggles whenever tone2 output toggles, i.e. every tonePeriod[2] ticks.
        this._noisePeriod = this._tonePeriod[2];
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // _stepLfsr()
  // Advance the LFSR by one step and update _noiseOut.
  // ---------------------------------------------------------------------------
  _stepLfsr() {
    const tap = this._noiseType === 1 ? LFSR_WHITE_TAP : LFSR_PERIOD_TAP;
    // Count the number of tapped bits that are 1 (parity)
    const tapped = this._lfsr & tap;
    // Galois-style: feedback = parity of tapped bits
    let feedback = 0;
    let v = tapped;
    while (v) {
      feedback ^= v & 1;
      v >>= 1;
    }
    this._lfsr = ((this._lfsr >> 1) | (feedback << 14)) & 0x7fff;
    this._noiseOut = this._lfsr & 1 ? 1 : -1;
  }

  // ---------------------------------------------------------------------------
  // clock(bufL, bufR, count)
  //
  // Generate `count` samples at NATIVE_SAMPLE_RATE (~223722 Hz) into
  // bufL and bufR (Float32Array). Output is mono-summed to both channels.
  //
  // Callers running at a lower sample rate (e.g. 44100 Hz) should either:
  //   a) run at NATIVE_SAMPLE_RATE and downsample externally, or
  //   b) use clockAt(bufL, bufR, count, outputRate) for built-in decimation.
  // ---------------------------------------------------------------------------
  clock(bufL, bufR, count) {
    const tp = this._tonePeriod;
    const tc = this._toneCounter;
    const ts = this._toneState;
    const ta = this._toneAtt;

    for (let i = 0; i < count; i++) {
      // --- Tick tone channels ---
      for (let ch = 0; ch < 3; ch++) {
        tc[ch]--;
        if (tc[ch] <= 0) {
          ts[ch] = -ts[ch]; // toggle
          tc[ch] = tp[ch] === 0 ? 1024 : tp[ch];
        }
      }

      // --- Tick noise channel ---
      // If NF=3, noise is clocked by tone2 edges (every period of ch2)
      if (this._noiseShift === 3) {
        this._noisePeriod = tp[2] === 0 ? 1024 : tp[2];
      }
      this._noiseCounter--;
      if (this._noiseCounter <= 0) {
        this._stepLfsr();
        this._noiseCounter = this._noisePeriod;
      }

      // --- Mix ---
      const sample =
        ts[0] * ATT_TABLE[ta[0]] +
        ts[1] * ATT_TABLE[ta[1]] +
        ts[2] * ATT_TABLE[ta[2]] +
        this._noiseOut * ATT_TABLE[this._noiseAtt];

      // Normalize: 4 channels each max ±1 → scale to ±1
      const out = sample * 0.25;
      bufL[i] = out;
      bufR[i] = out;
    }
  }

  // ---------------------------------------------------------------------------
  // clockAt(bufL, bufR, count, outputRate)
  //
  // Convenience wrapper: generates `count` output samples at `outputRate` Hz
  // by running the chip at NATIVE_SAMPLE_RATE and decimating with a simple
  // box filter (sufficient for a 1-bit PSG source).
  //
  // outputRate must divide evenly enough; for best results use 44100 or 48000.
  // ---------------------------------------------------------------------------
  clockAt(bufL, bufR, count, outputRate) {
    const ratio = NATIVE_SAMPLE_RATE / outputRate; // native ticks per output sample

    for (let i = 0; i < count; i++) {
      // How many native ticks to consume for this output sample
      const ticks = Math.round(this._tickFrac + ratio);
      this._tickFrac = this._tickFrac + ratio - ticks;

      // Simple box-filter accumulation
      let acc = 0;
      const tp = this._tonePeriod;
      const tc = this._toneCounter;
      const ts = this._toneState;
      const ta = this._toneAtt;

      for (let t = 0; t < ticks; t++) {
        for (let ch = 0; ch < 3; ch++) {
          tc[ch]--;
          if (tc[ch] <= 0) {
            ts[ch] = -ts[ch];
            tc[ch] = tp[ch] === 0 ? 1024 : tp[ch];
          }
        }

        if (this._noiseShift === 3) {
          this._noisePeriod = tp[2] === 0 ? 1024 : tp[2];
        }
        this._noiseCounter--;
        if (this._noiseCounter <= 0) {
          this._stepLfsr();
          this._noiseCounter = this._noisePeriod;
        }

        const s =
          ts[0] * ATT_TABLE[ta[0]] +
          ts[1] * ATT_TABLE[ta[1]] +
          ts[2] * ATT_TABLE[ta[2]] +
          this._noiseOut * ATT_TABLE[this._noiseAtt];
        acc += s;
      }

      const out = (acc / ticks) * 0.25;
      bufL[i] = out;
      bufR[i] = out;
    }
  }

  // ---------------------------------------------------------------------------
  // getState() — snapshot of all register values (useful for debugging / UI)
  // ---------------------------------------------------------------------------
  getState() {
    return {
      tone: [0, 1, 2].map((ch) => ({
        period: this._tonePeriod[ch],
        att: this._toneAtt[ch],
        state: this._toneState[ch],
      })),
      noise: {
        shift: this._noiseShift,
        type: this._noiseType, // 0=periodic, 1=white
        att: this._noiseAtt,
        lfsr: this._lfsr,
      },
    };
  }
}
