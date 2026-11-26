package common

import (
	"errors"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestStoredSecretEncryptionRequiresStableServerSecret(t *testing.T) {
	previousSecret, previousConfigured := CryptoSecret, PersistentCryptoSecretConfigured
	t.Cleanup(func() { CryptoSecret, PersistentCryptoSecretConfigured = previousSecret, previousConfigured })
	CryptoSecret = "ephemeral-test-secret"
	PersistentCryptoSecretConfigured = false
	_, err := EncryptStoredSecret("api-key")
	require.ErrorIs(t, err, ErrPersistentSecretKeyUnavailable)
	_, err = DecryptStoredSecret("enc:v1:AA")
	require.ErrorIs(t, err, ErrPersistentSecretKeyUnavailable)
}

func TestStoredSecretEncryptionAuthenticatesAndHidesPlaintext(t *testing.T) {
	previousSecret, previousConfigured := CryptoSecret, PersistentCryptoSecretConfigured
	t.Cleanup(func() { CryptoSecret, PersistentCryptoSecretConfigured = previousSecret, previousConfigured })
	CryptoSecret = "stable-fixture-session-secret-with-entropy"
	PersistentCryptoSecretConfigured = true
	const plaintext = "private-audit-key"
	stored, err := EncryptStoredSecret(plaintext)
	require.NoError(t, err)
	require.NotContains(t, stored, plaintext)
	second, err := EncryptStoredSecret(plaintext)
	require.NoError(t, err)
	require.NotEqual(t, stored, second, "each encryption must use a fresh nonce")
	decoded, err := DecryptStoredSecret(stored)
	require.NoError(t, err)
	require.Equal(t, plaintext, decoded)
	CryptoSecret = "rotated-fixture-session-secret-with-entropy"
	_, err = DecryptStoredSecret(stored)
	require.True(t, errors.Is(err, ErrStoredSecretInvalid))
	CryptoSecret = "stable-fixture-session-secret-with-entropy"
	_, err = DecryptStoredSecret("plaintext")
	require.True(t, errors.Is(err, ErrStoredSecretInvalid))
}

func TestCredentialEndpointRequiresTLSOutsideLoopback(t *testing.T) {
	require.NoError(t, ValidateOutboundCredentialEndpoint("https://audit.example/v1"))
	require.NoError(t, ValidateOutboundCredentialEndpoint("http://127.0.0.1:8080/v1"))
	require.NoError(t, ValidateOutboundCredentialEndpoint("http://[::1]:8080/v1"))
	require.Error(t, ValidateOutboundCredentialEndpoint("http://audit.example/v1"))
	require.Error(t, ValidateOutboundCredentialEndpoint("https://user:pass@audit.example/v1"))
	require.Error(t, ValidateOutboundCredentialEndpoint("https://audit.example/v1?api_key=secret"))
}
