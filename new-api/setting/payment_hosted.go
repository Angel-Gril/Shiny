package setting

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/url"
	"os"
	"regexp"
	"slices"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/shopspring/decimal"
)

const HostedPaymentOption = "HostedPaymentConfig"

var HostedPaymentProviders = []string{"lianlian", "nowpayments", "paypal"}

// A process serves one financial environment. Sandbox payments must never
// credit a production instance's real wallet.
func HostedPaymentsEnvironment() string {
	if os.Getenv("PAYMENTS_ENVIRONMENT") == "test" {
		return "test"
	}
	return "live"
}

// Each instance persists its own merchant configuration in its existing options
// table. Secrets are never included in the general options response.
type HostedPaymentConfig struct {
	Enabled           bool     `json:"enabled"`
	AcceptNew         bool     `json:"accept_new"`
	Environment       string   `json:"environment"`
	Currency          string   `json:"currency"`
	UnitPrice         string   `json:"unit_price"`
	MinTopUp          int64    `json:"min_topup"`
	AccountID         string   `json:"account_id"`
	APIKey            string   `json:"api_key"`
	APISecret         string   `json:"api_secret"`
	WebhookSecret     string   `json:"webhook_secret"`
	SignatureType     string   `json:"signature_type"`
	PrivateKey        string   `json:"private_key"`
	PlatformPublicKey string   `json:"platform_public_key"`
	StoreID           string   `json:"store_id"`
	UserID            string   `json:"user_id"`
	DeveloperUserID   string   `json:"developer_user_id"`
	OnBehalfOf        string   `json:"on_behalf_of"`
	CountryCode       string   `json:"country_code"`
	CheckoutHosts     []string `json:"checkout_hosts"`
	GoodsURL          string   `json:"goods_url"`
	ShippingProvider  string   `json:"shipping_provider"`
	PayCurrency       string   `json:"pay_currency"`
	ClientID          string   `json:"client_id"`
	ClientSecret      string   `json:"client_secret"`
	MerchantID        string   `json:"merchant_id"`
	WebhookID         string   `json:"webhook_id"`
	SecretsConfigured []string `json:"secrets_configured,omitempty"`
}

type HostedPaymentSettings map[string]HostedPaymentConfig

func DefaultHostedPaymentConfig(provider string) HostedPaymentConfig {
	environment := "test"
	if provider == "nowpayments" {
		environment = "live" // This adapter uses the documented production invoice API.
	}
	return HostedPaymentConfig{
		Environment: environment, Currency: "USD", UnitPrice: "1", MinTopUp: 1,
		SignatureType: "HMAC-SHA256", CheckoutHosts: []string{},
	}
}

func GetHostedPaymentSettings() (HostedPaymentSettings, error) {
	common.OptionMapRWMutex.RLock()
	raw := common.OptionMap[HostedPaymentOption]
	common.OptionMapRWMutex.RUnlock()
	settings := HostedPaymentSettings{}
	if raw != "" {
		if err := common.UnmarshalJsonStr(raw, &settings); err != nil {
			return nil, errors.New("invalid hosted payment configuration")
		}
	}
	for _, provider := range HostedPaymentProviders {
		if _, ok := settings[provider]; !ok {
			settings[provider] = DefaultHostedPaymentConfig(provider)
		}
	}
	return settings, nil
}

func (cfg HostedPaymentConfig) Identity(provider string) string {
	identity := strings.Join([]string{provider, cfg.Environment, cfg.AccountID,
		cfg.StoreID, cfg.UserID, cfg.DeveloperUserID, cfg.OnBehalfOf,
		cfg.MerchantID, cfg.WebhookID}, "\n")
	sum := sha256.Sum256([]byte(identity))
	return hex.EncodeToString(sum[:])
}

// Blank secret inputs preserve saved values; disabling new sales uses AcceptNew.
func (cfg *HostedPaymentConfig) MergeSecrets(saved HostedPaymentConfig) {
	current := []*string{&cfg.APIKey, &cfg.APISecret, &cfg.WebhookSecret, &cfg.PrivateKey, &cfg.ClientID, &cfg.ClientSecret}
	previous := []string{saved.APIKey, saved.APISecret, saved.WebhookSecret, saved.PrivateKey, saved.ClientID, saved.ClientSecret}
	for i, field := range current {
		if strings.TrimSpace(*field) == "" {
			*field = previous[i]
		}
	}
	cfg.SecretsConfigured = nil
}

func (cfg HostedPaymentConfig) Public() HostedPaymentConfig {
	fields := map[string]*string{"api_key": &cfg.APIKey, "api_secret": &cfg.APISecret,
		"webhook_secret": &cfg.WebhookSecret, "private_key": &cfg.PrivateKey,
		"client_id": &cfg.ClientID, "client_secret": &cfg.ClientSecret}
	cfg.SecretsConfigured = []string{}
	for key, value := range fields {
		if *value != "" {
			cfg.SecretsConfigured = append(cfg.SecretsConfigured, key)
		}
		*value = ""
	}
	slices.Sort(cfg.SecretsConfigured)
	return cfg
}

func (cfg HostedPaymentConfig) Validate(provider string) error {
	if !slices.Contains(HostedPaymentProviders, provider) {
		return errors.New("unsupported payment provider")
	}
	if !cfg.Enabled {
		return nil
	}
	rate, err := decimal.NewFromString(cfg.UnitPrice)
	if err != nil || !rate.IsPositive() || rate.GreaterThan(decimal.NewFromInt(1000000)) || cfg.MinTopUp < 1 {
		return errors.New("invalid payment price or minimum top-up")
	}
	if !slices.Contains([]string{"USD", "EUR", "CNY", "RUB", "GBP"}, cfg.Currency) {
		return errors.New("unsupported settlement currency")
	}
	if cfg.Environment != "test" && cfg.Environment != "live" {
		return errors.New("invalid payment environment")
	}
	switch provider {
	case "lianlian":
		if cfg.APIKey == "" || cfg.StoreID == "" || cfg.UserID == "" || cfg.DeveloperUserID == "" ||
			!regexp.MustCompile(`^[A-Z]{2}$`).MatchString(cfg.CountryCode) || len(cfg.CheckoutHosts) == 0 || cfg.ShippingProvider == "" {
			return errors.New("incomplete LianLian merchant configuration")
		}
		if _, err := HostedCheckoutURL(cfg.GoodsURL, nil); err != nil {
			return errors.New("invalid LianLian product URL")
		}
		for _, host := range cfg.CheckoutHosts {
			if !regexp.MustCompile(`^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$`).MatchString(host) {
				return errors.New("checkout hosts must be exact HTTPS host names")
			}
		}
		if cfg.SignatureType == "HMAC-SHA256" {
			if cfg.APISecret == "" || cfg.WebhookSecret == "" {
				return errors.New("missing LianLian signing secrets")
			}
		} else if cfg.SignatureType != "RSA" || cfg.PrivateKey == "" || cfg.PlatformPublicKey == "" {
			return errors.New("invalid LianLian signature configuration")
		}
	case "nowpayments":
		if cfg.Environment != "live" || cfg.Currency != "USD" || cfg.AccountID == "" || cfg.APIKey == "" || cfg.WebhookSecret == "" {
			return errors.New("NOWPayments requires a live USD account, API key and IPN secret")
		}
		if cfg.PayCurrency != "" && !regexp.MustCompile(`^[a-z0-9]{2,40}$`).MatchString(cfg.PayCurrency) {
			return errors.New("use a provider currency/network code")
		}
	case "paypal":
		if cfg.ClientID == "" || cfg.ClientSecret == "" || cfg.MerchantID == "" || cfg.WebhookID == "" {
			return errors.New("incomplete PayPal merchant configuration")
		}
		if !slices.Contains([]string{"USD", "EUR", "GBP"}, cfg.Currency) {
			return errors.New("unsupported PayPal settlement currency")
		}
	}
	return nil
}

func HostedCheckoutURL(raw string, hosts []string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.Port() != "" || u.Fragment != "" {
		return "", errors.New("invalid hosted checkout URL")
	}
	if hosts != nil && !slices.Contains(hosts, strings.ToLower(u.Hostname())) {
		return "", errors.New("unapproved checkout host")
	}
	return u.String(), nil
}
