# @soundchips/sn76489

SN76489 (PSG) sound chip emulator in pure JavaScript.

- 3 square-wave tone channels (ch 0–2)
- 1 noise channel (ch 3) — white noise or periodic, with 3 fixed clock rates + tone-ch2 clock
- 4-bit volume attenuation per channel (0 = max, 15 = silent / −2 dB per step)
- Bit-accurate 15-bit Galois LFSR for noise generation
- Direct byte-write interface matching hardware (`write(data)`)
- Native-rate sample generation (`clock`) and built-in decimating output (`clockAt`)

Reference clock: 3,579,545 Hz (NTSC Mega Drive). Native sample rate: ~223,722 Hz.

## Install

```sh
pnpm add @soundchips/sn76489
```

Or import directly from a CDN (no build step required):

```js
import { SN76489, NATIVE_SAMPLE_RATE } from "https://esm.sh/@soundchips/sn76489";
```

## API

```js
import { SN76489, NATIVE_SAMPLE_RATE, MASTER_CLOCK } from "@soundchips/sn76489";

const chip = new SN76489();

// Write one byte to the chip (matches hardware byte protocol)
chip.write(0x9f); // ch0 att = 15 (silent)
chip.write(0x80); // latch ch0 frequency low nibble
chip.write(0x01); // data byte: high 6 bits of frequency

// Generate samples at native rate (~223722 Hz)
const bufL = new Float32Array(512);
const bufR = new Float32Array(512);
chip.clock(bufL, bufR, 512);

// Or generate at a target output rate with built-in box-filter decimation
chip.clockAt(bufL, bufR, 128, 44100);

// Inspect register state
const state = chip.getState();
// { tone: [{period, att, state}, ...], noise: {shift, type, att, lfsr} }

// Reset to power-on state
chip.reset();
```

### Byte protocol

Each write to the chip is a single byte:

| Bit 7 | Bits 6–5 | Bit 4 | Bits 3–0 | Meaning |
|-------|----------|-------|----------|---------|
| 1 | `ch` (0–3) | `r` (0=freq, 1=att) | data | **Latch byte** — sets register and low 4 bits |
| 0 | — | — | data (6 bits) | **Data byte** — high 6 bits of frequency for latched channel |

Attenuation and noise-control writes are single-byte (latch only, no data byte follows).

### Noise channel

The noise register latch byte: `1 | 11 | 0 | 0 | FB | NF1 | NF0`

| FB | NF | Clock rate |
|----|----|------------|
| 0 | 00 | `clock/512` (low) |
| 0 | 01 | `clock/1024` (medium) |
| 0 | 10 | `clock/2048` (high) |
| 0 | 11 | Tone channel 2 frequency |
| 1 | any | White noise (same clock rates) |

`FB=0` → periodic noise (fixed pitch); `FB=1` → white noise.

## License

MIT © Hiroshi Okamura (5&UP Inc.)
