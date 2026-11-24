# DeepSeek V4 Pro Official Numeric Pricing

2026-11-24 corrected the V4 Pro retail expressions using the [DeepSeek official CNY pricing table](https://api-docs.deepseek.com/zh-cn/quick_start/pricing). Prices below are site credits per million tokens before the existing group multiplier. The operator's CNY-equivalent credit policy is retained; no exchange-rate conversion is introduced.

| Period | Uncached Input | Cache Read | Output |
| --- | ---: | ---: | ---: |
| Off-peak | 4.5 | 0.15 | 13.5 |
| Peak | 9 | 0.3 | 27 |

The official table identifies `deepseek-v4-pro` as DeepSeek-V4-Pro-0813. Current ZeroCat public pricing agrees with these numbers. XKRelay's public `/api/pricing` still lists off-peak 9/0.3/27 and peak 18/0.6/54; those are that site's configured prices, not the official CNY rates.

The existing `deepseekPeak()` holiday calendar and request-arrival price lock remain in place. The same expression is saved for `deepseek-v4-pro`, `deepseek-v4-pro-0813`, and `cn:deepseek-v4-pro`:

```text
deepseekPeak() ? tier("peak", p * 9 + cr * 0.3 + c * 27) : tier("off_peak", p * 4.5 + cr * 0.15 + c * 13.5)
```

Validation: all three drafts passed `POST /api/option/model_pricing/preview`; 28 evaluations using the actual billing expression engine passed for input, output, cache reads, mixed usage, peak boundaries, weekends, and holidays. The versioned `PATCH /api/option/model_pricing` succeeded, and configured/effective prices were read back. The remaining 392 model entries, all group and other options, channel configuration, and service PID were unchanged. No model generation was called.

At verification, only the base model had an enabled channel and appeared in the pricing display; the two inactive aliases were updated without enabling channels. Historical bills and in-flight pricing snapshots were not recalculated. Temporary before/preview data stays outside Git; only the non-secret receipt is retained after verification.
