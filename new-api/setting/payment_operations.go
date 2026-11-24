package setting

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/config"
)

type HostedPaymentOperations struct {
	AutoReconcileEnabled bool `json:"auto_reconcile_enabled"`
	IntervalMinutes      int  `json:"interval_minutes"`
	BatchSize            int  `json:"batch_size"`
	PendingAlertMinutes  int  `json:"pending_alert_minutes"`
}

var hostedPaymentOperations = HostedPaymentOperations{
	IntervalMinutes: 5, BatchSize: 20, PendingAlertMinutes: 30,
}

func init() {
	config.GlobalConfig.Register("payment_operations", &hostedPaymentOperations)
}

func GetHostedPaymentOperations() HostedPaymentOperations {
	// Read an atomic option snapshot rather than the mutable config pointer.
	result := HostedPaymentOperations{IntervalMinutes: 5, BatchSize: 20, PendingAlertMinutes: 30}
	common.OptionMapRWMutex.RLock()
	defer common.OptionMapRWMutex.RUnlock()
	result.AutoReconcileEnabled = common.OptionMap["payment_operations.auto_reconcile_enabled"] == "true"
	for key, target := range map[string]*int{
		"interval_minutes":      &result.IntervalMinutes,
		"batch_size":            &result.BatchSize,
		"pending_alert_minutes": &result.PendingAlertMinutes,
	} {
		option := "payment_operations." + key
		if value, exists := common.OptionMap[option]; exists && ValidateHostedPaymentOperationsOption(option, value) == nil {
			*target, _ = strconv.Atoi(value)
		}
	}
	return result
}

func ValidateHostedPaymentOperationsOption(key, value string) error {
	field, applies := strings.CutPrefix(key, "payment_operations.")
	if !applies {
		return nil
	}
	if field == "auto_reconcile_enabled" {
		if value != "true" && value != "false" {
			return fmt.Errorf("payment reconciliation must be true or false")
		}
		return nil
	}
	lower, upper := 1, 1440
	switch field {
	case "interval_minutes":
	case "batch_size":
		upper = 100
	case "pending_alert_minutes":
		lower, upper = 5, 10080
	default:
		return fmt.Errorf("unknown payment operations setting")
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed < lower || parsed > upper {
		return fmt.Errorf("payment operations value must be between %d and %d", lower, upper)
	}
	return nil
}
