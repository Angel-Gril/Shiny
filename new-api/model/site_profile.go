package model

import (
	"github.com/QuantumNous/new-api/setting"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"maps"
	"slices"
)

func InitializeRUProfileOptions() error {
	if !setting.IsRUSiteProfile() {
		return nil
	}
	err := DB.Transaction(func(tx *gorm.DB) error {
		defaults := setting.RUProfileDefaults()
		for _, key := range slices.Sorted(maps.Keys(defaults)) {
			// The legacy editor keys and registered configuration refer to the
			// same pricing maps. Respect a saved value in either representation.
			aliases := map[string]string{
				"GroupRatio":                         "group_ratio_setting.group_ratio",
				"GroupGroupRatio":                    "group_ratio_setting.group_group_ratio",
				"general_setting.quota_display_type": "DisplayInCurrencyEnabled",
			}
			if alias, exists := aliases[key]; exists {
				var count int64
				if err := tx.Model(&Option{}).Where(commonKeyCol+" IN ?", []string{key, alias}).Count(&count).Error; err != nil {
					return err
				}
				if count > 0 {
					continue
				}
			}
			row := Option{Key: key, Value: defaults[key]}
			if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&row).Error; err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	return LoadOptionsFromDatabase()
}
