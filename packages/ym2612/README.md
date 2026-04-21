# @soundchips/ym2612

YM2612 (OPN2) FM sound chip emulator in pure JavaScript.

- 6 FM channels, 4 operators each
- 8 FM algorithms
- ADSR envelope generator
- Operator feedback (op1 self-modulation)
- FM3 special mode (4 independent operator frequencies)
- Direct register write interface (`write(port, addr, data)`)
- Sample generation (`clock(bufL, bufR, count)`)

Reference clock: 7,670,454 Hz (NTSC Mega Drive). Native sample rate: ~53,267 Hz.

## Install

```sh
pnpm add @soundchips/ym2612
```

Or import directly from a CDN (no build step required):

```js
import { YM2612, NATIVE_SAMPLE_RATE } from "https://esm.sh/@soundchips/ym2612";
```

## API

```js
import { YM2612, NATIVE_SAMPLE_RATE } from "@soundchips/ym2612";

const chip = new YM2612();

// Write a register (same as hardware register writes)
chip.write(port, addr, data); // port: 0 = ch1-3, 1 = ch4-6

// Generate samples
const bufL = new Float32Array(128);
const bufR = new Float32Array(128);
chip.clock(bufL, bufR, 128); // fills bufL/bufR with [-1, 1] float samples

// Reset
chip.reset();
```

## License

MIT © Hiroshi Okamura (5&UP Inc.)
