package setting

import (
	_ "embed"
	"strings"

	"github.com/QuantumNous/new-api/common"
)

//go:embed ru_metadata.json
var russianMetadataJSON []byte

var russianMetadata = func() struct {
	Models  map[string]string `json:"models"`
	Vendors map[string]string `json:"vendors"`
	Tags    map[string]string `json:"tags"`
} {
	var catalog struct {
		Models  map[string]string `json:"models"`
		Vendors map[string]string `json:"vendors"`
		Tags    map[string]string `json:"tags"`
	}
	if err := common.Unmarshal(russianMetadataJSON, &catalog); err != nil {
		panic("invalid bundled Russian model metadata: " + err.Error())
	}
	return catalog
}()

// RussianModelMetadata localizes presentation only. Unknown models keep the
// English upstream description, and custom tags remain intact. No capability,
// visibility, vendor ownership, routing or pricing fields are inferred.
func RussianModelMetadata(modelName, description, tags string) (string, string) {
	if translated, ok := russianMetadata.Models[modelName]; ok {
		description = translated
	}
	localized := make([]string, 0)
	seen := make(map[string]bool)
	for raw := range strings.SplitSeq(tags, ",") {
		tag := strings.TrimSpace(raw)
		if tag == "" {
			continue
		}
		if translated, ok := russianMetadata.Tags[tag]; ok {
			tag = translated
		}
		if !seen[tag] {
			seen[tag] = true
			localized = append(localized, tag)
		}
	}
	return description, strings.Join(localized, ",")
}

func RussianVendorDescription(name, description string) string {
	if translated, ok := russianMetadata.Vendors[name]; ok {
		return translated
	}
	return description
}
