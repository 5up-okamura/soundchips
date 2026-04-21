# soundchips

Pure JavaScript sound chip emulators for use with the Web Audio API AudioWorklet.

No dependencies. No build step. Works in any modern browser.

## Packages

| Package                                   | Chip          | System                          | Type                          |
| ----------------------------------------- | ------------- | ------------------------------- | ----------------------------- |
| [`@soundchips/ym2612`](packages/ym2612)   | YM2612 (OPN2) | Sega Mega Drive                 | FM, 6ch × 4 operators         |
| [`@soundchips/sn76489`](packages/sn76489) | SN76489       | Sega Mega Drive / SMS / Game Gear | PSG, 3× square + 1× noise  |

More chips planned: YM2151 (OPM), YM2413 (OPLL), SID 6581, 2A03, HuC6280.

## Usage

```js
import { YM2612, NATIVE_SAMPLE_RATE } from "@soundchips/ym2612";

const chip = new YM2612();
chip.write(0, 0x28, 0xf0); // key-on ch1
// ...
const bufL = new Float32Array(128);
const bufR = new Float32Array(128);
chip.clock(bufL, bufR, 128);
```

Since each package is a plain ES module with no build step, you can also import directly via a CDN:

```js
import { YM2612 } from "https://esm.sh/@soundchips/ym2612";
```

## Development

Requires [pnpm](https://pnpm.io/).

```sh
pnpm install
pnpm test       # run tests for all packages
```

## License

MIT © Hiroshi Okamura (5&UP Inc.)
