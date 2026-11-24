package service

import (
	"bytes"
	"context"
	"errors"
	"mime/multipart"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strings"

	"github.com/Calcium-Ion/go-epay/epay"
	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting"
)

// ZPAY documents the Epay MD5 protocol at https://z-pay.cn/doc.html.
// The existing Epay SDK owns signing; this adapter adds authoritative queries.
type zPayPayment struct {
	Code       common.RawMessage `json:"code"`
	TradeNo    string            `json:"trade_no"`
	Reference  string            `json:"out_trade_no"`
	MerchantID common.RawMessage `json:"pid"`
	Money      string            `json:"money"`
	Status     common.RawMessage `json:"status"`
	Method     string            `json:"type"`
	PayURL     string            `json:"payurl"`
}

func (client *HostedPaymentClient) createZPay(ctx context.Context, order *model.HostedPayment, options HostedCheckoutOptions) (*HostedCheckout, error) {
	if client.Config.Environment != "live" || order.Currency != "CNY" || net.ParseIP(options.ClientIP) == nil {
		return nil, errors.New("invalid ZPAY environment, currency or client IP")
	}
	if order.TradeNo == "" || len(order.TradeNo) > 32 {
		return nil, errors.New("invalid ZPAY merchant order ID")
	}
	returnURL, err := url.Parse(options.ReturnURL)
	if err != nil {
		return nil, errors.New("invalid payment return URL")
	}
	returnURL.RawQuery = "" // ZPAY explicitly disallows query parameters here.
	sdk, err := epay.NewClient(&epay.Config{PartnerID: client.Config.MerchantID, Key: client.Config.APISecret}, "https://zpayz.cn")
	if err != nil {
		return nil, errors.New("invalid ZPAY merchant configuration")
	}
	params, err := sdk.SignParams(map[string]string{
		"type": client.Config.PaymentMethod, "out_trade_no": order.TradeNo, "money": order.Amount,
		"name": "Shiny API credit", "clientip": options.ClientIP, "notify_url": options.WebhookURL,
		"return_url": returnURL.String(), "device": "pc",
	})
	if err != nil {
		return nil, errors.New("could not sign ZPAY order")
	}
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	for key, value := range params {
		if err := form.WriteField(key, value); err != nil {
			return nil, errors.New("invalid ZPAY order form")
		}
	}
	if err := form.Close(); err != nil {
		return nil, errors.New("invalid ZPAY order form")
	}
	headers := http.Header{}
	headers.Set("Content-Type", form.FormDataContentType())
	raw, _, status, err := client.request(ctx, http.MethodPost, "https://zpayz.cn/mapi.php", body.Bytes(), headers)
	if err != nil {
		return nil, err
	}
	var payment zPayPayment
	if err := hostedDecodeResponse(raw, status, &payment); err != nil {
		return nil, err
	}
	if common.JsonRawMessageToString(payment.Code) != "1" || !regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`).MatchString(payment.TradeNo) {
		return nil, errors.New("ZPAY rejected checkout creation")
	}
	checkoutURL, err := setting.HostedCheckoutURL(payment.PayURL, client.Config.CheckoutHosts)
	if err != nil {
		return nil, err
	}
	return &HostedCheckout{RemoteID: payment.TradeNo, URL: checkoutURL}, nil
}

func (client *HostedPaymentClient) verifyZPay(body []byte) (*HostedPaymentEvent, error) {
	values, err := url.ParseQuery(string(body))
	if err != nil {
		return nil, errors.New("invalid ZPAY payment notification")
	}
	params := make(map[string]string, len(values))
	for key, value := range values {
		if len(value) != 1 {
			return nil, errors.New("duplicate ZPAY notification parameter")
		}
		params[key] = value[0]
	}
	if params["pid"] != client.Config.MerchantID || params["sign_type"] != "MD5" {
		return nil, errors.New("ZPAY merchant or signature type mismatch")
	}
	sdk, err := epay.NewClient(&epay.Config{PartnerID: client.Config.MerchantID, Key: client.Config.APISecret}, "https://zpayz.cn")
	if err != nil {
		return nil, errors.New("invalid ZPAY merchant configuration")
	}
	verified, err := sdk.Verify(params)
	if err != nil || !verified.VerifyStatus {
		return nil, errors.New("invalid payment signature")
	}
	if verified.TradeStatus != epay.StatusTradeSuccess {
		return nil, nil
	}
	if verified.ServiceTradeNo == "" || !regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`).MatchString(verified.TradeNo) ||
		!slices.Contains([]string{"alipay", "wxpay"}, verified.Type) || strings.TrimSpace(verified.Money) == "" {
		return nil, errors.New("invalid ZPAY payment notification")
	}
	return &HostedPaymentEvent{Reference: verified.ServiceTradeNo, RemoteID: verified.TradeNo, ExpectsPaid: true}, nil
}

func (client *HostedPaymentClient) queryZPay(ctx context.Context, order *model.HostedPayment, remoteID string) (*HostedPaymentResult, error) {
	// The documented query carries the merchant secret in the HTTPS URL. Never
	// log the endpoint, request object, response body or wrapped transport error.
	params := url.Values{"act": {"order"}, "pid": {client.Config.MerchantID}, "key": {client.Config.APISecret}, "out_trade_no": {order.TradeNo}}
	raw, _, status, err := client.request(ctx, http.MethodGet, "https://zpayz.cn/api.php?"+params.Encode(), nil, http.Header{})
	if err != nil {
		return nil, err
	}
	var payment zPayPayment
	if err := hostedDecodeResponse(raw, status, &payment); err != nil {
		return nil, err
	}
	if common.JsonRawMessageToString(payment.Code) != "1" || common.JsonRawMessageToString(payment.MerchantID) != client.Config.MerchantID ||
		payment.Reference != order.TradeNo || !regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`).MatchString(payment.TradeNo) ||
		(remoteID != "" && payment.TradeNo != remoteID) || !slices.Contains([]string{"alipay", "wxpay"}, payment.Method) {
		return nil, errors.New("ZPAY query does not match merchant order")
	}
	state := common.JsonRawMessageToString(payment.Status)
	if state != "0" && state != "1" {
		return nil, errors.New("invalid ZPAY payment status")
	}
	return &HostedPaymentResult{Reference: payment.Reference, RemoteID: payment.TradeNo, Amount: payment.Money,
		Currency: "CNY", Paid: state == "1"}, nil
}
