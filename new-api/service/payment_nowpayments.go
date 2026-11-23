package service

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha512"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting"
	"github.com/shopspring/decimal"
)

type nowPayment struct {
	ID            common.RawMessage `json:"id"`
	PaymentID     common.RawMessage `json:"payment_id"`
	InvoiceID     common.RawMessage `json:"invoice_id"`
	OrderID       string            `json:"order_id"`
	InvoiceURL    string            `json:"invoice_url"`
	PriceAmount   common.RawMessage `json:"price_amount"`
	PriceCurrency string            `json:"price_currency"`
	Status        string            `json:"payment_status"`
	PayAmount     common.RawMessage `json:"pay_amount"`
	ActuallyPaid  common.RawMessage `json:"actually_paid"`
}

func (client *HostedPaymentClient) nowPaymentsAPI(ctx context.Context, path string, body any, result any) error {
	var raw []byte
	method := http.MethodGet
	if body != nil {
		var err error
		raw, err = common.Marshal(body)
		if err != nil {
			return err
		}
		method = http.MethodPost
	}
	headers := http.Header{}
	headers.Set("x-api-key", client.Config.APIKey)
	headers.Set("Content-Type", "application/json")
	response, _, status, err := client.request(ctx, method, "https://api.nowpayments.io/v1"+path, raw, headers)
	if err != nil {
		return err
	}
	return hostedDecodeResponse(response, status, result)
}

func (client *HostedPaymentClient) createNOWPayments(ctx context.Context, order *model.HostedPayment, returnURL, webhookURL string) (*HostedCheckout, error) {
	amount, err := decimal.NewFromString(order.Amount)
	if err != nil {
		return nil, err
	}
	body := map[string]any{
		"price_amount": amount.InexactFloat64(), "price_currency": "usd",
		"order_id": order.TradeNo, "order_description": "Shiny API credit",
		"ipn_callback_url": webhookURL, "success_url": returnURL, "cancel_url": returnURL,
		"partially_paid_url": returnURL, "is_fixed_rate": true, "is_fee_paid_by_user": false,
	}
	if client.Config.PayCurrency != "" {
		body["pay_currency"] = client.Config.PayCurrency
	}
	var result nowPayment
	if err := client.nowPaymentsAPI(ctx, "/invoice", body, &result); err != nil {
		return nil, err
	}
	id := common.JsonRawMessageToString(result.ID)
	price, parseErr := decimal.NewFromString(common.JsonRawMessageToString(result.PriceAmount))
	if !regexp.MustCompile(`^\d{1,30}$`).MatchString(id) || result.OrderID != order.TradeNo || parseErr != nil ||
		!price.Equal(amount) || strings.ToUpper(result.PriceCurrency) != order.Currency {
		return nil, errors.New("NOWPayments invoice does not match order")
	}
	checkoutURL, err := setting.HostedCheckoutURL(result.InvoiceURL, []string{"nowpayments.io"})
	if err != nil {
		return nil, err
	}
	return &HostedCheckout{RemoteID: id, URL: checkoutURL}, nil
}

// Match JSON.stringify of recursively alphabetized keys, as documented for IPN.
func nowPaymentsCanonicalJSON(raw []byte) ([]byte, error) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return nil, errors.New("empty IPN payload")
	}
	switch raw[0] {
	case '{':
		var fields map[string]common.RawMessage
		if err := common.Unmarshal(raw, &fields); err != nil {
			return nil, err
		}
		keys := make([]string, 0, len(fields))
		for key := range fields {
			keys = append(keys, key)
		}
		slices.Sort(keys)
		var result bytes.Buffer
		result.WriteByte('{')
		for i, key := range keys {
			if i > 0 {
				result.WriteByte(',')
			}
			name := nowPaymentsJSONString(key)
			value, err := nowPaymentsCanonicalJSON(fields[key])
			if err != nil {
				return nil, err
			}
			result.Write(name)
			result.WriteByte(':')
			result.Write(value)
		}
		result.WriteByte('}')
		return result.Bytes(), nil
	case '[':
		var elements []common.RawMessage
		if err := common.Unmarshal(raw, &elements); err != nil {
			return nil, err
		}
		parts := make([][]byte, len(elements))
		for i, element := range elements {
			value, err := nowPaymentsCanonicalJSON(element)
			if err != nil {
				return nil, err
			}
			parts[i] = value
		}
		return append(append([]byte{'['}, bytes.Join(parts, []byte{','})...), ']'), nil
	default:
		var value any
		if err := common.Unmarshal(raw, &value); err != nil {
			return nil, err
		}
		if number, ok := value.(float64); ok {
			if number == 0 {
				return []byte("0"), nil
			}
			if number > -1e21 && number < 1e21 && (number >= 1e-6 || number <= -1e-6) {
				return []byte(strconv.FormatFloat(number, 'f', -1, 64)), nil
			}
			text := strconv.FormatFloat(number, 'e', -1, 64)
			text = strings.ReplaceAll(strings.ReplaceAll(text, "e-0", "e-"), "e+0", "e+")
			return []byte(text), nil
		}
		if text, ok := value.(string); ok {
			return nowPaymentsJSONString(text), nil
		}
		return common.Marshal(value)
	}
}

// JSON.stringify leaves HTML characters and U+2028/U+2029 literal. The host
// encoder escapes them, so signed strings need the provider's JSON spelling.
func nowPaymentsJSONString(value string) []byte {
	var result bytes.Buffer
	result.WriteByte('"')
	for _, character := range value {
		switch character {
		case '"', '\\':
			result.WriteByte('\\')
			result.WriteRune(character)
		case '\b':
			result.WriteString(`\b`)
		case '\f':
			result.WriteString(`\f`)
		case '\n':
			result.WriteString(`\n`)
		case '\r':
			result.WriteString(`\r`)
		case '\t':
			result.WriteString(`\t`)
		default:
			if character < 0x20 {
				fmt.Fprintf(&result, `\u%04x`, character)
			} else {
				result.WriteRune(character)
			}
		}
	}
	result.WriteByte('"')
	return result.Bytes()
}

func (client *HostedPaymentClient) verifyNOWPayments(body []byte, headers http.Header) (*HostedPaymentEvent, error) {
	canonical, err := nowPaymentsCanonicalJSON(body)
	if err != nil {
		return nil, errors.New("invalid payment notification")
	}
	mac := hmac.New(sha512.New, []byte(client.Config.WebhookSecret))
	mac.Write(canonical)
	signature, err := hex.DecodeString(headers.Get("x-nowpayments-sig"))
	if err != nil || !hostedEqualSignature(mac.Sum(nil), signature) {
		return nil, errors.New("invalid payment signature")
	}
	var data nowPayment
	if err := common.Unmarshal(body, &data); err != nil {
		return nil, errors.New("invalid payment notification")
	}
	paymentID := common.JsonRawMessageToString(data.PaymentID)
	if !regexp.MustCompile(`^\d{1,30}$`).MatchString(paymentID) {
		return nil, errors.New("invalid payment ID")
	}
	return &HostedPaymentEvent{Reference: data.OrderID, PaymentID: paymentID}, nil
}

func (client *HostedPaymentClient) queryNOWPayments(ctx context.Context, paymentID string) (*HostedPaymentResult, error) {
	if !regexp.MustCompile(`^\d{1,30}$`).MatchString(paymentID) {
		return nil, errors.New("payment ID required; invoice ID is not a payment ID")
	}
	var result nowPayment
	if err := client.nowPaymentsAPI(ctx, "/payment/"+paymentID, nil, &result); err != nil {
		return nil, err
	}
	if common.JsonRawMessageToString(result.PaymentID) != paymentID {
		return nil, errors.New("payment identity mismatch")
	}
	payAmount, payErr := decimal.NewFromString(common.JsonRawMessageToString(result.PayAmount))
	actuallyPaid, actualErr := decimal.NewFromString(common.JsonRawMessageToString(result.ActuallyPaid))
	return &HostedPaymentResult{
		Reference: result.OrderID, RemoteID: common.JsonRawMessageToString(result.InvoiceID), PaymentID: paymentID,
		Amount: common.JsonRawMessageToString(result.PriceAmount), Currency: strings.ToUpper(result.PriceCurrency),
		Paid: result.Status == "finished" && payErr == nil && actualErr == nil && payAmount.IsPositive() && actuallyPaid.GreaterThanOrEqual(payAmount),
	}, nil
}
