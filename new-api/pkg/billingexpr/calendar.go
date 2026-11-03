package billingexpr

import (
	_ "embed"
	"strconv"
	"time"

	"github.com/QuantumNous/new-api/common"
)

// The same versioned public data is imported by the browser simulator.
//
//go:embed data/deepseek-calendar.json
var deepSeekCalendarJSON []byte

var deepSeekCalendar struct {
	RuleVersion string `json:"rule_version"`
	Years       map[string]struct {
		Version  string      `json:"version"`
		Holidays [][2]string `json:"holidays"`
	} `json:"years"`
}

var beijingBillingZone = time.FixedZone("Asia/Shanghai", 8*60*60)

func init() {
	if err := common.Unmarshal(deepSeekCalendarJSON, &deepSeekCalendar); err != nil {
		common.SysError("invalid embedded DeepSeek holiday calendar; off-peak fallback applies")
	}
}

// DeepSeekPeriod is safe to freeze in a billing snapshot and expose in logs.
// Unknown years deliberately use off-peak, never a guessed holiday calendar.
type DeepSeekPeriod struct {
	RuleVersion     string     `json:"rule_version"`
	CalendarVersion string     `json:"calendar_version,omitempty"`
	CalendarReady   bool       `json:"calendar_ready"`
	Peak            bool       `json:"peak"`
	BillingTime     time.Time  `json:"billing_time"`
	NextSwitch      *time.Time `json:"next_switch,omitempty"`
	Reason          string     `json:"reason"`
}

func deepSeekPeriodAt(at time.Time) DeepSeekPeriod {
	at = at.In(beijingBillingZone)
	status := DeepSeekPeriod{RuleVersion: deepSeekCalendar.RuleVersion, BillingTime: at, Reason: "missing_calendar"}
	calendar, ok := deepSeekCalendar.Years[strconv.Itoa(at.Year())]
	if !ok || calendar.Version == "" || len(calendar.Holidays) == 0 {
		return status
	}
	status.CalendarReady, status.CalendarVersion = true, calendar.Version
	status.Reason = "off_peak"
	if at.Weekday() == time.Saturday || at.Weekday() == time.Sunday {
		status.Reason = "weekend"
		return status
	}
	date := at.Format(time.DateOnly)
	for _, holiday := range calendar.Holidays {
		if date >= holiday[0] && date <= holiday[1] {
			status.Reason = "public_holiday"
			return status
		}
	}
	status.Peak = (at.Hour() >= 9 && at.Hour() < 12) || (at.Hour() >= 14 && at.Hour() < 18)
	if status.Peak {
		status.Reason = "peak"
	}
	return status
}

// DeepSeekPeriodAt describes the published rule and its next state transition.
func DeepSeekPeriodAt(at time.Time) DeepSeekPeriod {
	status := deepSeekPeriodAt(at)
	if !status.CalendarReady {
		return status
	}
	local := at.In(beijingBillingZone)
	for offset := range 370 {
		date := local.AddDate(0, 0, offset)
		for _, hour := range []int{0, 9, 12, 14, 18} {
			next := time.Date(date.Year(), date.Month(), date.Day(), hour, 0, 0, 0, beijingBillingZone)
			if !next.After(at) {
				continue
			}
			period := deepSeekPeriodAt(next)
			if period.Peak != status.Peak || period.CalendarReady != status.CalendarReady {
				status.NextSwitch = &next
				return status
			}
		}
	}
	return status
}
