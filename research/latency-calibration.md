# Jev flight timing calibration — 2026-09-19

The original controller forecast one arrival time from a moving average of recent response times. The bird could be tens of pixels away from that forecast when the action arrived. The new controller asks Jev for FLAP/WAIT at five possible arrival times in one request, then selects its answer nearest the elapsed **simulation** time at application. It does not replace Jev's choice with a local controller or slow the game.

The five times are 200, 350, 500, 650, and 800 ms. Each has its own projected geometry and action previews; the preview horizon uses the estimated delay of the *next* decision. This follows TypeSafe's [speculative fan-out pattern](https://docs.typesafe.ai/patterns/fan-out). Extra questions share a round trip but consume additional tokens.

## Live sample

Three flights per controller, seed `20260919`, model `jev-1.13.0`, normal physics, and an 18-second limit per flight. Real TypeSafe calls used the local test key without recording it. Arrival cases ran first; the original single-forecast controller was repeated immediately afterward.

| Measurement | Original single forecast | Five arrival cases |
| --- | ---: | ---: |
| Scores | 2, 4, 3 | 7, 7, 7 |
| Endings | All hit pipes | All alive at the test limit |
| Flight responses | 69 | 141 |
| Applied actions | 69 | 139 |
| Full client round trip, median / p95 | 455 / 606 ms | 360 / 446 ms |
| Absolute arrival-time prediction error, median / p95 | 125 / 205 ms | 17 / 67 ms |
| Absolute bird-y prediction error, median / p95 | 16.3 / 52.7 px | 2.4 / 15.9 px |
| Mean reported input tokens per flight request | 1,688 | 5,864 |
| Mean reported output tokens per flight request | 32.5 | 170.7 |

Two arrival-case responses exceeded the 900 ms stale limit and were discarded. Both controllers sometimes reached states where both action previews predicted a collision. Among actions with matched predictions, neither chose a colliding preview while the alternative was clear in this sample. Forecast accuracy and the limited decision rate remain relevant even when the model follows the previews.

**Limits:** This is a small sequential sample, not a randomized benchmark. Network/server timings differed, so the score difference cannot be attributed entirely to the new selection method. Seven pipes is the test's time limit, not the new controller's maximum score. Long latency spikes and future model mistakes can still cause crashes. The new request used about 3.5 times as many input tokens per response in this sample; no price or long-run performance guarantee is implied. All timing is end-to-end, not isolated model inference time.

## Reproduce and inspect

The ignored local evidence file is `logs/calibration/jev-2026-09-19T16-14-32.004Z-91293.jsonl`.

- Arrival cases: session `eceda780-2531-4210-b7b0-1aa245f998f0`, artifact `test/artifacts/live-auto-1789834537255.json`.
- Original forecast: session `07c94c38-b1bb-4515-834d-f8726a7349d5`, artifact `test/artifacts/live-auto-1789834591921.json`.

```sh
rtk npm run logs -- logs/calibration/jev-2026-09-19T16-14-32.004Z-91293.jsonl --session=eceda780-2531-4210-b7b0-1aa245f998f0
rtk npm run logs -- logs/calibration/jev-2026-09-19T16-14-32.004Z-91293.jsonl --session=07c94c38-b1bb-4515-834d-f8726a7349d5

# Billable tests, with the game server running and TYPESAFE_API_KEY in .env:
rtk proxy node --env-file=.env test/live-auto.mjs
rtk proxy env JEV_TEST_STRATEGY=single-forecast node --env-file=.env test/live-auto.mjs
```

Ongoing browser flights now write request IDs, exact submitted state/questions, probabilities, token usage, timing, applied/discarded decisions, pre/post-action states, prediction errors, and crash outcomes to `logs/jev/`. The analyzer excludes ambiguous request-ID joins in older logs and separates validation requests from flight latency statistics. Browser delivery is asynchronous and best effort.
