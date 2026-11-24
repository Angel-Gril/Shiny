package setting

import (
	"errors"
	"os"
)

func IsRUSiteProfile() bool {
	return os.Getenv("SHINY_SITE_PROFILE") == "ru"
}

func ValidateSiteProfile() error {
	profile := os.Getenv("SHINY_SITE_PROFILE")
	if profile != "" && profile != "ru" {
		return errors.New("SHINY_SITE_PROFILE must be unset or ru")
	}
	return nil
}

// These are missing-option defaults for an independent RU database. Existing
// operator choices, prices, merchants and credentials are never overwritten.
func RUProfileDefaults() map[string]string {
	return map[string]string{
		"GroupRatio":       `{"default":1}`,
		"GroupGroupRatio":  `{}`,
		"UserUsableGroups": `{"default":"Default group"}`,
		"group_ratio_setting.group_special_usable_group": `{}`,
		"AutoGroups":                         `["default"]`,
		"DefaultUseAutoGroup":                `false`,
		"RetryTimes":                         `0`,
		"QuotaForNewUser":                    `0`,
		"QuotaForInviter":                    `0`,
		"QuotaForInvitee":                    `0`,
		"QuotaRemindEnabled":                 `true`,
		"general_setting.quota_display_type": `USD`,
		"HeaderNavModules":                   `{"pricing":{"enabled":true,"requireAuth":false}}`,
	}
}

func RUConsoleDefaultLanguage() string {
	if IsRUSiteProfile() {
		return "ru"
	}
	return ""
}
