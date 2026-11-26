package common

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"strings"
)

const storedSecretPrefix = "enc:v1:"

var ErrPersistentSecretKeyUnavailable = errors.New("a stable SESSION_SECRET or CRYPTO_SECRET is required to store credentials")
var ErrStoredSecretInvalid = errors.New("stored credential cannot be decrypted")

func EncryptStoredSecret(plaintext string) (string, error) {
	if !PersistentCryptoSecretAvailable() {
		return "", ErrPersistentSecretKeyUnavailable
	}
	block, err := aes.NewCipher(storedSecretEncryptionKey())
	if err != nil {
		return "", fmt.Errorf("initialize stored-secret encryption: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("initialize stored-secret encryption: %w", err)
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", fmt.Errorf("generate stored-secret nonce: %w", err)
	}
	ciphertext := aead.Seal(nonce, nonce, []byte(plaintext), []byte("new-api:option-secret:v1"))
	return storedSecretPrefix + base64.RawStdEncoding.EncodeToString(ciphertext), nil
}

func DecryptStoredSecret(value string) (string, error) {
	if !PersistentCryptoSecretAvailable() {
		return "", ErrPersistentSecretKeyUnavailable
	}
	encoded, ok := strings.CutPrefix(value, storedSecretPrefix)
	if !ok {
		return "", ErrStoredSecretInvalid
	}
	ciphertext, err := base64.RawStdEncoding.DecodeString(encoded)
	if err != nil {
		return "", ErrStoredSecretInvalid
	}
	block, err := aes.NewCipher(storedSecretEncryptionKey())
	if err != nil {
		return "", ErrStoredSecretInvalid
	}
	aead, err := cipher.NewGCM(block)
	if err != nil || len(ciphertext) < aead.NonceSize() {
		return "", ErrStoredSecretInvalid
	}
	nonce, ciphertext := ciphertext[:aead.NonceSize()], ciphertext[aead.NonceSize():]
	plaintext, err := aead.Open(nil, nonce, ciphertext, []byte("new-api:option-secret:v1"))
	if err != nil {
		return "", ErrStoredSecretInvalid
	}
	return string(plaintext), nil
}

func PersistentCryptoSecretAvailable() bool {
	return PersistentCryptoSecretConfigured && len(CryptoSecret) >= 32
}

func storedSecretEncryptionKey() []byte {
	mac := hmac.New(sha256.New, []byte(CryptoSecret))
	_, _ = mac.Write([]byte("new-api:option-secret-encryption:v1"))
	return mac.Sum(nil)
}

// ValidateOutboundCredentialEndpoint limits requests that attach a provider
// credential to HTTPS, except for an explicitly local loopback service.
func ValidateOutboundCredentialEndpoint(raw string) error {
	endpoint, err := url.ParseRequestURI(strings.TrimSpace(raw))
	if err != nil || endpoint.Host == "" || endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" {
		return errors.New("invalid credential-bearing endpoint")
	}
	if endpoint.Scheme == "https" {
		return nil
	}
	if endpoint.Scheme == "http" {
		host := strings.TrimSuffix(strings.ToLower(endpoint.Hostname()), ".")
		if host == "localhost" {
			return nil
		}
		if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
			return nil
		}
	}
	return errors.New("credential-bearing endpoints must use HTTPS; HTTP is allowed only for loopback")
}
