package service

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/md5"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting"
	"github.com/shopspring/decimal"
)

func (client *HostedPaymentClient) freeKassaAPI(ctx context.Context, path string, fields map[string]string, result any) error {
	// Sign the same numeric representation the receiver decodes from JSON.
	// A string "10.50" cannot be signed then emitted as the number 10.5.
	if value, exists := fields["amount"]; exists {
		amount, err := decimal.NewFromString(value)
		if err != nil || !amount.IsPositive() {
			return errors.New("invalid FreeKassa amount")
		}
		fields["amount"] = amount.String()
	}
	// Serialize this merchant's requests across processes as well as goroutines.
	identity := sha256.Sum256([]byte("freekassa\n" + client.Config.MerchantID))
	return model.WithHostedPaymentNonce(ctx, hex.EncodeToString(identity[:]), func(nonce int64) error {
		fields["shopId"], fields["nonce"] = client.Config.MerchantID, strconv.FormatInt(nonce, 10)
		keys := make([]string, 0, len(fields))
		for key := range fields {
			keys = append(keys, key)
		}
		slices.Sort(keys)
		values := make([]string, 0, len(keys))
		body := map[string]any{}
		for _, key := range keys {
			value := fields[key]
			values = append(values, value)
			if slices.Contains([]string{"shopId", "nonce", "i", "orderId", "amount"}, key) {
				body[key] = common.RawMessage(value)
			} else {
				body[key] = value
			}
		}
		mac := hmac.New(sha256.New, []byte(client.Config.APIKey))
		mac.Write([]byte(strings.Join(values, "|")))
		body["signature"] = hex.EncodeToString(mac.Sum(nil))
		raw, err := common.Marshal(body)
		if err != nil {
			return err
		}
		headers := http.Header{}
		headers.Set("Content-Type", "application/json")
		response, _, status, err := client.request(ctx, http.MethodPost, "https://api.fk.life/v1"+path, raw, headers)
		if err != nil {
			return err
		}
		return hostedDecodeResponse(response, status, result)
	})
}

func (client *HostedPaymentClient) createFreeKassa(ctx context.Context, order *model.HostedPayment, options HostedCheckoutOptions) (*HostedCheckout, error) {
	if client.Config.Environment != "live" || options.CustomerEmail == "" || net.ParseIP(options.ClientIP) == nil {
		return nil, errors.New("FreeKassa requires a live merchant, buyer email and IP address")
	}
	var result struct {
		Type string `json:"type"`
		ID   int64  `json:"orderId"`
		URL  string `json:"location"`
	}
	if err := client.freeKassaAPI(ctx, "/orders/create", map[string]string{
		"paymentId": order.TradeNo, "i": client.Config.PaymentMethod, "email": options.CustomerEmail,
		"ip": options.ClientIP, "amount": order.Amount, "currency": order.Currency,
	}, &result); err != nil {
		return nil, err
	}
	// Return and notification URLs are set in the merchant dashboard; FreeKassa
	// permits per-request overrides only after its support enables the feature.
	if result.Type != "success" || result.ID <= 0 {
		return nil, errors.New("invalid FreeKassa invoice")
	}
	checkoutURL, err := setting.HostedCheckoutURL(result.URL, client.Config.CheckoutHosts)
	if err != nil {
		return nil, err
	}
	return &HostedCheckout{RemoteID: strconv.FormatInt(result.ID, 10), URL: checkoutURL}, nil
}

// FreeKassa's SCI callback is distinct from its REST HMAC authentication.
// Only bounded text fields are accepted; duplicate keys cannot override values.
func hostedPaymentForm(body []byte, headers http.Header) (url.Values, error) {
	mediaType, parameters, err := mime.ParseMediaType(headers.Get("Content-Type"))
	if err != nil {
		return nil, errors.New("invalid payment form content type")
	}
	var values url.Values
	switch mediaType {
	case "application/x-www-form-urlencoded":
		values, err = url.ParseQuery(string(body))
	case "multipart/form-data":
		if parameters["boundary"] == "" {
			return nil, errors.New("missing payment form boundary")
		}
		values = url.Values{}
		reader := multipart.NewReader(bytes.NewReader(body), parameters["boundary"])
		for {
			part, readErr := reader.NextPart()
			if readErr == io.EOF {
				break
			}
			if readErr != nil || part.FormName() == "" || part.FileName() != "" {
				return nil, errors.New("invalid payment form")
			}
			value, readErr := io.ReadAll(io.LimitReader(part, 8193))
			part.Close()
			if readErr != nil || len(value) > 8192 || len(values) >= 64 {
				return nil, errors.New("payment form too large")
			}
			values.Add(part.FormName(), string(value))
		}
	default:
		return nil, errors.New("unsupported payment form content type")
	}
	if err != nil || len(values) > 64 {
		return nil, errors.New("invalid payment form")
	}
	for _, entries := range values {
		if len(entries) != 1 {
			return nil, errors.New("duplicate payment form field")
		}
	}
	return values, nil
}

func (client *HostedPaymentClient) verifyFreeKassa(body []byte, headers http.Header) (*HostedPaymentEvent, error) {
	values, err := hostedPaymentForm(body, headers)
	if err != nil {
		return nil, err
	}
	merchant, reference := values.Get("MERCHANT_ID"), values.Get("MERCHANT_ORDER_ID")
	amount := values.Get("AMOUNT")
	if client.Config.WebhookSecret == "" || merchant != client.Config.MerchantID || reference == "" {
		return nil, errors.New("FreeKassa merchant or order mismatch")
	}
	digest := md5.Sum([]byte(merchant + ":" + amount + ":" + client.Config.WebhookSecret + ":" + reference))
	signature, err := hex.DecodeString(values.Get("SIGN"))
	if err != nil || !hostedEqualSignature(digest[:], signature) {
		return nil, errors.New("invalid payment signature")
	}
	id, err := strconv.ParseInt(values.Get("intid"), 10, 64)
	if err != nil || id <= 0 {
		return nil, errors.New("invalid FreeKassa order ID")
	}
	return &HostedPaymentEvent{Reference: reference, RemoteID: strconv.FormatInt(id, 10), ExpectsPaid: true}, nil
}

func (client *HostedPaymentClient) queryFreeKassa(ctx context.Context, order *model.HostedPayment, remoteID string) (*HostedPaymentResult, error) {
	if client.Config.Environment != "live" {
		return nil, errors.New("FreeKassa does not document a sandbox API")
	}
	if remoteID != "" {
		id, err := strconv.ParseInt(remoteID, 10, 64)
		if err != nil || id <= 0 {
			return nil, errors.New("invalid FreeKassa order ID")
		}
	}
	var result struct {
		Type   string `json:"type"`
		Orders []struct {
			Reference string          `json:"merchant_order_id"`
			ID        int64           `json:"fk_order_id"`
			Amount    decimal.Decimal `json:"amount"`
			Currency  string          `json:"currency"`
			Status    int             `json:"status"`
		} `json:"orders"`
	}
	if err := client.freeKassaAPI(ctx, "/orders", map[string]string{"paymentId": order.TradeNo}, &result); err != nil {
		return nil, err
	}
	if result.Type != "success" || len(result.Orders) != 1 {
		return nil, errors.New("FreeKassa order not found or ambiguous")
	}
	row := result.Orders[0]
	id := strconv.FormatInt(row.ID, 10)
	if row.ID <= 0 || row.Reference != order.TradeNo || (remoteID != "" && id != remoteID) {
		return nil, errors.New("FreeKassa order mismatch")
	}
	return &HostedPaymentResult{Reference: row.Reference, RemoteID: id, Amount: row.Amount.String(), Currency: row.Currency, Paid: row.Status == 1}, nil
}
