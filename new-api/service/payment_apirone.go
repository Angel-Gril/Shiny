package service

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting"
	"github.com/shopspring/decimal"
)

// Invoice callbacks have no documented provider signature. An unguessable
// per-order token limits unsolicited queries; authenticated queries still
// supply every payment fact used for crediting.
func HostedApironeCallbackToken(secret, tradeNo string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte("apirone-invoice\n" + tradeNo))
	return hex.EncodeToString(mac.Sum(nil))
}

func (client *HostedPaymentClient) apironeAPI(ctx context.Context, method, path string, body any, token string, result any) error {
	var raw []byte
	var err error
	if body != nil {
		raw, err = common.Marshal(body)
		if err != nil {
			return err
		}
	}
	headers := http.Header{}
	headers.Set("Content-Type", "application/json")
	if token != "" {
		headers.Set("Authorization", "Bearer "+token)
	}
	response, _, status, err := client.request(ctx, method, "https://apirone.com/api/v2"+path, raw, headers)
	if err != nil {
		return err
	}
	return hostedDecodeResponse(response, status, result)
}

func (client *HostedPaymentClient) apironeAccessToken(ctx context.Context) (string, error) {
	var result struct {
		Account string `json:"login"`
		Token   string `json:"access-token"`
	}
	if err := client.apironeAPI(ctx, http.MethodPost, "/auth/login", map[string]string{
		"login": client.Config.AccountID, "password": client.Config.APIKey,
	}, "", &result); err != nil {
		return "", err
	}
	if result.Account != client.Config.AccountID || result.Token == "" || len(result.Token) > 8192 || strings.ContainsAny(result.Token, "\r\n") {
		return "", errors.New("invalid Apirone account authorization")
	}
	// Do not persist either access or refresh tokens. A fresh short-lived token
	// avoids sending the account's transfer key in a logged query URL.
	return result.Token, nil
}

func (client *HostedPaymentClient) PrepareApironeQuote(ctx context.Context, order *model.HostedPayment) error {
	if client.Config.Environment != "live" || order.Currency != "USD" {
		return errors.New("Apirone production invoices require USD quoting")
	}
	var info struct {
		Currencies []struct {
			Code   string          `json:"abbr"`
			Factor decimal.Decimal `json:"units-factor"`
		} `json:"currencies"`
	}
	if err := client.apironeAPI(ctx, http.MethodOptions, "/accounts", nil, "", &info); err != nil {
		return err
	}
	factor := decimal.Zero
	for _, currency := range info.Currencies {
		if currency.Code == client.Config.PayCurrency {
			if !factor.IsZero() {
				return errors.New("ambiguous Apirone coin definition")
			}
			factor = currency.Factor
		}
	}
	if !factor.IsPositive() || factor.GreaterThan(decimal.NewFromInt(1)) || factor.LessThan(decimal.New(1, -18)) {
		return errors.New("unsupported Apirone coin units")
	}
	var rates map[string]decimal.Decimal
	if err := client.apironeAPI(ctx, http.MethodGet, "/ticker?currency="+url.QueryEscape(client.Config.PayCurrency)+"&fiat=usd", nil, "", &rates); err != nil {
		return err
	}
	rate := rates["usd"]
	amount, err := decimal.NewFromString(order.Amount)
	if err != nil || !amount.IsPositive() || !rate.IsPositive() || rate.GreaterThan(decimal.NewFromInt(1000000000)) {
		return errors.New("invalid Apirone USD exchange quote")
	}
	// Ceiling in minimal units without an intermediate float or rounded
	// division. USDT on BNB uses 18 places while USDT on TRON uses 6.
	units, remainder := amount.QuoRem(rate.Mul(factor), 0)
	if remainder.IsPositive() {
		units = units.Add(decimal.NewFromInt(1))
	}
	if !units.IsPositive() || len(units.String()) > 80 {
		return errors.New("Apirone coin amount outside supported range")
	}
	order.CoinCurrency, order.CoinAmount, order.CoinUSDRate = client.Config.PayCurrency, units.String(), rate.String()
	return nil
}

type hostedApironeInvoice struct {
	ID          string          `json:"invoice"`
	Account     string          `json:"account"`
	Currency    string          `json:"currency"`
	Amount      decimal.Decimal `json:"amount"`
	Status      string          `json:"status"`
	URL         string          `json:"invoice-url"`
	CallbackURL string          `json:"callback-url"`
	UserData    struct {
		Reference string `json:"reference_id"`
	} `json:"user-data"`
	History []struct {
		Hash   string          `json:"txid"`
		Amount decimal.Decimal `json:"amount"`
	} `json:"history"`
}

func (client *HostedPaymentClient) createApirone(ctx context.Context, order *model.HostedPayment, options HostedCheckoutOptions) (*HostedCheckout, error) {
	if client.Config.Environment != "live" || order.CoinAmount == "" || order.CoinCurrency != client.Config.PayCurrency {
		return nil, errors.New("Apirone requires a saved coin quote")
	}
	token, err := client.apironeAccessToken(ctx)
	if err != nil {
		return nil, err
	}
	var result hostedApironeInvoice
	body := map[string]any{
		"amount": order.CoinAmount, "currency": order.CoinCurrency, "lifetime": 3600,
		"callback-url": options.WebhookURL, "linkback": options.ReturnURL,
		"user-data": map[string]string{"title": "Shiny API credit", "merchant": "Shiny API", "price": order.Amount + " USD", "reference_id": order.TradeNo},
	}
	if err := client.apironeAPI(ctx, http.MethodPost, "/accounts/"+url.PathEscape(client.Config.AccountID)+"/invoices", body, token, &result); err != nil {
		return nil, err
	}
	expected, _ := decimal.NewFromString(order.CoinAmount)
	if !regexp.MustCompile(`^[A-Za-z0-9]{1,128}$`).MatchString(result.ID) || result.Account != client.Config.AccountID ||
		result.Currency != order.CoinCurrency || !result.Amount.Equal(expected) || result.CallbackURL != options.WebhookURL ||
		result.UserData.Reference != order.TradeNo || result.Status != "created" {
		return nil, errors.New("Apirone invoice does not match saved quote")
	}
	checkoutURL, err := setting.HostedCheckoutURL(result.URL, []string{"apirone.com"})
	if err != nil {
		return nil, err
	}
	u, _ := url.Parse(checkoutURL)
	if u.Path != "/invoice" || u.Query().Get("id") != result.ID {
		return nil, errors.New("invalid Apirone invoice checkout")
	}
	return &HostedCheckout{RemoteID: result.ID, URL: checkoutURL}, nil
}

func (client *HostedPaymentClient) verifyApirone(body []byte, headers http.Header) (*HostedPaymentEvent, error) {
	reference := headers.Get("X-Shiny-Apirone-Reference")
	token := headers.Get("X-Shiny-Apirone-Token")
	if client.Config.WebhookSecret == "" || !regexp.MustCompile(`^HP-[A-Za-z0-9]{24}$`).MatchString(reference) ||
		!hostedEqualSignature([]byte(HostedApironeCallbackToken(client.Config.WebhookSecret, reference)), []byte(token)) {
		return nil, errors.New("invalid Apirone callback token")
	}
	var event struct {
		Account string `json:"account"`
		ID      string `json:"invoice"`
		Status  string `json:"status"`
	}
	if common.Unmarshal(body, &event) != nil || event.Account != client.Config.AccountID ||
		!regexp.MustCompile(`^[A-Za-z0-9]{1,128}$`).MatchString(event.ID) {
		return nil, errors.New("invalid Apirone invoice notification")
	}
	if event.Status != "completed" {
		return nil, nil
	}
	return &HostedPaymentEvent{Reference: reference, RemoteID: event.ID, ExpectsPaid: true}, nil
}

func (client *HostedPaymentClient) queryApirone(ctx context.Context, order *model.HostedPayment, remoteID string) (*HostedPaymentResult, error) {
	if client.Config.Environment != "live" || !regexp.MustCompile(`^[A-Za-z0-9]{1,128}$`).MatchString(remoteID) ||
		order.CoinAmount == "" || order.CoinCurrency != client.Config.PayCurrency {
		return nil, errors.New("invalid Apirone invoice or coin quote")
	}
	token, err := client.apironeAccessToken(ctx)
	if err != nil {
		return nil, err
	}
	var result hostedApironeInvoice
	if err := client.apironeAPI(ctx, http.MethodGet, "/accounts/"+url.PathEscape(client.Config.AccountID)+"/invoices/"+url.PathEscape(remoteID), nil, token, &result); err != nil {
		return nil, err
	}
	callbackHash := sha256.Sum256([]byte(result.CallbackURL))
	expected, err := decimal.NewFromString(order.CoinAmount)
	if err != nil || !expected.IsPositive() || result.ID != remoteID || result.Account != client.Config.AccountID ||
		result.Currency != order.CoinCurrency || !result.Amount.Equal(expected) || result.UserData.Reference != order.TradeNo ||
		order.CallbackHash == "" || hex.EncodeToString(callbackHash[:]) != order.CallbackHash {
		return nil, errors.New("Apirone account, invoice or coin quote mismatch")
	}
	// History records individual receipts; ignore state-only entries and count
	// each blockchain transaction once. completed is the confirmation barrier,
	// while paid and overpaid alone can still be unconfirmed.
	received := decimal.Zero
	hashes := map[string]struct{}{}
	for _, row := range result.History {
		if row.Hash == "" || !row.Amount.IsPositive() {
			continue
		}
		if _, exists := hashes[row.Hash]; exists {
			continue
		}
		hashes[row.Hash] = struct{}{}
		received = received.Add(row.Amount)
	}
	return &HostedPaymentResult{Reference: order.TradeNo, RemoteID: result.ID, Amount: order.Amount, Currency: order.Currency,
		Paid: result.Status == "completed" && received.GreaterThanOrEqual(expected)}, nil
}
