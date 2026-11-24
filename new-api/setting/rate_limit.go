package setting

import (
	"fmt"
	"math"
	"strconv"
	"sync"

	"github.com/QuantumNous/new-api/common"
)

// maxRateLimitDurationSeconds is the largest window the count cap is computed
// against (24h). Token-bucket capacity is count*duration; this keeps that
// product inside int64 when the window is at most a day.
const maxRateLimitDurationSeconds = 24 * 60 * 60

// maxModelRequestRateLimitCount is math.MaxInt64 / maxRateLimitDurationSeconds.
// It is the largest count that cannot overflow int64(count)*duration for a
// window of at most 24 hours.
const maxModelRequestRateLimitCount int64 = math.MaxInt64 / maxRateLimitDurationSeconds

var ModelRequestRateLimitEnabled = false
var ModelRequestRateLimitDurationMinutes = 1
var ModelRequestRateLimitCount = 0
var ModelRequestRateLimitSuccessCount = 1000
var ModelRequestRateLimitGroup = map[string][2]int{}
var ModelRequestRateLimitMutex sync.RWMutex

// ModelRequestConcurrencyPerUser and ModelRequestConcurrencyGlobal bound
// in-flight model requests after authentication and before distribution.
var ModelRequestConcurrencyPerUser = 5
var ModelRequestConcurrencyGlobal = 32

var modelRequestConcurrencyOverrides = map[int]int{}
var modelRequestConcurrencyOverridesMutex sync.RWMutex

// Overrides apply to server-owned user IDs, including internal relay accounts.
// Multiple API keys belonging to one account still share the same limit.
func GetModelRequestConcurrencyForUser(userID int) int {
	modelRequestConcurrencyOverridesMutex.RLock()
	limit, exists := modelRequestConcurrencyOverrides[userID]
	modelRequestConcurrencyOverridesMutex.RUnlock()
	if exists {
		return limit
	}
	return ModelRequestConcurrencyPerUser
}

func parseModelRequestConcurrencyOverrides(value string) (map[int]int, error) {
	var configured map[string]int
	if err := common.UnmarshalJsonStr(value, &configured); err != nil || configured == nil || len(configured) > 1000 {
		return nil, fmt.Errorf("concurrency overrides must be a JSON object with at most 1000 user IDs")
	}
	limits := make(map[int]int, len(configured))
	for key, limit := range configured {
		userID, err := strconv.Atoi(key)
		if err != nil || userID < 1 || strconv.Itoa(userID) != key || limit < 1 || limit > 100000 {
			return nil, fmt.Errorf("concurrency overrides require positive user IDs and limits between 1 and 100000")
		}
		limits[userID] = limit
	}
	return limits, nil
}

func ValidateModelRequestConcurrencyOverrides(value string) error {
	_, err := parseModelRequestConcurrencyOverrides(value)
	return err
}

func UpdateModelRequestConcurrencyOverrides(value string) error {
	limits, err := parseModelRequestConcurrencyOverrides(value)
	if err != nil {
		return err
	}
	modelRequestConcurrencyOverridesMutex.Lock()
	modelRequestConcurrencyOverrides = limits
	modelRequestConcurrencyOverridesMutex.Unlock()
	return nil
}

func ModelRequestConcurrencyOverridesJSON() string {
	modelRequestConcurrencyOverridesMutex.RLock()
	defer modelRequestConcurrencyOverridesMutex.RUnlock()
	encoded, err := common.Marshal(modelRequestConcurrencyOverrides)
	if err != nil {
		return "{}"
	}
	return string(encoded)
}

func ValidateModelRequestConcurrencyPerUser(value string) error {
	return validatePositiveConcurrency(value, "per-user model concurrency")
}

func ValidateModelRequestConcurrencyGlobal(value string) error {
	return validatePositiveConcurrency(value, "global model concurrency")
}

func validatePositiveConcurrency(value, name string) error {
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed < 1 || parsed > 100000 {
		return fmt.Errorf("%s must be between 1 and 100000", name)
	}
	return nil
}

func ModelRequestRateLimitGroup2JSONString() string {
	ModelRequestRateLimitMutex.RLock()
	defer ModelRequestRateLimitMutex.RUnlock()

	jsonBytes, err := common.Marshal(ModelRequestRateLimitGroup)
	if err != nil {
		common.SysLog(common.LogText("error marshalling model ratio: %s", err.Error()))
	}
	return string(jsonBytes)
}

func UpdateModelRequestRateLimitGroupByJSONString(jsonStr string) error {
	ModelRequestRateLimitMutex.RLock()
	defer ModelRequestRateLimitMutex.RUnlock()

	ModelRequestRateLimitGroup = make(map[string][2]int)
	return common.Unmarshal([]byte(jsonStr), &ModelRequestRateLimitGroup)
}

func GetGroupRateLimit(group string) (totalCount, successCount int, found bool) {
	ModelRequestRateLimitMutex.RLock()
	defer ModelRequestRateLimitMutex.RUnlock()

	if ModelRequestRateLimitGroup == nil {
		return 0, 0, false
	}

	limits, found := ModelRequestRateLimitGroup[group]
	if !found {
		return 0, 0, false
	}
	return limits[0], limits[1], true
}

func CheckModelRequestRateLimitGroup(jsonStr string) error {
	checkModelRequestRateLimitGroup := make(map[string][2]int)
	err := common.Unmarshal([]byte(jsonStr), &checkModelRequestRateLimitGroup)
	if err != nil {
		return err
	}
	for group, limits := range checkModelRequestRateLimitGroup {
		if limits[0] < 0 || limits[1] < 1 {
			return fmt.Errorf("group %s has negative rate limit values: [%d, %d]", group, limits[0], limits[1])
		}
		if int64(limits[0]) > maxModelRequestRateLimitCount || int64(limits[1]) > maxModelRequestRateLimitCount {
			return fmt.Errorf("group %s [%d, %d] exceeds max rate limit %d", group, limits[0], limits[1], maxModelRequestRateLimitCount)
		}
	}

	return nil
}
