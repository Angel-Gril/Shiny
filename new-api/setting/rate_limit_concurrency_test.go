package setting

import "testing"

func TestValidateModelRequestConcurrency(t *testing.T) {
	if err := ValidateModelRequestConcurrencyPerUser("5"); err != nil {
		t.Fatalf("expected valid per-user concurrency: %v", err)
	}
	if err := ValidateModelRequestConcurrencyGlobal("32"); err != nil {
		t.Fatalf("expected valid global concurrency: %v", err)
	}
	for _, value := range []string{"0", "-1", "100001", "not-a-number"} {
		if err := ValidateModelRequestConcurrencyPerUser(value); err == nil {
			t.Fatalf("expected invalid concurrency %q", value)
		}
	}
}

func TestModelRequestConcurrencyOverridesRejectInvalidAccountsAndPreserveDefaults(t *testing.T) {
	previous := ModelRequestConcurrencyOverridesJSON()
	t.Cleanup(func() { _ = UpdateModelRequestConcurrencyOverrides(previous) })
	for _, value := range []string{`null`, `[]`, `{"0":2}`, `{"01":2}`, `{"1":0}`, `{"1":100001}`, `{"1":1.5}`, `{"key":2}`} {
		if err := ValidateModelRequestConcurrencyOverrides(value); err == nil {
			t.Fatalf("expected invalid override %s", value)
		}
	}
	if err := UpdateModelRequestConcurrencyOverrides(`{"42":20}`); err != nil {
		t.Fatal(err)
	}
	if GetModelRequestConcurrencyForUser(42) != 20 || GetModelRequestConcurrencyForUser(43) != ModelRequestConcurrencyPerUser {
		t.Fatal("an internal account override must not change ordinary accounts")
	}
	if err := UpdateModelRequestConcurrencyOverrides(`{"42":0}`); err == nil || GetModelRequestConcurrencyForUser(42) != 20 {
		t.Fatal("invalid updates must preserve the previous limit")
	}
}
