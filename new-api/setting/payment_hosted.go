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

// Distinct IDs keep managed wallet orders out of the legacy package and
// subscription handlers. Both legacy integrations retain their own settings.
const (
	HostedProviderCreem   = "creem_native"
	HostedProviderPancake = "waffo_pancake_native"
)

var HostedPaymentProviders = []string{"cispay", "lianlian", "nowpayments", "paypal", "zpay",
	HostedProviderCreem, HostedProviderPancake, "platega", "freekassa", "lava", "cryptocloud", "oxapay", "apirone"}

// Deployment selection controls new sales, not callbacks for already-created
// orders. An operator can drain a removed provider without losing its keys.
func SelectedHostedPaymentProviders() ([]string, error) {
	raw, exists := os.LookupEnv("PAYMENTS_PROVIDERS")
	if !exists {
		return slices.Clone(HostedPaymentProviders), nil
	}
	if strings.TrimSpace(raw) == "none" {
		return []string{}, nil
	}
	providers := []string{}
	for item := range strings.SplitSeq(raw, ",") {
		provider := strings.TrimSpace(item)
		if !slices.Contains(HostedPaymentProviders, provider) {
			return nil, errors.New("PAYMENTS_PROVIDERS contains an unsupported provider")
		}
		if !slices.Contains(providers, provider) {
			providers = append(providers, provider)
		}
	}
	return providers, nil
}

func HostedPaymentSelected(provider string) bool {
	providers, err := SelectedHostedPaymentProviders()
	return err == nil && slices.Contains(providers, provider)
}

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
	Enabled            bool     `json:"enabled"`
	AcceptNew          bool     `json:"accept_new"`
	Environment        string   `json:"environment"`
	Currency           string   `json:"currency"`
	UnitPrice          string   `json:"unit_price"`
	MinTopUp           int64    `json:"min_topup"`
	AccountID          string   `json:"account_id"`
	APIKey             string   `json:"api_key"`
	APISecret          string   `json:"api_secret"`
	WebhookSecret      string   `json:"webhook_secret"`
	SignatureType      string   `json:"signature_type"`
	PrivateKey         string   `json:"private_key"`
	PlatformPublicKey  string   `json:"platform_public_key"`
	StoreID            string   `json:"store_id"`
	UserID             string   `json:"user_id"`
	DeveloperUserID    string   `json:"developer_user_id"`
	OnBehalfOf         string   `json:"on_behalf_of"`
	CountryCode        string   `json:"country_code"`
	CheckoutHosts      []string `json:"checkout_hosts"`
	GoodsURL           string   `json:"goods_url"`
	ShippingProvider   string   `json:"shipping_provider"`
	PayCurrency        string   `json:"pay_currency"`
	PaymentMethod      string   `json:"payment_method"`
	ClientID           string   `json:"client_id"`
	ClientSecret       string   `json:"client_secret"`
	MerchantID         string   `json:"merchant_id"`
	WebhookID          string   `json:"webhook_id"`
	ProductID          string   `json:"product_id"`
	TaxCategory        string   `json:"tax_category"`
	APIVariant         string   `json:"api_variant"`
	SecretsConfigured  []string `json:"secrets_configured,omitempty"`
	DeploymentSelected *bool    `json:"deployment_selected,omitempty"`
}

type HostedPaymentSettings map[string]HostedPaymentConfig

func DefaultHostedPaymentConfig(provider string) HostedPaymentConfig {
	environment := "test"
	if slices.Contains([]string{"nowpayments", "cispay", "zpay", "platega", "freekassa", "lava", "cryptocloud", "apirone"}, provider) {
		environment = "live" // This adapter uses the documented production invoice API.
	}
	currency := "USD"
	if provider == "cispay" || provider == "platega" || provider == "freekassa" {
		currency = "RUB"
	} else if provider == "zpay" {
		currency = "CNY"
	}
	cfg := HostedPaymentConfig{
		Environment: environment, Currency: currency, UnitPrice: "1", MinTopUp: 1,
		SignatureType: "HMAC-SHA256", CheckoutHosts: []string{},
	}
	if provider == "zpay" {
		cfg.PaymentMethod, cfg.SignatureType = "alipay", "MD5"
	}
	if provider == HostedProviderPancake {
		cfg.TaxCategory, cfg.SignatureType = "saas", "RSA-SHA256"
	}
	if provider == "cryptocloud" {
		cfg.APIVariant = "trybit"
	}
	if provider == "apirone" {
		cfg.PayCurrency = "usdt@trx"
	}
	return cfg
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
	// Preserve pre-existing providers' hashes so pending orders remain valid.
	if slices.Contains([]string{HostedProviderCreem, HostedProviderPancake, "lava", "cryptocloud"}, provider) {
		identity += "\n" + cfg.ProductID + "\n" + cfg.APIVariant
	}
	if provider == "apirone" {
		// The per-order callback token and coin/network must remain valid while
		// pending invoices exist. The digest is never exposed to the browser.
		identity += "\n" + cfg.PayCurrency + "\n" + cfg.WebhookSecret
	}
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
	cfg.DeploymentSelected = nil
}

func (cfg HostedPaymentConfig) Public(provider string) HostedPaymentConfig {
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
	selected := HostedPaymentSelected(provider)
	cfg.DeploymentSelected = &selected
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
	for _, value := range []string{cfg.APIKey, cfg.APISecret, cfg.WebhookSecret, cfg.ClientID, cfg.ClientSecret} {
		if strings.ContainsAny(value, "\r\n") {
			return errors.New("payment credentials must not contain line breaks")
		}
	}
	switch provider {
	case "cispay":
		if !regexp.MustCompile(`^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$`).MatchString(cfg.StoreID) || !strings.HasPrefix(cfg.APIKey, "cis_sec_") || strings.ContainsAny(cfg.APIKey, "\r\n") {
			return errors.New("incomplete cisPay merchant configuration")
		}
		if !slices.Contains([]string{"RUB", "USD"}, cfg.Currency) {
			return errors.New("unsupported cisPay settlement currency")
		}
		if len(cfg.CheckoutHosts) == 0 {
			return errors.New("cisPay requires approved checkout hosts")
		}
		if cfg.PaymentMethod != "" && !slices.Contains([]string{"CARD", "SBP", "CRYPTO"}, cfg.PaymentMethod) {
			return errors.New("invalid cisPay payment method")
		}
		if (cfg.PaymentMethod == "CARD" || cfg.PaymentMethod == "SBP") && cfg.Currency != "RUB" {
			return errors.New("cisPay card and SBP require RUB")
		}
		if cfg.Environment == "test" && cfg.AcceptNew {
			return errors.New("cisPay sandbox creation is only available in its merchant dashboard")
		}
		for _, host := range cfg.CheckoutHosts {
			if !regexp.MustCompile(`^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$`).MatchString(host) {
				return errors.New("checkout hosts must be exact HTTPS host names")
			}
		}
	case "zpay":
		if cfg.Environment != "live" || cfg.Currency != "CNY" || cfg.MerchantID == "" || cfg.APISecret == "" || len(cfg.CheckoutHosts) == 0 ||
			!slices.Contains([]string{"alipay", "wxpay"}, cfg.PaymentMethod) {
			return errors.New("ZPAY requires a live CNY merchant, secret and payment method")
		}
		for _, host := range cfg.CheckoutHosts {
			if !regexp.MustCompile(`^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$`).MatchString(host) {
				return errors.New("checkout hosts must be exact HTTPS host names")
			}
		}
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
	case HostedProviderCreem:
		if cfg.AccountID == "" || cfg.APIKey == "" || cfg.WebhookSecret == "" ||
			!regexp.MustCompile(`^prod_[A-Za-z0-9]+$`).MatchString(cfg.ProductID) ||
			!slices.Contains([]string{"USD", "EUR", "GBP"}, cfg.Currency) {
			return errors.New("Creem requires an account reference, one-time product, API key and webhook secret")
		}
	case HostedProviderPancake:
		if !regexp.MustCompile(`^MER_[A-Za-z0-9]+$`).MatchString(cfg.MerchantID) ||
			!regexp.MustCompile(`^STO_[A-Za-z0-9]+$`).MatchString(cfg.StoreID) ||
			!regexp.MustCompile(`^PROD_[A-Za-z0-9]+$`).MatchString(cfg.ProductID) || cfg.PrivateKey == "" ||
			!slices.Contains([]string{"saas", "digital_goods", "software"}, cfg.TaxCategory) ||
			!slices.Contains([]string{"USD", "EUR", "GBP"}, cfg.Currency) {
			return errors.New("incomplete Waffo Pancake merchant or one-time product configuration")
		}
	case "platega":
		if cfg.Environment != "live" || cfg.APISecret == "" ||
			!regexp.MustCompile(`^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$`).MatchString(cfg.MerchantID) ||
			(cfg.PaymentMethod != "" && !slices.Contains([]string{"2", "3", "11", "12", "13", "14"}, cfg.PaymentMethod)) {
			return errors.New("Platega requires a live merchant and documented payment method")
		}
	case "freekassa":
		if cfg.Environment != "live" || cfg.APIKey == "" || cfg.WebhookSecret == "" ||
			!regexp.MustCompile(`^[1-9][0-9]{0,9}$`).MatchString(cfg.MerchantID) ||
			!regexp.MustCompile(`^[1-9][0-9]{0,5}$`).MatchString(cfg.PaymentMethod) || len(cfg.CheckoutHosts) == 0 {
			return errors.New("FreeKassa requires a live Shop ID, API key, Secret Word 2 and payment method ID")
		}
	case "lava":
		if cfg.Environment != "live" || cfg.AccountID == "" || cfg.APIKey == "" || cfg.WebhookSecret == "" ||
			len(cfg.WebhookSecret) > 80 || len(cfg.CheckoutHosts) == 0 ||
			!regexp.MustCompile(`^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$`).MatchString(cfg.ProductID) ||
			(cfg.PaymentMethod != "" && !regexp.MustCompile(`^[A-Z][A-Z0-9_]{1,39}$`).MatchString(cfg.PaymentMethod)) ||
			!slices.Contains([]string{"USD", "EUR", "RUB"}, cfg.Currency) {
			return errors.New("Lava.top requires a live account, custom-price offer, API key and webhook service key")
		}
	case "cryptocloud":
		if cfg.AccountID == "" || cfg.APIKey == "" || cfg.WebhookSecret == "" || cfg.Currency != "USD" ||
			!slices.Contains([]string{"trybit", "cryptocloud"}, cfg.APIVariant) || len(cfg.CheckoutHosts) == 0 ||
			(cfg.PayCurrency != "" && !regexp.MustCompile(`^[A-Z0-9_]{2,40}$`).MatchString(cfg.PayCurrency)) {
			return errors.New("CryptoCloud requires a USD project, API key, JWT secret and explicit API variant")
		}
	case "oxapay":
		if cfg.AccountID == "" || cfg.APIKey == "" || cfg.Currency != "USD" {
			return errors.New("OxaPay requires a USD account reference and Merchant API key")
		}
	case "apirone":
		if cfg.Environment != "live" || cfg.Currency != "USD" || len(cfg.APIKey) < 16 || len(cfg.WebhookSecret) < 32 ||
			!regexp.MustCompile(`^apr-[a-f0-9]{32}$`).MatchString(cfg.AccountID) ||
			!slices.Contains([]string{"btc", "ltc", "bch", "doge", "trx", "usdt@trx", "usdc@trx", "eth", "usdt@eth", "usdc@eth", "bnb", "usdt@bnb", "usdc@bnb", "gram", "usdt@ton"}, cfg.PayCurrency) {
			return errors.New("Apirone requires a live USD account, transfer key, callback secret and exact coin/network")
		}
	}
	for _, host := range cfg.CheckoutHosts {
		if !regexp.MustCompile(`^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$`).MatchString(host) {
			return errors.New("checkout hosts must be exact HTTPS host names")
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
